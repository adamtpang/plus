// `ask` against a pretend Surplus that misbehaves on purpose. Each test names
// one way a stream can go wrong and what the CLI must do about it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

const token = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, buyer_cost_micro: 3 } })}`;

// The model name in the request picks how the server behaves.
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/v1/models/")) {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pricing: { prompt: "0.000001", completion: "0.000002" } }));
  }
  let text = "";
  for await (const chunk of req) text += chunk;
  const { model } = JSON.parse(text);
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();

  if (model === "silent") return; // a 200, then nothing, and the line stays open
  res.write(token("Hello"));
  if (model === "stalls") return; // one piece of text, then nothing
  res.write(token(" world"));
  if (model === "cut") return res.end(); // hangs up with no finish and no [DONE]
  res.write(finish);
  if (model === "no-newline") return res.end(usage); // the last line has no line break
  res.end(`${usage}\n\ndata: [DONE]\n\n`);
});

const run = promisify(execFile);
let env;

test.before(async () => {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  env = { ...process.env, SURPLUS_API_KEY: "inf_test", SURPLUS_BASE_URL: `http://127.0.0.1:${server.address().port}` };
});
test.after(() => {
  server.close();
  server.closeAllConnections();
});

// The 10 second limit turns "hangs forever" into a failed test.
const ask = (model, ...flags) =>
  run(process.execPath, ["cli/plus.mjs", "ask", "hi", "-m", model, ...flags], { env, timeout: 10_000 });

test("a healthy stream prints the answer and a receipt", async () => {
  const { stdout } = await ask("ok");
  assert.match(stdout, /Hello world/);
  assert.match(stdout, /7 tokens/);
  assert.match(stdout, /cost \$0\.0000030/);
});

test("a 200 followed by silence gives up after the wait, instead of hanging", async () => {
  const failure = await ask("silent", "--wait", "1").catch((err) => err);
  assert.equal(failure.killed, false, "the CLI stopped by itself, the test did not have to kill it");
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /no data for 1 s/);
});

test("silence in the middle of an answer also gives up, and keeps what arrived", async () => {
  const failure = await ask("stalls", "--wait", "1").catch((err) => err);
  assert.equal(failure.killed, false);
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /Hello/);
  assert.match(failure.stderr, /no data for 1 s/);
});

test("a stream that ends with no finish is reported as cut off", async () => {
  const failure = await ask("cut").catch((err) => err);
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /Hello world/);
  assert.match(failure.stderr, /cut off/);
});

test("a last line with no line break is still read", async () => {
  const { stdout } = await ask("no-newline");
  assert.match(stdout, /7 tokens/);
});
