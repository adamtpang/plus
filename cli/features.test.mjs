// The Ori-style features: named launchers, the seller on the receipt, piped
// input, --version, doctor, --json and compare. All against a pretend Surplus.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { launcher } from "./plus.mjs";

const KEY = "inf_" + "cd34".repeat(8);
const seen = [];

const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : null;
  const url = new URL(req.url, "http://x");
  seen.push({ path: url.pathname, body });
  const json = (status, value, headers = {}) =>
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));

  if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: "invalid_api_key" });
  if (url.pathname === "/v1/payments/balance") return json(200, { credit_balance_usdc: "5000000", fiat_available_usdc: "5000000" });
  if (url.pathname === "/v1/buyer/savings") return json(200, { summary: { request_count: 3, total_saved_usdc: "900000" }, by_model: [] });
  if (url.pathname.startsWith("/v1/models/")) return json(200, { pricing: { prompt: "0.000001", completion: "0.00001" } });
  if (url.pathname === "/v1/requests") return json(200, { items: [{ request_id: "req_1", provider: "acme-seller" }] });
  if (url.pathname === "/v1/chat/completions") {
    const usage = { prompt_tokens: 5, completion_tokens: 7, buyer_cost_micro: body.model === "cheap" ? 2 : 20 };
    if (!body.stream) {
      return json(200, { model: body.model, choices: [{ message: { content: `Answer from ${body.model}` } }], usage }, { "x-request-id": "req_1" });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_1" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    return res.end(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
  }
  json(404, { error: "not found" });
});

const run = promisify(execFile);
let env;

test.before(async () => {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  env = { ...process.env, SURPLUS_API_KEY: KEY, SURPLUS_BASE_URL: `http://127.0.0.1:${server.address().port}` };
});
test.after(() => {
  server.close();
  server.closeAllConnections();
});

// Runs the CLI. `input` is sent on its standard input, as a pipe would.
function cli(args, { input = "", extraEnv = {} } = {}) {
  const promise = run(process.execPath, ["cli/plus.mjs", ...args], { env: { ...env, ...extraEnv }, timeout: 10_000 });
  promise.child.stdin.end(input);
  return promise;
}

test("launcher: claude gets the Anthropic settings", () => {
  const l = launcher("claude", KEY, "https://s.test");
  assert.equal(l.program, "claude");
  assert.equal(l.env.ANTHROPIC_BASE_URL, "https://s.test/anthropic");
  assert.equal(l.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.deepEqual(l.args, []);
});

test("launcher: codex is pointed at Surplus by its own config flags, not by a login", () => {
  const l = launcher("codex", KEY, "https://s.test");
  assert.equal(l.program, "codex");
  assert.ok(l.args.includes("model_provider=surplus"));
  assert.ok(l.args.includes("model_providers.surplus.base_url=https://s.test/v1"));
  assert.ok(l.args.includes("model_providers.surplus.env_key=SURPLUS_API_KEY"));
  assert.equal(l.env.SURPLUS_API_KEY, KEY);
});

test("launcher: aider gets the OpenAI settings", () => {
  const l = launcher("aider", KEY, "https://s.test");
  assert.equal(l.env.OPENAI_API_BASE, "https://s.test/v1");
  assert.equal(l.env.OPENAI_API_KEY, KEY);
});

test("launcher: opencode gets a provider entry listing the models", () => {
  const l = launcher("opencode", KEY, "https://s.test", ["gpt-4o-mini", "claude-sonnet-4.5"]);
  const config = JSON.parse(l.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.provider.surplus.options.baseURL, "https://s.test/v1");
  assert.deepEqual(Object.keys(config.provider.surplus.models), ["gpt-4o-mini", "claude-sonnet-4.5"]);
});

test("launcher: an unknown tool has no launcher", () => {
  assert.equal(launcher("notepad", KEY, "https://s.test"), null);
});

test("--version prints the version in package.json", async () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const { stdout } = await cli(["--version"]);
  assert.equal(stdout.trim(), version);
});

test("the receipt names the seller that served the answer", async () => {
  const { stdout } = await cli(["ask", "hi"]);
  assert.match(stdout, /Hello/);
  assert.match(stdout, /via acme-seller/);
});

test("ask --stdin adds piped text to the question", async () => {
  await cli(["ask", "Summarise this:", "--stdin"], { input: "the piped notes" });
  const sent = seen.findLast((r) => r.path === "/v1/chat/completions").body.messages[0].content;
  assert.match(sent, /Summarise this:/);
  assert.match(sent, /the piped notes/);
});

test("doctor passes when the key works", async () => {
  const { stdout } = await cli(["doctor"]);
  assert.match(stdout, /Node/);
  assert.match(stdout, /API key .*works/);
  assert.match(stdout, /Credit .*\$5\.00/);
});

test("doctor fails, and says why, when the key is refused", async () => {
  const failure = await cli(["doctor"], { extraEnv: { SURPLUS_API_KEY: "inf_wrong" } }).catch((err) => err);
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /API key .*refused/);
});

test("balance --json prints data a script can read", async () => {
  const { stdout } = await cli(["balance", "--json"]);
  const data = JSON.parse(stdout);
  assert.equal(data.credit_usd, 5);
  assert.equal(data.saved_usd, 0.9);
});

test("compare asks every model and shows cost side by side", async () => {
  const { stdout } = await cli(["compare", "hi", "-m", "cheap,dear"]);
  assert.match(stdout, /cheap/);
  assert.match(stdout, /dear/);
  assert.match(stdout, /\$0\.0000020/);
  assert.match(stdout, /\$0\.000020/);
  assert.match(stdout, /Answer from cheap/);
  assert.match(stdout, /Answer from dear/);
});
