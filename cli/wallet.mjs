// A tiny Ethereum wallet: just enough to sign Surplus's sign-in message.
//
// Surplus has no email sign-up over its API. An account IS a wallet: you
// prove you hold a wallet's private key by signing a message with it, and
// Surplus hands back an API key. So "sign up from the terminal" means: make
// a new private key, sign, done.
//
// Three ideas live in this file:
//   1. keccak256, the hash Ethereum uses (Node has SHA-3 built in, but
//      Ethereum uses the slightly different pre-standard version).
//   2. secp256k1, the curve Ethereum keys live on. A private key is a big
//      number d; the public key is the point d * G.
//   3. ECDSA, the signature: two numbers (r, s) plus a small hint (v) that
//      lets anyone work the signer's address back out of the signature.
//
// Written from scratch so the CLI keeps zero dependencies. It is checked
// against published test values in wallet.test.mjs. It makes no attempt to
// run in constant time, which is fine for signing one login on your own
// machine and wrong for a server that signs for strangers.

import { createHmac, randomBytes } from "node:crypto";

// ---- keccak256 ----

const MASK = (1n << 64n) - 1n;
const ROUND = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const ROTATE = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (v, n) => ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;

// The state is 25 numbers of 64 bits each, scrambled 24 times.
function scramble(a) {
  for (const constant of ROUND) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let i = 0; i < 25; i++) a[i] ^= c[(i + 4) % 5] ^ rotl(c[(i + 1) % 5], 1);
    const b = new Array(25);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROTATE[x + 5 * y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
    a[0] ^= constant;
  }
}

export function keccak256(input) {
  const data = Buffer.from(input);
  const RATE = 136; // bytes taken in per scramble
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / RATE) * RATE);
  data.copy(padded);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) state[i] ^= padded.readBigUInt64LE(offset + i * 8);
    scramble(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
  return out;
}

// ---- secp256k1 ----

const P = 2n ** 256n - 2n ** 32n - 977n; // the field: all arithmetic is modulo P
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // how many points there are
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];

const mod = (v, m) => ((v % m) + m) % m;

function power(base, exp, m) {
  let result = 1n;
  for (base = mod(base, m); exp > 0n; exp >>= 1n, base = (base * base) % m) if (exp & 1n) result = (result * base) % m;
  return result;
}
// Division modulo a prime: multiply by the inverse (Fermat's little theorem).
const inverse = (v, m) => power(v, m - 2n, m);

// Adding two points on the curve. null stands for "no point" (zero).
function add(a, b) {
  if (!a) return b;
  if (!b) return a;
  const [x1, y1] = a;
  const [x2, y2] = b;
  if (x1 === x2 && mod(y1 + y2, P) === 0n) return null;
  const slope =
    x1 === x2 ? mod(3n * x1 * x1 * inverse(2n * y1, P), P) : mod((y2 - y1) * inverse(x2 - x1, P), P);
  const x3 = mod(slope * slope - x1 - x2, P);
  return [x3, mod(slope * (x1 - x3) - y1, P)];
}

// k * point, by doubling and adding.
function multiply(k, point) {
  let result = null;
  for (; k > 0n; k >>= 1n, point = add(point, point)) if (k & 1n) result = add(result, point);
  return result;
}

const toBytes = (v) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
const toNumber = (bytes) => BigInt("0x" + Buffer.from(bytes).toString("hex"));

// ---- addresses ----

// An address is the last 20 bytes of the hash of the public key. Mixed
// capital letters are a built-in typo check (EIP-55).
function addressOf(point) {
  const hex = keccak256(Buffer.concat([toBytes(point[0]), toBytes(point[1])])).subarray(12).toString("hex");
  const check = keccak256(hex).toString("hex");
  return "0x" + [...hex].map((ch, i) => (parseInt(check[i], 16) >= 8 ? ch.toUpperCase() : ch)).join("");
}

export const addressFromPrivateKey = (privateKey) => addressOf(multiply(toNumber(strip(privateKey)), G));

const strip = (hex) => Buffer.from(hex.replace(/^0x/, ""), "hex");

export function newPrivateKey() {
  for (;;) {
    const key = randomBytes(32);
    const d = toNumber(key);
    if (d > 0n && d < N) return "0x" + key.toString("hex");
  }
}

// ---- signing ----

// Every signature needs a secret one-time number k. Reusing or leaking k
// gives away the private key, so instead of trusting a random source we
// derive k from the key and the message (RFC 6979).
function oneTimeNumber(d, digest) {
  const hmac = (key, ...parts) => createHmac("sha256", key).update(Buffer.concat(parts)).digest();
  const seed = Buffer.concat([toBytes(d), toBytes(mod(toNumber(digest), N))]);
  let v = Buffer.alloc(32, 1);
  let k = Buffer.alloc(32, 0);
  k = hmac(k, v, Buffer.from([0]), seed);
  v = hmac(k, v);
  k = hmac(k, v, Buffer.from([1]), seed);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const candidate = toNumber(v);
    if (candidate > 0n && candidate < N) return candidate;
    k = hmac(k, v, Buffer.from([0]));
    v = hmac(k, v);
  }
}

// Wallets never sign raw text. They sign the hash of the text with this
// prefix in front, so a signed login can never double as a signed payment.
const messageDigest = (message) =>
  keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(message)}`), Buffer.from(message)]));

// Sign a text message the way a wallet's "personal sign" does.
// Returns 0x + r (32 bytes) + s (32 bytes) + v (1 byte, 27 or 28).
export function signMessage(message, privateKey) {
  const d = toNumber(strip(privateKey));
  const digest = messageDigest(message);
  const z = toNumber(digest);
  const k = oneTimeNumber(d, digest);
  const point = multiply(k, G);
  const r = mod(point[0], N);
  let s = mod(inverse(k, N) * (z + r * d), N);
  let v = Number(point[1] & 1n);
  // Two values of s are valid; Ethereum only accepts the smaller one.
  if (s > N / 2n) {
    s = N - s;
    v ^= 1;
  }
  return "0x" + toBytes(r).toString("hex") + toBytes(s).toString("hex") + (27 + v).toString(16);
}

// Work the signer's address back out of a signature. This is what Surplus
// does on its side; here it lets the tests check our own signatures.
export function recoverAddress(message, signature) {
  const bytes = strip(signature);
  const r = toNumber(bytes.subarray(0, 32));
  const s = toNumber(bytes.subarray(32, 64));
  const z = toNumber(messageDigest(message));
  // Rebuild the point R from its x; v says which of the two possible y it had.
  let y = power(r ** 3n + 7n, (P + 1n) / 4n, P);
  if (Number(y & 1n) !== bytes[64] - 27) y = P - y;
  const rInverse = inverse(r, N);
  const publicKey = add(multiply(mod(s * rInverse, N), [r, y]), multiply(mod(-z * rInverse, N), G));
  return addressOf(publicKey);
}
