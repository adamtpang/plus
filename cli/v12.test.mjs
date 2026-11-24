// v1.2: cheapest, then reliable. -m auto, retries, a spend cap, plus models,
// savings against OpenRouter's list price, and --print-env.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ARENA, AUTO_MODEL } from "./plus.mjs";

const KEY = "inf_" + "9f9f".repeat(8);
const seen = [];
const tries = {}; // how many chat requests each model has had

const stream = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, buyer_cost_micro: 3 } })}\n\ndata: [DONE]\n\n`);
};

const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : null;
  const url = new URL(req.url, "http://x");
  seen.push({ path: url.pathname, body });
  const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

  // OpenRouter's public price list, played by the same server.
  if (url.pathname === "/openrouter-models") {
    return json(200, { data: [{ id: "openai/gpt-4o-mini", pricing: { prompt: "0.00000015", completion: "0.0000006" } }] });
  }
  if (url.pathname === "/v1/requests") return json(200, { items: [] });
  if (url.pathname.startsWith("/v1/models/")) return json(200, { pricing: { prompt: "0.000001", completion: "0.000002" } });
  if (url.pathname.startsWith("/api/markets/")) {
    return json(200, { offers: [{ available: true, healthy: true, price_input_per_1m: 1037, price_output_per_1m: 4150 }] });
  }
  if (url.pathname === "/v1/buyer/savings") {
    return json(200, {
      summary: {},
      by_model: [
        { model: "gpt-4o-mini", requests: 4, spent: 100, direct_spent: 900, saved: 800, discount: 89, input_tokens: 2000, output_tokens: 1000 },
        { model: "some-rare-model", requests: 1, spent: 10, direct_spent: 20, saved: 10, discount: 50, input_tokens: 100, output_tokens: 100 },
      ],
    });
  }
  if (url.pathname === "/v1/chat/completions") {
    const n = (tries[body.model] = (tries[body.model] ?? 0) + 1);
    if (body.model === "down") return json(503, { error: "no seller" });
    if (body.model === "flaky" && n === 1) return json(503, { error: "seller failed" });
    if (body.model === "flaky-drop" && n === 1) return req.socket.destroy(); // dies before any answer
    return stream(res);
  }
  json(404, {});
});

const run = promisify(execFile);
let base;
const newHome = () => mkdtempSync(join(tmpdir(), "plus-v12-"));
test.before(async () => {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  server.closeAllConnections();
});

function cli(args, extra = {}, home = newHome()) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, SURPLUS_API_KEY: KEY, SURPLUS_BASE_URL: base, OPENROUTER_MODELS_URL: `${base}/openrouter-models`, PLUS_SPEND_CAP: "", ...extra };
  return run(process.execPath, ["cli/plus.mjs", ...args], { env, timeout: 20_000 }).then(
    (ok) => ({ ...ok, code: 0 }),
    (err) => err,
  );
}
const chats = (model) => seen.filter((r) => r.path === "/v1/chat/completions" && r.body.model === model).length;

test("-m auto sends the documented open-weight model and says so on the receipt", async () => {
  const r = await cli(["ask", "hi", "-m", "auto"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(chats(AUTO_MODEL), 1);
  assert.ok(r.stdout.includes(`auto -> ${AUTO_MODEL}`));
});

test("a 503 is retried, and the receipt mentions the retry", async () => {
  const r = await cli(["ask", "hi", "-m", "flaky"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.match(/Hello/g).length, 1, "one answer, not two");
  assert.match(r.stdout, /retried 1 time/);
});

test("a connection that dies before any answer is retried too", async () => {
  const r = await cli(["ask", "hi", "-m", "flaky-drop"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /retried 1 time/);
});

test("after two retries it gives up with a clear message", async () => {
  const r = await cli(["ask", "hi", "-m", "down"]);
  assert.equal(r.code, 1);
  assert.equal(chats("down"), 3);
  assert.match(r.stderr, /failed 3 times/);
});

test("a spend cap of 0 blocks ask before any paid request", async () => {
  const r = await cli(["ask", "hi", "-m", "capped-zero"], { PLUS_SPEND_CAP: "0" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /spend cap/);
  assert.equal(chats("capped-zero"), 0);
});

test("spend adds up across calls until the cap stops it", async () => {
  const home = newHome();
  const cap = { PLUS_SPEND_CAP: "0.000005" }; // each answer costs $0.000003
  const first = await cli(["ask", "hi", "-m", "capped"], cap, home);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /spent today \$0\.0000030 of \$0\.0000050/);
  const second = await cli(["ask", "hi", "-m", "capped"], cap, home);
  assert.equal(second.code, 0, second.stderr);
  const third = await cli(["ask", "hi", "-m", "capped"], cap, home);
  assert.equal(third.code, 1);
  assert.match(third.stderr, /spend cap/);
  assert.equal(chats("capped"), 2);
});

test("plus models lists the frozen Arena set with a Surplus price", async () => {
  const r = await cli(["models"]);
  assert.equal(r.code, 0, r.stderr);
  for (const id of Object.keys(ARENA.models)) assert.ok(r.stdout.includes(id), `${id} missing`);
  assert.match(r.stdout, /\$0\.0010/); // 1037 micro-dollars per 1M input
  assert.ok(r.stdout.includes(ARENA.date));
  assert.doesNotMatch(r.stdout, /NaN|undefined/);
});

test("plus savings adds what OpenRouter would have listed, or says it does not know", async () => {
  const r = await cli(["savings"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OPENROUTER LIST/);
  // 2000 in x $0.00000015 + 1000 out x $0.0000006 = $0.0009
  assert.match(r.stdout, /gpt-4o-mini.*\$0\.00090/);
  assert.match(r.stdout, /some-rare-model.*unknown/);
  assert.doesNotMatch(r.stdout, /NaN|undefined/);
});

test("run --print-env names the variables and never shows the key", async () => {
  const r = await cli(["run", "--print-env"]);
  assert.equal(r.code, 0, r.stderr);
  for (const name of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) assert.ok(r.stdout.includes(name));
  assert.ok(!r.stdout.includes(KEY), "the key was printed");
  assert.match(r.stdout, /Cursor/);
  assert.match(r.stdout, /Kilo/);
});
