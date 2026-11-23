// plus bench: the same short prompts through several routers, measured the
// same way. Replayed from a fixture (no keys, no network) or run live
// against pretend routers on this machine.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { benchSummary, BENCH_PROMPTS } from "./plus.mjs";

const KEYS = { surplus: "inf_" + "ee11".repeat(8), openrouter: "sk-or-test-SECRETOR", ramp: "ramp-test-SECRETRAMP" };

// One pretend server plays all three routers, told apart by the path prefix.
// Each answers the prompt correctly, except Ramp, which gets the sum wrong.
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : {};
  const router = req.url.split("/")[1];
  // Ramp reports no cost in its replies; its price comes from its model list,
  // in the shape Ramp really uses: router.pricing, dollars per 1M tokens.
  if (req.url === "/ramp/v1/models") {
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ id: "gpt-4o-mini", router: { pricing: { input: "1", output: "2" } } }] }));
  }
  if (req.url.endsWith("/models/" + body.model) || req.url.includes("/models/")) return res.writeHead(404).end();
  if (req.headers.authorization !== `Bearer ${KEYS[router]}`) return res.writeHead(401).end("{}");

  const prompt = body.messages[0].content;
  const answer = BENCH_PROMPTS.find((p) => p.text === prompt).sample;
  const reply = router === "ramp" && prompt.includes("17") ? "400" : answer;
  const usage = { prompt_tokens: 20, completion_tokens: 10 };
  if (router === "surplus") usage.buyer_cost_micro = 4; // millionths of a dollar
  if (router === "openrouter") usage.cost = 0.00001; // dollars
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
});

const run = promisify(execFile);
let base;
const home = mkdtempSync(join(tmpdir(), "plus-bench-"));
const offline = { ...process.env, HOME: home, USERPROFILE: home, SURPLUS_API_KEY: "", OPENROUTER_API_KEY: "", RAMP_ROUTER_API_KEY: "", SURPLUS_BASE_URL: "http://127.0.0.1:9" };

test.before(async () => {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const cli = (args, env) =>
  run(process.execPath, ["cli/plus.mjs", "bench", ...args], { env, timeout: 30_000 }).then(
    (ok) => ({ ...ok, code: 0 }),
    (err) => err,
  );

test("benchSummary: price, speed, errors and quality per router and model", () => {
  const { samples } = JSON.parse(readFileSync("cli/bench-fixture.json", "utf8"));
  const rows = benchSummary(samples);
  const surplus = rows.find((r) => r.router === "surplus");
  const openrouter = rows.find((r) => r.router === "openrouter");
  assert.equal(surplus.attempts, 3);
  assert.equal(surplus.errorRate, 1 / 3);
  assert.equal(surplus.quality, 1); // both answers it got were right
  assert.equal(surplus.ttftMs, 1000); // median of 900 and 1100
  assert.equal(openrouter.quality, 2 / 3);
  // OpenRouter's 5.5% credit fee is added to what it charged.
  assert.ok(Math.abs(openrouter.costUsd - (0.000009 + 0.0000075 + 0.000008) * 1.055) < 1e-12);
  // Tokens per second over the time after the first token: 10 / 0.5 s and 8 / 0.4 s.
  assert.equal(surplus.tokensPerSecond, 20);
  // A router that reports no cost has no price, not a price of zero.
  assert.equal(rows.find((r) => r.router === "ramp").costUsd, null);
});

test("--fixture works with no keys and no network", async () => {
  const r = await cli(["--fixture", "cli/bench-fixture.json"], offline);
  assert.equal(r.code, 0, r.stderr);
  for (const name of ["surplus", "openrouter", "ramp"]) assert.match(r.stdout, new RegExp(name));
  assert.match(r.stdout, /not measurements/);
});

test("--fixture --json prints the summary as data", async () => {
  const r = await cli(["--fixture", "cli/bench-fixture.json", "--json"], offline);
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 3);
});

test("with neither --fixture nor --live it explains instead of spending", async () => {
  const r = await cli([], offline);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--live/);
  assert.match(r.stderr, /--fixture/);
});

test("--live measures every router that has a key, and never prints a key", async () => {
  const env = {
    ...offline,
    SURPLUS_API_KEY: KEYS.surplus,
    SURPLUS_BASE_URL: `${base}/surplus`,
    OPENROUTER_API_KEY: KEYS.openrouter,
    OPENROUTER_BASE_URL: `${base}/openrouter/v1`,
    RAMP_ROUTER_API_KEY: KEYS.ramp,
    RAMP_ROUTER_BASE_URL: `${base}/ramp/v1`,
  };
  const saved = join(home, "run.json");
  const r = await cli(["--live", "-m", "gpt-4o-mini", "--save", saved, "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  const by = (name) => rows.find((x) => x.router === name);
  assert.equal(by("surplus").errorRate, 0);
  assert.ok(Math.abs(by("surplus").costUsd - 4e-6 * BENCH_PROMPTS.length) < 1e-12);
  assert.ok(Math.abs(by("openrouter").costUsd - 0.00001 * 1.055 * BENCH_PROMPTS.length) < 1e-12);
  assert.equal(by("ramp").quality, (BENCH_PROMPTS.length - 1) / BENCH_PROMPTS.length);
  // Ramp's cost is priced from its catalog: 20 in x $0.000001 + 10 out x $0.000002 per request.
  assert.ok(Math.abs(by("ramp").costUsd - 0.00004 * BENCH_PROMPTS.length) < 1e-12);
  assert.equal(by("ramp").costSource, "catalog");
  assert.equal(by("surplus").costSource, "reported");
  for (const key of Object.values(KEYS)) {
    assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), "a key was printed");
    assert.ok(!readFileSync(saved, "utf8").includes(key), "a key was saved");
  }
  // The saved run can be replayed as a fixture.
  const replay = await cli(["--fixture", saved, "--json"], offline);
  assert.equal(replay.code, 0, replay.stderr);
});

test("--live says why a router failed", async () => {
  const env = { ...offline, SURPLUS_API_KEY: "inf_refused", SURPLUS_BASE_URL: `${base}/surplus` };
  const r = await cli(["--live", "-m", "gpt-4o-mini"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /surplus gpt-4o-mini: .*answered 401/);
});

test("--live skips a router with no key and says so", async () => {
  const env = { ...offline, SURPLUS_API_KEY: KEYS.surplus, SURPLUS_BASE_URL: `${base}/surplus` };
  const r = await cli(["--live", "-m", "gpt-4o-mini"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /openrouter.*no key/i);
  assert.match(r.stdout, /ramp.*no key/i);
});
