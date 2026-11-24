// The full bench from the spec: five kinds of prompt, three pretend routers
// with known prices, one timeout, one mid-stream drop, one wrong answer, and
// one router that does not list a model.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { BENCH_SET, percentile } from "./plus.mjs";

const KEYS = { a: "inf_" + "aa11".repeat(8), b: "sk-or-test-SECRETB", c: "ramp-test-SECRETC" };
const lastUser = (body) => body.messages.filter((m) => m.role === "user").pop().content;

const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : {};
  const [, router] = req.url.split("/"); // a = surplus, b = openrouter, c = ramp
  const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

  if (req.url.endsWith("/v1/models")) {
    const price = { prompt: "0.000001", completion: "0.000002" };
    if (router === "a") return json(200, { data: [{ id: "m1", pricing: price }, { id: "m2", pricing: price }] });
    if (router === "b") return json(200, { data: [{ id: "vendor/m1", pricing: price }] }); // no m2
    return json(200, { data: ["m1", "m2"].map((id) => ({ id, router: { pricing: { input: "1", output: "2" } } })) });
  }
  if (req.url.includes("/models/")) return json(404, {});
  if (req.headers.authorization !== `Bearer ${KEYS[router]}`) return json(401, {});

  const prompt = BENCH_SET.find((p) => lastUser(body) === lastUser(p));
  const model = body.model;
  const first = (type) => BENCH_SET.find((p) => p.type === type).id;

  if (router === "c" && model === "m2" && prompt.id === first("webdev")) return; // never answers: a timeout
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (value) => res.write(`data: ${JSON.stringify({ model: `served-${model}`, ...value })}\n\n`);

  if (router === "b" && prompt.id === first("coding")) {
    send({ choices: [{ delta: { content: "function" } }] });
    return setTimeout(() => res.socket.destroy(), 50); // dies mid-answer
  }
  if (prompt.sample.tool) {
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: prompt.sample.tool.name, arguments: "" } }] } }] });
    const args = JSON.stringify(prompt.sample.tool.arguments);
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }] });
    send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  } else {
    // Ramp's m1 gets one long-context answer wrong.
    const wrong = router === "c" && model === "m1" && prompt.id === first("long-context");
    send({ choices: [{ delta: { content: wrong ? "K000000" : prompt.sample.text } }] });
    send({ choices: [{ delta: {}, finish_reason: "stop" }] });
  }
  const usage = { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 40 } };
  if (router === "a") usage.buyer_cost_micro = 20; // $0.00002, against $0.0002 at list
  if (router === "b") usage.cost = 0.0002;
  send({ choices: [], usage });
  res.end("data: [DONE]\n\n");
});

const run = promisify(execFile);
const home = mkdtempSync(join(tmpdir(), "plus-benchfull-"));
let env;
test.before(async () => {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${server.address().port}`;
  env = {
    ...process.env, HOME: home, USERPROFILE: home, PLUS_SPEND_CAP: "",
    SURPLUS_API_KEY: KEYS.a, SURPLUS_BASE_URL: `${base}/a`,
    OPENROUTER_API_KEY: KEYS.b, OPENROUTER_BASE_URL: `${base}/b/v1`,
    RAMP_ROUTER_API_KEY: KEYS.c, RAMP_ROUTER_BASE_URL: `${base}/c/v1`,
  };
});
test.after(() => {
  server.close();
  server.closeAllConnections();
});
const cli = (args, extra = {}) =>
  run(process.execPath, ["cli/plus.mjs", "bench", ...args], { env: { ...env, ...extra }, timeout: 60_000, maxBuffer: 16e6 }).then(
    (ok) => ({ ...ok, code: 0 }),
    (err) => err,
  );

test("the built-in set has two or three prompts of each kind in the spec", () => {
  for (const type of ["coding", "tool-use", "webdev", "long-context", "repair"]) {
    const n = BENCH_SET.filter((p) => p.type === type).length;
    assert.ok(n >= 2 && n <= 3, `${type}: ${n}`);
  }
});

test("every prompt's own sample answer passes its check, and a wrong one fails", () => {
  for (const p of BENCH_SET) {
    assert.equal(p.check(p.sample.text ?? "", p.sample.tool ? [{ name: p.sample.tool.name, arguments: JSON.stringify(p.sample.tool.arguments) }] : []), true, p.id);
    assert.equal(p.check("I am not sure.", []), false, p.id);
  }
});

test("percentile uses the nearest rank", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([], 50), null);
});

let rows, lines, stdout;
test("a full live run reports prices, failures, skips and quality", async () => {
  const out = join(home, "run.jsonl");
  const r = await cli(["--live", "-m", "m1,m2", "--wait", "2", "--out", out, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  ({ rows } = JSON.parse(r.stdout));
  lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const row = (router, model) => rows.find((x) => x.router === router && x.model === model);

  // Price: 10 requests x $0.00002 realized, against $0.0002 each at list.
  const s = row("surplus", "m1");
  assert.equal(s.attempts, BENCH_SET.length);
  assert.equal(s.failures, 0);
  assert.ok(Math.abs(s.costUsd - 0.00002 * BENCH_SET.length) < 1e-12);
  assert.equal(s.vsListPct, -90);
  assert.equal(s.cacheSharePct, 40);
  assert.equal(s.quality, 1);
  assert.ok(s.ttftP50Ms > 0 && s.ttftP95Ms >= s.ttftP50Ms);

  // The drop and the timeout are failures, each named.
  const o = row("openrouter", "m1");
  assert.equal(o.failures, 1);
  assert.deepEqual(o.failureKinds, { dropped: 1 });
  assert.deepEqual(row("ramp", "m2").failureKinds, { timeout: 1 });

  // The wrong answer is a quality miss, not a failure.
  const c = row("ramp", "m1");
  assert.equal(c.failures, 0);
  assert.deepEqual(c.byType["long-context"], { pass: 1, of: 2 });
  assert.deepEqual(c.byType["tool-use"], { pass: 2, of: 2 });

  // A router that does not list a model skips it, and says so.
  assert.equal(row("openrouter", "m2"), undefined);
  const skip = lines.find((l) => l.skipped);
  assert.equal(skip.router, "openrouter");
  assert.equal(skip.model, "m2");
  assert.match(skip.skipped, /not listed/);
});

test("the JSONL has one line per request, with the model each router served", () => {
  const requests = lines.filter((l) => !l.skipped);
  assert.equal(requests.length, BENCH_SET.length * 5); // 3 routers x 2 models, minus the skipped pair
  for (const l of requests) for (const field of ["router", "model", "prompt", "type", "ok"]) assert.ok(field in l, field);
  assert.equal(requests.find((l) => l.router === "surplus" && l.ok).servedModel, "served-m1");
  assert.equal(requests.find((l) => l.router === "openrouter" && l.ok).requestedAs, "vendor/m1");
  for (const key of Object.values(KEYS)) assert.ok(!JSON.stringify(lines).includes(key), "a key was saved");
});

test("the tables show p50 and p95, failures, and quality by kind", async () => {
  const r = await cli(["--fixture", join(home, "run.jsonl"), "--out", join(home, "again.jsonl")]);
  assert.equal(r.code, 0, r.stderr);
  stdout = r.stdout;
  for (const word of ["P50", "P95", "FAILED", "VS LIST", "CODING", "TOOL-USE", "WEBDEV", "LONG-CONTEXT", "REPAIR"]) assert.ok(stdout.includes(word), word);
  assert.match(stdout, /openrouter m2: skipped/);
  assert.match(stdout, /ramp m2: 1 failed \(timeout/);
  assert.doesNotMatch(stdout, /NaN|undefined/);
  assert.equal(readFileSync(join(home, "again.jsonl"), "utf8").trim().split("\n").length, lines.length);
});

test("bench --help explains the flags", async () => {
  const r = await cli(["--help"]);
  assert.equal(r.code, 0);
  for (const flag of ["--live", "--fixture", "--out", "--prompts", "--runs", "--quick", "--wait"]) assert.ok(r.stdout.includes(flag), flag);
});

test("--prompts runs your own JSONL of prompts, checked by a pattern", async () => {
  const file = join(home, "mine.jsonl");
  const mine = BENCH_SET.find((p) => p.type === "long-context");
  writeFileSync(file, JSON.stringify({ id: "mine", type: "custom", text: lastUser(mine), expect: mine.sample.text }) + "\n");
  const r = await cli(["--live", "-m", "m1", "--prompts", file, "--json"], { OPENROUTER_API_KEY: "", RAMP_ROUTER_API_KEY: "" });
  assert.equal(r.code, 0, r.stderr);
  const [only] = JSON.parse(r.stdout).rows;
  assert.equal(only.attempts, 1);
  assert.equal(only.quality, 1);
});

test("a live run with no keys at all says so and exits 1", async () => {
  const r = await cli(["--live"], { SURPLUS_API_KEY: "", OPENROUTER_API_KEY: "", RAMP_ROUTER_API_KEY: "" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No router has a key/);
});
