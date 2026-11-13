import assert from "node:assert/strict";
import { test } from "node:test";
import { addressFromPrivateKey, keccak256, newPrivateKey, recoverAddress, signMessage } from "./wallet.mjs";

// Published values: the keccak256 of nothing, and the sample account from
// the web3.js documentation.
const KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const ADDRESS = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";

test("keccak256 matches the published values", () => {
  assert.equal(keccak256("").toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256("abc").toString("hex"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // Longer than one 136-byte block.
  assert.equal(keccak256("a".repeat(200)).length, 32);
});

test("a private key gives the known address", () => {
  assert.equal(addressFromPrivateKey(KEY), ADDRESS);
});

test("signMessage matches the web3.js sample signature", () => {
  assert.equal(
    signMessage("Some data", KEY),
    "0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c",
  );
});

test("a signature recovers to the signer, for fresh keys too", () => {
  assert.equal(recoverAddress("Some data", signMessage("Some data", KEY)), ADDRESS);
  for (let i = 0; i < 3; i++) {
    const key = newPrivateKey();
    const message = `sign in ${i}\nNonce: abc`;
    assert.equal(recoverAddress(message, signMessage(message, key)), addressFromPrivateKey(key));
  }
});
