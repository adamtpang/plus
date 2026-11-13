import { test } from "node:test";
import assert from "node:assert/strict";
import { dollars, listPrice, parseEvent, savedPct, surplusEnv, table, usd } from "./plus.mjs";

test("dollars reads Surplus micro-dollar values, strings included", () => {
  assert.equal(dollars("994070"), 0.99407);
  assert.equal(dollars(25), 0.000025);
  assert.equal(dollars(undefined), 0);
});

test("usd keeps tiny amounts readable", () => {
  assert.equal(usd(0), "$0");
  assert.equal(usd(12.5), "$12.50");
  assert.equal(usd(0.0234), "$0.0234");
  assert.equal(usd(0.000025), "$0.000025");
});

test("listPrice prices prompt and completion tokens separately", () => {
  const pricing = { prompt: "0.00000015", completion: "0.0000006" };
  const usage = { prompt_tokens: 20, completion_tokens: 700 };
  assert.ok(Math.abs(listPrice(pricing, usage) - 0.000423) < 1e-12);
  assert.equal(listPrice(null, usage), null);
});

test("savedPct compares what was paid with the list price", () => {
  assert.equal(savedPct(0.000025, 0.000423), 94);
  assert.equal(savedPct(1, 0), null);
});

test("parseEvent handles data lines, the end marker and keep-alives", () => {
  assert.deepEqual(parseEvent('data: {"a":1}'), { a: 1 });
  assert.equal(parseEvent("data: [DONE]"), "done");
  assert.equal(parseEvent(": keep-alive"), null);
  assert.equal(parseEvent(""), null);
});

test("table lines the columns up", () => {
  assert.equal(table([["A", "BB"], ["ccc", "d"]]), "A    BB\nccc  d");
});

test("surplusEnv points both families of tools at Surplus", () => {
  const env = surplusEnv("inf_x", "https://example.test");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://example.test/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "inf_x");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.OPENAI_BASE_URL, "https://example.test/v1");
  assert.equal(env.OPENAI_API_KEY, "inf_x");
});
