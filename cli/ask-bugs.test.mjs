// Four ways `plus ask` used to misbehave, each against a pretend Surplus that
// does exactly that one thing. The model name picks the behaviour.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const token = (text) => event({ choices: [{ delta: { content: text } }] });
const finish = event({ choices: [{ delta: {}, finish_reason: "stop" }] });
const usage = event({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, buyer_cost_micro: 3 } });

const timers = new Set();
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/v1/models/")) {
    if (req.url.includes("slow-price")) return; // never answers
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pricing: { prompt: "0.000001", completion: "0.000002" } }));
  }
  if (req.url.startsWith("/v1/requests")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: [] }));
  let text = "";
  for await (const chunk of req) text += chunk;
  const { model } = JSON.parse(text);
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();

  if (model === "keepalive") {
    // Only comments, forever: bytes keep arriving, but no answer ever does.
    const t = setInterval(() => res.write(": keep-alive\n\n"), 200);
    timers.add(t);
    return;
  }
  if (model === "linger-done") {
    res.write(token("Hello") + finish + usage + "data: [DONE]\n\n"); // finished, but the line stays open
    return;
  }
  if (model === "linger-finish") {
    res.write(token("Hello") + finish + usage); // finished with no [DONE], line stays open
    return;
  }
  if (model === "drop") {
    res.write(token("Hello"));
    setTimeout(() => res.socket.destroy(), 100); // the connection dies mid-answer
    return;
  }
  // "slow-price": a normal, complete answer. Its price lookup never answers.
  res.end(token("Hello") + finish + usage + "data: [DONE]\n\n");
});

const run = promisify(execFile);
let env;

test.before(async () => {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  env = { ...process.env, SURPLUS_API_KEY: "inf_test", SURPLUS_BASE_URL: `http://127.0.0.1:${server.address().port}` };
});
test.after(() => {
  for (const t of timers) clearInterval(t);
  server.close();
  server.closeAllConnections();
});

// The 15 second limit turns "hangs" into a failed test instead of a stuck run.
async function ask(model, ...flags) {
  const started = performance.now();
  const result = await run(process.execPath, ["cli/plus.mjs", "ask", "hi", "-m", model, ...flags], { env, timeout: 15_000 }).then(
    (ok) => ({ ...ok, code: 0 }),
    (err) => err,
  );
  return { ...result, seconds: (performance.now() - started) / 1000 };
}

test("bug 1: a stream of only keep-alive comments still gives up after --wait", async () => {
  const r = await ask("keepalive", "--wait", "1");
  assert.equal(r.killed, false, "the CLI stopped by itself");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /for 1 s/);
  assert.ok(r.seconds < 5, `took ${r.seconds.toFixed(1)} s`);
});

test("bug 2: [DONE] on a connection left open still prints the receipt and exits 0", async () => {
  const r = await ask("linger-done", "--wait", "30");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Hello/);
  assert.match(r.stdout, /7 tokens/);
  assert.ok(r.seconds < 8, `took ${r.seconds.toFixed(1)} s`);
});

test("bug 2: a finish reason with no [DONE], connection left open, also completes", async () => {
  const r = await ask("linger-finish", "--wait", "30");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /7 tokens/);
  assert.ok(r.seconds < 8, `took ${r.seconds.toFixed(1)} s`);
});

test("bug 3: a connection dropped mid-answer ends the text with a newline and says so", async () => {
  const r = await ask("drop");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Hello\n$/);
  assert.match(r.stderr, /dropped|cut off/);
  assert.doesNotMatch(r.stdout, /terminated/);
});

test("bug 4: a hung price lookup does not hang the command after a good answer", async () => {
  const r = await ask("slow-price");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /7 tokens/);
  assert.ok(r.seconds < 8, `took ${r.seconds.toFixed(1)} s`);
});
