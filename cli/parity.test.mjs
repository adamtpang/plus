// Ori-style launcher behaviour: --model, a key check before the tool
// starts, a clear message for a tool that is not installed, and update.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { launcher, splitModelFlag } from "./plus.mjs";

const KEY = "inf_" + "ab12".repeat(8);

test("splitModelFlag takes --model or -m only when it comes first", () => {
  assert.deepEqual(splitModelFlag(["--model", "glm-5.3", "-p", "hi"]), { model: "glm-5.3", rest: ["-p", "hi"] });
  assert.deepEqual(splitModelFlag(["-m", "glm-5.3"]), { model: "glm-5.3", rest: [] });
  // Later on, it belongs to the tool, so it is left alone.
  assert.deepEqual(splitModelFlag(["-p", "hi", "--model", "x"]), { model: null, rest: ["-p", "hi", "--model", "x"] });
});

test("--model reaches each tool the way that tool expects", () => {
  const claude = launcher("claude", KEY, "https://s.test", [], "claude-sonnet-4.5");
  assert.equal(claude.env.ANTHROPIC_MODEL, "claude-sonnet-4.5");
  assert.equal(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-sonnet-4.5"); // background tasks too
  assert.deepEqual(launcher("codex", KEY, "https://s.test", [], "gpt-5-mini").args.slice(-2), ["-m", "gpt-5-mini"]);
  assert.deepEqual(launcher("opencode", KEY, "https://s.test", ["glm-5.3"], "glm-5.3").args, ["--model", "surplus/glm-5.3"]);
  assert.deepEqual(launcher("aider", KEY, "https://s.test", [], "glm-5.3").args, ["--model", "openai/glm-5.3"]);
  // No --model: nothing extra.
  assert.equal(launcher("claude", KEY, "https://s.test").env.ANTHROPIC_MODEL, undefined);
});

const server = createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${KEY}`;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify(ok ? { credit_balance_usdc: "1000000", data: [] } : { error: { code: "invalid_api_key" } }));
});
const run = promisify(execFile);
let env;
test.before(async () => {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  env = { ...process.env, SURPLUS_BASE_URL: `http://127.0.0.1:${server.address().port}` };
});
test.after(() => server.close());

const cli = (args, extra) =>
  run(process.execPath, ["cli/plus.mjs", ...args], { env: { ...env, ...extra }, timeout: 15_000 }).then(
    (ok) => ({ ...ok, code: 0 }),
    (err) => err,
  );

test("a refused key stops the launch before the tool starts", async () => {
  const r = await cli(["claude", "-p", "hi"], { SURPLUS_API_KEY: "inf_wrong" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refused your API key/);
  assert.match(r.stderr, /plus login/);
});

test("a tool that is not installed gets a clear message, not a crash", async () => {
  const r = await cli(["run", "surely-not-a-real-tool-42"], { SURPLUS_API_KEY: KEY });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /surely-not-a-real-tool-42.*not found/);
});

test("update --print shows the installer it would run, for this system", async () => {
  const r = await cli(["update", "--print"], { SURPLUS_API_KEY: KEY });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /raw\.githubusercontent\.com\/adamtpang\/plus\/main\/cli\/install\.(sh|ps1)/);
});
