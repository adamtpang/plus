// signup and topup, run for real against a pretend Surplus on this machine.
// No account is made and no money moves: the pretend server only checks
// that the CLI sends what Surplus's guide says it should.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { creditEstimate, findText } from "./plus.mjs";
import { recoverAddress } from "./wallet.mjs";

const KEY = "inf_" + "ab12".repeat(8);
const seen = [];

const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : null;
  const url = new URL(req.url, "http://x");
  seen.push({ path: url.pathname, body, headers: req.headers });
  const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));

  if (url.pathname === "/v1/buyer/auth/challenge") {
    const address = url.searchParams.get("address");
    return send(200, { message: `example.test wants you to sign in:\n${address}\n\nNonce: n0nce`, nonce: "n0nce" });
  }
  if (url.pathname === "/v1/buyer/auth/keys") {
    // What the real server does: work out who signed, compare to the message.
    const signer = recoverAddress(body.message, body.signature);
    if (!body.message.includes(signer)) return send(401, { error: "bad signature" });
    return send(200, { id: "key_1", api_key: KEY });
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "invalid_api_key" });
  if (url.pathname === "/v1/payments/balance") {
    return send(200, { credit_balance_usdc: "1000000", stripe_fee_bps: 290, stripe_fee_fixed_micro: "300000" });
  }
  if (url.pathname === "/v1/payments/topup") return send(200, { checkout: { url: "https://pay.example.test/session" } });
  send(404, { error: "not found" });
});

const run = promisify(execFile);
let home;
let env;

test.before(async () => {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  home = mkdtempSync(join(tmpdir(), "plus-test-"));
  // A scratch home folder, so the real saved key is never read or touched.
  env = { ...process.env, HOME: home, USERPROFILE: home, SURPLUS_API_KEY: "", SURPLUS_BASE_URL: `http://127.0.0.1:${server.address().port}` };
});
test.after(() => server.close());

const cli = (...args) => run(process.execPath, ["cli/plus.mjs", ...args], { env });

test("signup signs the challenge and saves the key and the wallet", async () => {
  const { stdout } = await cli("signup", "--yes");
  assert.match(stdout, /Account created/);
  assert.ok(!stdout.includes(KEY), "the key is never printed");

  const saved = JSON.parse(readFileSync(join(home, ".plus", "config.json"), "utf8"));
  assert.equal(saved.apiKey, KEY);
  assert.match(saved.wallet.address, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(!stdout.includes(saved.wallet.privateKey), "the private key is never printed");

  const mint = seen.find((r) => r.path === "/v1/buyer/auth/keys");
  assert.ok(mint.headers["idempotency-key"]);
  assert.equal(mint.headers.authorization, undefined);
});

test("signup refuses to replace a saved key unless told to", async () => {
  await assert.rejects(cli("signup", "--yes"), /already saved/);
});

test("topup asks Surplus for a payment link and prints it", async () => {
  const { stdout } = await cli("topup", "25", "--yes", "--no-open");
  assert.match(stdout, /https:\/\/pay\.example\.test\/session/);
  assert.match(stdout, /about \$23\.98/);

  const call = seen.find((r) => r.path === "/v1/payments/topup");
  assert.deepEqual(call.body, { amountUsd: 25, return_to: "dashboard" });
  assert.ok(call.headers["idempotency-key"]);
});

test("topup refuses amounts Surplus would reject", async () => {
  await assert.rejects(cli("topup", "5", "--yes", "--no-open"), /10 to 2000/);
  assert.equal(seen.filter((r) => r.path === "/v1/payments/topup").length, 1);
});

test("findText and creditEstimate", () => {
  assert.equal(findText({ a: 1, b: { c: "inf_x" } }, "inf_"), "inf_x");
  assert.equal(findText({ a: "nope" }, "inf_"), null);
  assert.equal(creditEstimate(50, { stripe_fee_bps: 290, stripe_fee_fixed_micro: "300000" }).toFixed(2), "48.25");
});
