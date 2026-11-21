#!/usr/bin/env node
// Surplus Intelligence from the terminal.
//
// Plain Node 18+, no dependencies. It talks straight to the Surplus API with
// your key, which comes from SURPLUS_API_KEY if set, otherwise from
// ~/.plus/config.json (written by `login` or `signup`).
//
// The command's name is whatever this file is installed as, so renaming the
// tool never means editing this file (see "bin" in package.json).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const NAME = basename(process.argv[1] ?? "plus").replace(/\.(mjs|js|cmd)$/, "");
const BASE = process.env.SURPLUS_BASE_URL ?? "https://api.surplusintelligence.ai";
const CONFIG_DIR = join(homedir(), ".plus");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// Where the tool kept its config before it was called plus. Still read, so
// an earlier login keeps working; new saves go to CONFIG_FILE.
const OLD_CONFIG_FILE = join(homedir(), ".surplusminus", "config.json");
const DEFAULT_MODEL = "gpt-4o-mini";
const VERSION = "0.2.0"; // kept equal to package.json by a test

// ---- small helpers, exported for the tests ----

// Surplus reports money in millionths of a dollar (micro-USD), sometimes as
// strings. "994070" -> 0.99407.
export const dollars = (micro) => Number(micro ?? 0) / 1e6;

// Show tiny amounts without rounding them to $0.00.
export function usd(amount) {
  if (amount === 0) return "$0";
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toPrecision(2)}`;
}

// What the same tokens would cost at list price, from /v1/models pricing
// (dollars per token, as strings).
export function listPrice(pricing, usage) {
  if (!pricing || !usage) return null;
  return (
    Number(pricing.prompt ?? 0) * (usage.prompt_tokens ?? 0) +
    Number(pricing.completion ?? 0) * (usage.completion_tokens ?? 0)
  );
}

export const savedPct = (paid, list) => (list > 0 ? Math.round((1 - paid / list) * 100) : null);

// One line of a server-sent event stream: returns the parsed JSON, "done",
// or null for anything else (blank lines, ": keep-alive" comments).
export function parseEvent(line) {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return "done";
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// Rows of cells -> lines of text with the columns lined up.
export function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

// The environment that points another tool at Surplus. Claude Code reads the
// ANTHROPIC_* names; most other tools read the OPENAI_* ones.
export function surplusEnv(key, base = BASE) {
  return {
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: "",
    OPENAI_BASE_URL: `${base}/v1`,
    OPENAI_API_BASE: `${base}/v1`,
    OPENAI_API_KEY: key,
  };
}

// How to start each known coding tool on Surplus: the program, any arguments
// to put in front of the user's own, and the environment to add. Returns
// null for a tool we have no recipe for (`run` still works for those).
// `models` is only needed by opencode, which must be told which models exist.
export function launcher(tool, key, base = BASE, models = []) {
  const env = surplusEnv(key, base);
  if (tool === "claude" || tool === "aider") return { program: tool, args: [], env };
  if (tool === "codex") {
    // Codex is told about Surplus through its own -c settings, so this works
    // whether or not you are signed in to Codex with another account.
    const settings = [
      "model_provider=surplus",
      "model_providers.surplus.name=Surplus",
      `model_providers.surplus.base_url=${base}/v1`,
      "model_providers.surplus.env_key=SURPLUS_API_KEY",
      "model_providers.surplus.wire_api=responses",
    ];
    return { program: "codex", args: settings.flatMap((s) => ["-c", s]), env: { ...env, SURPLUS_API_KEY: key } };
  }
  if (tool === "opencode") {
    const config = {
      provider: {
        surplus: {
          npm: "@ai-sdk/openai-compatible",
          name: "Surplus",
          options: { baseURL: `${base}/v1`, apiKey: key },
          models: Object.fromEntries(models.map((id) => [id, {}])),
        },
      },
    };
    return { program: "opencode", args: [], env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
  }
  return null;
}
const LAUNCHERS = ["claude", "codex", "aider", "opencode"];

// ---- key handling ----

function readConfig() {
  for (const file of [CONFIG_FILE, OLD_CONFIG_FILE]) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // missing or unreadable: try the next place
    }
  }
  return {};
}

function apiKey() {
  const key = process.env.SURPLUS_API_KEY || readConfig().apiKey;
  if (!key) fail(`No API key. Run: ${NAME} login`);
  return key;
}

// One call to Surplus. Pass key = null for the calls that need no account.
// Giving a body makes it a POST. Surplus requires an Idempotency-Key on
// writes that create things or move money: if the same request is sent
// twice by accident, the second one is recognised and not repeated.
// timeoutMs gives up on a call that never answers.
async function api(path, key = apiKey(), body, timeoutMs) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const post = body && {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify(body),
  };
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(BASE + path, { ...(post || { headers }), signal });
  if (!res.ok) fail(`${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Stop with a message. It throws rather than exiting on the spot, so open
// network connections get to close first (exiting mid-close crashes Node on
// Windows). The entry point at the bottom prints it.
function fail(message) {
  throw new Error(message);
}

// Merge new values into the saved config, keeping what is already there.
function saveConfig(values) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...values }, null, 2), { mode: 0o600 });
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} (y/n) `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

// The first text value in a reply that starts a certain way. Surplus's
// guide says a key and a checkout link come back, but not under which
// field names, so we look for them by shape.
export function findText(reply, start) {
  for (const value of Object.values(reply ?? {})) {
    if (typeof value === "string" && value.startsWith(start)) return value;
    if (value && typeof value === "object") {
      const inside = findText(value, start);
      if (inside) return inside;
    }
  }
  return null;
}

// What a card top-up will roughly add, after Stripe's fee. Only an estimate:
// Surplus credits the real fee, which is known once the charge lands.
export function creditEstimate(amountUsd, bal) {
  const fee = (amountUsd * (bal.stripe_fee_bps ?? 0)) / 10_000 + dollars(bal.stripe_fee_fixed_micro);
  return amountUsd - fee;
}

function openInBrowser(url) {
  const [program, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(program, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- commands ----

async function login(flags) {
  let key = flags.key || process.env.SURPLUS_API_KEY;
  if (!key) {
    console.log("Paste your Surplus API key (starts with inf_). Get one at https://www.surplusintelligence.ai");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    key = (await rl.question("key: ")).trim();
    rl.close();
  }
  if (!key.startsWith("inf_")) fail("That does not look like a Surplus key (they start with inf_).");

  // Check the key works before saving it.
  const bal = await api("/v1/payments/balance", key);
  saveConfig({ apiKey: key });
  console.log(`Saved to ${CONFIG_FILE}. Credit available: ${usd(dollars(bal.fiat_available_usdc))}`);
}

// Make a brand new Surplus account without a browser. On Surplus an account
// is a wallet, so: make a wallet, sign Surplus's sign-in message with it,
// and swap the signature for an API key. See wallet.mjs for the how.
async function signup(flags) {
  if (readConfig().apiKey && !flags.new) {
    fail(`A key is already saved in ${CONFIG_FILE}.\nTo make another, separate account anyway: ${NAME} signup --new`);
  }
  const wallet = await import("./wallet.mjs");
  const privateKey = wallet.newPrivateKey();
  const address = wallet.addressFromPrivateKey(privateKey);

  const challenge = await api(`/v1/buyer/auth/challenge?address=${address}`, null);
  console.log(`New wallet ${address}\n\nSurplus asks it to sign this:\n\n${challenge.message}\n`);
  if (!flags.yes && !(await confirm("Create a Surplus account with this wallet?"))) {
    return console.log("Stopped. Nothing was created.");
  }

  // Save the wallet before asking for the key, so it can never be lost
  // between the two steps. Keep any earlier wallet rather than erase it.
  const earlier = readConfig();
  saveConfig({
    wallet: { address, privateKey },
    ...(earlier.wallet && { earlierWallets: [...(earlier.earlierWallets ?? []), earlier.wallet] }),
  });
  const reply = await api("/v1/buyer/auth/keys", null, {
    message: challenge.message,
    signature: wallet.signMessage(challenge.message, privateKey),
    label: NAME,
  });
  const key = findText(reply, "inf_");
  if (!key) fail(`Surplus answered, but no key was found in: ${Object.keys(reply).join(", ")}`);
  saveConfig({ apiKey: key });

  console.log(`Account created. Key and wallet saved to ${CONFIG_FILE}`);
  console.log("Back that file up: the wallet in it is the only way back into this account.");
  console.log(`Next:  ${NAME} topup 10`);
}

// Add credit. With an amount: a card payment through Stripe, finished in
// your browser. With --usdc: where to send USDC instead.
async function topup(amount, flags) {
  if (flags.usdc) {
    const deposit = await api("/v1/payments/deposit-address");
    console.log(`Send USDC on Base (chain ${deposit.chain_id}) to:\n\n  ${deposit.address}\n`);
    console.log(`Only USDC, only on Base. Watch it arrive with: ${NAME} balance`);
    return;
  }
  const amountUsd = Number(amount);
  if (!(amountUsd >= 10 && amountUsd <= 2000)) {
    fail(`Usage: ${NAME} topup <dollars>   (10 to 2000), or ${NAME} topup --usdc`);
  }
  const bal = await api("/v1/payments/balance");

  console.log(`Balance now     ${usd(dollars(bal.credit_balance_usdc))}`);
  console.log(`Card charge     ${usd(amountUsd)}`);
  console.log(`Credit added    about ${usd(creditEstimate(amountUsd, bal))}, after Stripe's fee`);
  console.log("The exact fee is set when the card is charged. Card credit can be spent, not withdrawn.\n");
  if (!flags.yes && !(await confirm("Make the payment link?"))) return console.log("Stopped. Nothing was charged.");

  const reply = await api("/v1/payments/topup", apiKey(), { amountUsd, return_to: "dashboard" });
  const url = findText(reply, "https://");
  if (!url) fail(`Surplus answered, but no payment link was found in: ${Object.keys(reply).join(", ")}`);
  console.log(`\nPay here:\n\n  ${url}\n`);
  if (flags["no-open"]) return;

  // Nothing is charged until you pay on that page. The credit lands a few
  // seconds after Stripe tells Surplus, so we watch the balance for it.
  openInBrowser(url);
  console.log("Opened in your browser. Waiting for the credit to arrive (Ctrl+C to stop waiting)...");
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const now = await api("/v1/payments/balance");
    const added = dollars(now.credit_balance_usdc) - dollars(bal.credit_balance_usdc);
    if (added > 0) return console.log(`Credited ${usd(added)}. Balance now ${usd(dollars(now.credit_balance_usdc))}`);
  }
  console.log(`No credit yet after 10 minutes. Check later with: ${NAME} balance`);
}

async function balance(flags = {}) {
  const [bal, saved] = await Promise.all([
    api("/v1/payments/balance"),
    api("/v1/buyer/savings?period=all_time"),
  ]);
  const s = saved.summary ?? {};
  if (flags.json) {
    return console.log(
      JSON.stringify({
        credit_usd: dollars(bal.credit_balance_usdc),
        spent_usd: dollars(s.total_actual_usdc),
        list_usd: dollars(s.total_direct_usdc),
        saved_usd: dollars(s.total_saved_usdc),
        requests: s.request_count ?? 0,
      }),
    );
  }
  console.log(`Credit available  ${usd(dollars(bal.fiat_available_usdc))}`);
  if (Number(bal.usdc_available_usdc) > 0) console.log(`USDC available    ${usd(dollars(bal.usdc_available_usdc))}`);
  console.log(`Spent so far      ${usd(dollars(s.total_actual_usdc))} over ${s.request_count ?? 0} requests`);
  console.log(`At list price     ${usd(dollars(s.total_direct_usdc))}`);
  console.log(`Saved             ${usd(dollars(s.total_saved_usdc))} (${Math.round(s.savings_pct ?? 0)}%)`);
}

// What you saved, model by model.
async function savings(flags = {}) {
  const saved = await api("/v1/buyer/savings?period=all_time");
  if (flags.json) return console.log(JSON.stringify(saved.by_model ?? []));
  const rows = (saved.by_model ?? []).map((m) => [
    m.model,
    m.requests,
    usd(dollars(m.spent)),
    usd(dollars(m.direct_spent)),
    usd(dollars(m.saved)),
    `${Math.round(m.discount)}%`,
  ]);
  if (rows.length === 0) return console.log("No requests yet.");
  console.log(table([["MODEL", "REQUESTS", "PAID", "LIST", "SAVED", "OFF"], ...rows]));
}

// The cheapest sellers for one model right now, against its list price.
async function price(model, flags = {}) {
  if (!model) fail(`Usage: ${NAME} price <model>   (for example: ${NAME} price gpt-4o-mini)`);
  const market = await api(`/api/markets/${encodeURIComponent(model)}`);
  if (flags.json) return console.log(JSON.stringify(market));
  const live = (market.offers ?? []).filter((o) => o.available && o.healthy).slice(0, 5);
  if (live.length === 0) return console.log(`No seller is live for ${model} right now.`);

  // Prices are micro-dollars per million tokens.
  const perM = (micro) => `$${dollars(micro).toFixed(dollars(micro) < 1 ? 3 : 2)}`;
  const first = live[0];
  console.log(`${model}, dollars per 1M tokens (input / output)`);
  console.log(`List price   ${perM(first.direct_input_per_1m)} / ${perM(first.direct_output_per_1m)}\n`);
  const rows = live.map((o) => [
    o.provider ?? "?",
    `${perM(o.price_input_per_1m)} / ${perM(o.price_output_per_1m)}`,
    `${Math.round(o.discount_pct)}% off`,
  ]);
  console.log(table([["SELLER", "PRICE", ""], ...rows]));
  const d = market.depth ?? {};
  console.log(`\n${d.num_available ?? "?"} of ${d.num_offers ?? "?"} offers are live.`);
}

// Your most recent requests: what each cost and how long it waited.
async function logs(flags) {
  const limit = Math.min(Number(flags.limit ?? 10) || 10, 50);
  const { items = [] } = await api(`/v1/requests?limit=${limit}`);
  if (flags.json) return console.log(JSON.stringify(items));
  if (items.length === 0) return console.log("No requests yet.");
  const rows = items.map((r) => [
    r.created_at.slice(5, 16).replace("T", " "),
    r.model,
    r.status_code,
    r.output_tokens ?? "",
    usd(dollars(r.buyer_cost_micro)),
    usd(dollars(r.direct_cost_micro)),
    r.upstream_ttfb_ms != null ? `${(r.upstream_ttfb_ms / 1000).toFixed(1)} s` : "",
  ]);
  console.log(table([["WHEN (UTC)", "MODEL", "STATUS", "OUT", "PAID", "LIST", "FIRST BYTE"], ...rows]));
}

async function ask(prompt, flags) { // prompt may gain piped text below
  // --stdin adds whatever was piped in, so `cat notes.txt | plus ask "Summarise:" --stdin` works.
  // It is a flag, not automatic, because a program that starts us with an
  // open but silent pipe would otherwise leave us waiting on it forever.
  if (flags.stdin) {
    let piped = "";
    for await (const chunk of process.stdin) piped += chunk;
    prompt = [prompt, piped.trim()].filter(Boolean).join("\n\n");
  }
  if (!prompt) fail(`Usage: ${NAME} ask "your question" [-m model] [--stdin]`);
  const model = flags.model ?? DEFAULT_MODEL;
  let requestId = null;
  const started = performance.now();
  let firstToken = null;
  let usage = null;
  let finished = false; // the model said it was done, or [DONE] arrived

  // The watchdog. Waiting on a silent connection runs no code at all, so
  // nothing in the loop below can notice the silence. A timer can: it is
  // pushed back every time the model sends something, and if it ever fires it
  // aborts the request, which makes the waiting fetch or read throw.
  // Keep-alive comments do not push it back: they prove the line is open,
  // not that an answer is coming.
  const waitSeconds = Number(flags.wait ?? 90) || 90;
  const request = new AbortController();
  let watchdog;
  const arm = (ms = waitSeconds * 1000, reason = "silence") => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => request.abort(reason), ms);
  };
  let gotResponse = false;

  // Returns true once the answer is complete and reading can stop.
  const handle = (line) => {
    const event = parseEvent(line);
    if (!event) return false; // a blank line or a ": keep-alive" comment
    if (event === "done") return (finished = true);
    if (!finished) arm(); // once finished, the short grace timer below stays in charge
    if (event.error) fail(`error inside the stream: ${JSON.stringify(event.error).slice(0, 200)}`);
    const choice = event.choices?.[0];
    if (choice?.delta?.content) {
      firstToken ??= performance.now();
      process.stdout.write(choice.delta.content);
    }
    if (event.usage) usage = event.usage;
    if (choice?.finish_reason) {
      // Finished. The cost usually follows in one more event, so allow a
      // moment for it, then stop even if the server leaves the line open.
      finished = true;
      arm(Math.min(2000, waitSeconds * 1000), "finished");
    }
    return false;
  };

  try {
    arm();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        stream_options: { include_usage: true }, // cost arrives in the last event
      }),
    });
    if (!res.ok) fail(`chat answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    requestId = res.headers.get("x-request-id");
    gotResponse = true;

    // Read the stream line by line and print text as it arrives. A chunk can
    // end in the middle of a line, so the unfinished part waits in `buffer`.
    const decoder = new TextDecoder();
    let buffer = "";
    let complete = false;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (handle(line)) complete = true;
      if (complete) break; // [DONE]: stop now, even if the server keeps the line open
    }
    if (!complete) handle(buffer + decoder.decode()); // a last line with no line break after it
  } catch (err) {
    if (request.signal.reason !== "finished") {
      if (firstToken) console.log(); // end the partial answer's line first
      if (request.signal.reason === "silence") {
        fail(`no data for ${waitSeconds} s, so the request was dropped. Wait longer with --wait <seconds>.`);
      }
      if (gotResponse) fail("the connection was dropped before the answer finished.");
      throw err;
    }
  } finally {
    clearTimeout(watchdog); // a timer left running would keep the program alive
    request.abort("finished"); // close the connection if the server left it open
  }
  if (!finished) {
    console.log();
    fail("the answer was cut off: the stream ended with no finish marker.");
  }
  const total = performance.now() - started;

  // The receipt: what it cost against the list price for the same tokens.
  const paid = dollars(usage?.buyer_cost_micro);
  // The list price and seller name are nice-to-haves: give up after 3 s rather than hang.
  const [info, seller] = await Promise.all([
    api(`/v1/models/${encodeURIComponent(model)}`, undefined, undefined, 3000).catch(() => null),
    sellerOf(requestId),
  ]);
  const list = listPrice(info?.pricing, usage);
  const parts = [
    seller ? `${model} via ${seller}` : model,
    firstToken ? `first token ${((firstToken - started) / 1000).toFixed(1)} s` : "no text",
    `total ${(total / 1000).toFixed(1)} s`,
    usage ? `${usage.completion_tokens} tokens` : null,
    // Surplus bills in whole millionths of a dollar, so a tiny answer can round to 0.
    usage?.buyer_cost_micro != null ? `cost ${paid === 0 ? "under $0.000001" : usd(paid)}` : null,
    list ? `list ${usd(list)}${paid > 0 ? `, saved ${savedPct(paid, list)}%` : ""}` : null,
  ].filter(Boolean);
  console.log(`\n\n· ${parts.join(" · ")}`);
}

// Which seller served a request. The answer itself does not say, so we look
// the request up in the account's own log by its id. Best effort: the log
// can lag, and a missing name must never break the receipt.
async function sellerOf(requestId) {
  if (!requestId) return null;
  const log = await api("/v1/requests?limit=5", undefined, undefined, 3000).catch(() => null);
  return log?.items?.find((r) => r.request_id === requestId)?.provider ?? null;
}

// One prompt, several models, side by side: the answer, the wait and the cost.
async function compare(prompt, flags) {
  const models = (flags.model ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (!prompt || models.length < 2) fail(`Usage: ${NAME} compare "your question" -m model-a,model-b`);
  const waitMs = (Number(flags.wait ?? 90) || 90) * 1000;
  const key = apiKey();

  const one = async (model) => {
    const started = performance.now();
    try {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(waitMs),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      });
      const seconds = (performance.now() - started) / 1000;
      if (!res.ok) return { model, error: `answered ${res.status}` };
      const body = await res.json();
      const info = await api(`/v1/models/${encodeURIComponent(model)}`).catch(() => null);
      return {
        model,
        seconds,
        text: body.choices?.[0]?.message?.content ?? "",
        tokens: body.usage?.completion_tokens,
        paid: dollars(body.usage?.buyer_cost_micro),
        list: listPrice(info?.pricing, body.usage),
      };
    } catch (err) {
      return { model, error: err.name === "TimeoutError" ? `no answer in ${waitMs / 1000} s` : err.message };
    }
  };
  const results = await Promise.all(models.map(one)); // all at once, so the wait is the slowest one

  if (flags.json) return console.log(JSON.stringify(results, null, 2));
  const rows = results.map((r) =>
    r.error
      ? [r.model, r.error, "", "", "", ""]
      : [r.model, `${r.seconds.toFixed(1)} s`, r.tokens ?? "", usd(r.paid), r.list ? usd(r.list) : "", r.list && r.paid > 0 ? `${savedPct(r.paid, r.list)}%` : ""],
  );
  console.log(table([["MODEL", "TIME", "TOKENS", "COST", "LIST", "SAVED"], ...rows]));
  for (const r of results) if (!r.error) console.log(`\n── ${r.model}\n${r.text.trim()}`);
}

// Is a program on the PATH? Checks each folder for the name, with the
// endings Windows adds (.exe, .cmd).
function onPath(program) {
  const endings = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  return (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .some((dir) => endings.some((end) => existsSync(join(dir, program + end))));
}

// A quick health check: the things that go wrong, tested one by one.
async function doctor() {
  const lines = [];
  let healthy = true;
  const check = (ok, text) => {
    lines.push(`${ok ? "ok  " : "FAIL"}  ${text}`);
    healthy &&= ok;
  };

  const node = Number(process.versions.node.split(".")[0]);
  check(node >= 18, `Node ${process.versions.node}${node >= 18 ? "" : " is too old, 18 or newer is needed"}`);

  const key = process.env.SURPLUS_API_KEY || readConfig().apiKey;
  check(!!key, key ? "API key found" : `No API key. Run: ${NAME} login   or   ${NAME} signup`);
  if (key) {
    const res = await fetch(`${BASE}/v1/payments/balance`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => err);
    if (res instanceof Error) check(false, `Surplus did not answer at ${BASE}: ${res.message}`);
    else if (!res.ok) check(false, `API key was refused by Surplus (status ${res.status})`);
    else {
      check(true, "API key works");
      const credit = dollars((await res.json()).credit_balance_usdc);
      check(credit > 0, `Credit ${usd(credit)}${credit > 0 ? "" : `. Add some with: ${NAME} topup 10`}`);
    }
  }
  const found = LAUNCHERS.filter(onPath);
  lines.push(`      Tools found: ${found.length ? found.map((t) => `${NAME} ${t}`).join(", ") : "none"}`);

  console.log(lines.join("\n"));
  if (!healthy) process.exitCode = 1;
}

// Start another program with its settings pointed at Surplus. Everything
// after the program's name is passed through untouched. A known tool gets
// its own recipe from launcher(); anything else gets the general settings.
async function run(program, userArgs) {
  if (!program) fail(`Usage: ${NAME} run <program> [its arguments]`);
  const key = apiKey();
  // opencode has to be told which models exist, so ask Surplus for the list.
  const models = program === "opencode" ? ((await api("/v1/models", key)).data ?? []).map((m) => m.id) : [];
  const recipe = launcher(program, key, BASE, models) ?? { program, args: [], env: surplusEnv(key) };
  const args = [...recipe.args, ...userArgs];
  const windows = process.platform === "win32";
  // On Windows the program may be a .cmd file, which needs a shell, and a
  // shell takes one command line, with arguments that have spaces quoted.
  const options = { stdio: "inherit", env: { ...process.env, ...recipe.env } };
  const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const child = windows
    ? spawn([program, ...args.map(quote)].join(" "), { ...options, shell: true })
    : spawn(program, args, options);
  child.on("error", (err) => {
    console.error(`${NAME}: could not start ${program}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

// ---- bench: the same prompts through several routers ----

// Short prompts with one right answer, so quality can be checked by a
// pattern instead of by opinion. `sample` is a correct reply, used by tests.
export const BENCH_PROMPTS = [
  { id: "math", text: "What is 17 * 23? Reply with only the number.", expect: /\b391\b/, sample: "391" },
  { id: "capital", text: "What is the capital of Australia? Reply with one word.", expect: /canberra/i, sample: "Canberra" },
  { id: "reverse", text: "Write the word stream backwards. Reply with only that.", expect: /maerts/i, sample: "maerts" },
];

// The routers. Keys come only from the environment (Surplus also from the
// saved login). `fee` is added to what a router reports: OpenRouter charges
// 5.5% when credits are bought, not per request. `cost` reads the charge in
// dollars from a reply's usage, or null when the router does not report it.
function benchRouters() {
  return [
    {
      name: "surplus",
      base: `${BASE}/v1`,
      key: process.env.SURPLUS_API_KEY || readConfig().apiKey,
      fee: 0,
      model: (m) => m,
      cost: (u) => (u?.buyer_cost_micro != null ? dollars(u.buyer_cost_micro) : null),
    },
    {
      name: "openrouter",
      base: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      key: process.env.OPENROUTER_API_KEY,
      fee: 0.055,
      extra: { usage: { include: true } }, // asks OpenRouter to report the charge
      model: (m) => (m.includes("/") ? m : `${vendorOf(m)}/${m}`),
      cost: (u) => (u?.cost != null ? Number(u.cost) : null),
    },
    {
      name: "ramp",
      base: process.env.RAMP_ROUTER_BASE_URL, // not confirmed publicly, so it must be given
      key: process.env.RAMP_ROUTER_API_KEY,
      fee: 0,
      model: (m) => m,
      cost: (u) => (u?.cost != null ? Number(u.cost) : null),
    },
  ];
}

// OpenRouter names models "vendor/model". A guess from the name's start.
function vendorOf(model) {
  const known = [["gpt", "openai"], ["o1", "openai"], ["o3", "openai"], ["claude", "anthropic"], ["gemini", "google"], ["deepseek", "deepseek"], ["glm", "z-ai"], ["kimi", "moonshotai"], ["qwen", "qwen"], ["llama", "meta-llama"], ["grok", "x-ai"], ["mistral", "mistralai"]];
  return known.find(([start]) => model.startsWith(start))?.[1] ?? "openai";
}

const median = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

// One row per router and model, from the raw samples. Pure, so it is tested
// directly, and fixture runs and live runs share it.
export function benchSummary(samples) {
  const fees = Object.fromEntries(benchRouters().map((r) => [r.name, r.fee]));
  const groups = new Map();
  for (const s of samples) {
    const key = `${s.router} ${s.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.values()].map((group) => {
    const { router, model } = group[0];
    const ok = group.filter((s) => s.ok);
    const costs = ok.map((s) => s.costUsd);
    const known = costs.length > 0 && costs.every((c) => c != null);
    const costUsd = known ? costs.reduce((a, b) => a + b, 0) * (1 + (fees[router] ?? 0)) : null;
    const tokens = ok.reduce((a, s) => a + (s.inTokens ?? 0) + (s.outTokens ?? 0), 0);
    return {
      router,
      model,
      attempts: group.length,
      errorRate: (group.length - ok.length) / group.length,
      quality: ok.length ? ok.filter((s) => s.pass).length / ok.length : null,
      ttftMs: median(ok.map((s) => s.ttftMs)),
      tokensPerSecond: median(ok.map((s) => (s.totalMs > s.ttftMs ? s.outTokens / ((s.totalMs - s.ttftMs) / 1000) : NaN))),
      costUsd,
      perMillionTokensUsd: costUsd != null && tokens > 0 ? (costUsd / tokens) * 1e6 : null,
    };
  });
}

// One streamed request, measured. Never throws: a failure is a sample too.
async function benchOne(router, model, prompt, waitMs) {
  const sample = { router: router.name, model, prompt: prompt.id };
  const started = performance.now();
  let ttft = null;
  let text = "";
  let usage = null;
  try {
    const res = await fetch(`${router.base}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(waitMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${router.key}` },
      body: JSON.stringify({
        model: router.model(model),
        messages: [{ role: "user", content: prompt.text }],
        stream: true,
        stream_options: { include_usage: true },
        ...router.extra,
      }),
    });
    if (!res.ok) return { ...sample, ok: false, error: `answered ${res.status}` };
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const event = parseEvent(line);
        if (event === "done") done = true;
        if (!event || event === "done") continue;
        const piece = event.choices?.[0]?.delta?.content;
        if (piece) {
          ttft ??= performance.now() - started;
          text += piece;
        }
        if (event.usage) usage = event.usage;
      }
      if (done) break;
    }
    const totalMs = performance.now() - started;
    if (!text) return { ...sample, ok: false, error: "no text" };
    return {
      ...sample,
      ok: true,
      pass: prompt.expect.test(text),
      ttftMs: Math.round(ttft),
      totalMs: Math.round(totalMs),
      inTokens: usage?.prompt_tokens ?? null,
      outTokens: usage?.completion_tokens ?? null,
      costUsd: router.cost(usage),
    };
  } catch (err) {
    return { ...sample, ok: false, error: err.name === "TimeoutError" ? `no answer in ${waitMs / 1000} s` : "connection failed" };
  }
}

async function bench(flags) {
  let samples;
  let note = null;
  const skipped = [];
  if (flags.fixture) {
    const data = JSON.parse(readFileSync(flags.fixture, "utf8"));
    samples = data.samples ?? data;
    note = data.note ?? `Replayed from ${flags.fixture}.`;
  } else if (flags.live) {
    const models = (flags.model ?? DEFAULT_MODEL).split(",").map((m) => m.trim()).filter(Boolean);
    const runs = Math.max(1, Math.min(Number(flags.runs ?? 1) || 1, 5));
    const waitMs = (Number(flags.wait ?? 60) || 60) * 1000;
    const routers = benchRouters().filter((r) => {
      if (r.key && r.base) return true;
      skipped.push(r.name);
      return false;
    });
    if (routers.length === 0) fail("No router has a key. Set SURPLUS_API_KEY, OPENROUTER_API_KEY, or RAMP_ROUTER_API_KEY with RAMP_ROUTER_BASE_URL.");
    // Routers run side by side; within a router, one request at a time, so
    // they do not slow each other down.
    const perRouter = await Promise.all(
      routers.map(async (router) => {
        const out = [];
        for (let i = 0; i < runs; i++)
          for (const model of models) for (const prompt of BENCH_PROMPTS) out.push(await benchOne(router, model, prompt, waitMs));
        return out;
      }),
    );
    samples = perRouter.flat();
    note = `Live run, ${new Date().toISOString()}. ${BENCH_PROMPTS.length} prompts x ${runs} run(s) per model per router.`;
    if (flags.save) writeFileSync(flags.save, JSON.stringify({ note, samples }, null, 2));
  } else {
    fail(
      `bench needs a source.\n  ${NAME} bench --fixture <file>      replay saved results: no keys, no network\n  ${NAME} bench --live [-m models]    send real requests to every router you have a key for (costs a little)`,
    );
  }

  const rows = benchSummary(samples);
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  const pct = (v) => (v == null ? "" : `${Math.round(v * 100)}%`);
  const money = (v) => (v == null ? "not reported" : usd(v));
  console.log(note + "\n");
  console.log(
    table([
      ["ROUTER", "MODEL", "ERRORS", "QUALITY", "FIRST TOKEN", "TOKENS/S", "$ PER 1M TOKENS", "COST"],
      ...rows.map((r) => [
        r.router,
        r.model,
        `${pct(r.errorRate)} of ${r.attempts}`,
        pct(r.quality),
        r.ttftMs == null ? "" : `${(r.ttftMs / 1000).toFixed(1)} s`,
        r.tokensPerSecond == null ? "" : Math.round(r.tokensPerSecond),
        r.perMillionTokensUsd == null ? "" : usd(r.perMillionTokensUsd),
        money(r.costUsd),
      ]),
    ]),
  );
  for (const name of skipped) console.log(`${name}: skipped, no key`);
  console.log("\nCost includes OpenRouter's 5.5% credit fee. Quality is the share of answers matching the expected reply.");
}

// ---- entry point ----

const HELP = `${NAME}: Surplus Intelligence from the terminal

  ${NAME} signup                       make a new account, no browser needed
  ${NAME} login [--key inf_...]        save an API key you already have
  ${NAME} topup <dollars>              add credit by card (10 to 2000)
  ${NAME} topup --usdc                 where to send USDC instead
  ${NAME} ask "question" [-m model]    stream an answer, then show its cost
                                      (--wait 90: seconds of silence before giving up)
                                      (--stdin: add piped text to the question)
  ${NAME} compare "question" -m a,b    one question, several models, side by side
  ${NAME} balance                      credit left and money saved
  ${NAME} savings                      what you saved, model by model
  ${NAME} price <model>                cheapest live sellers against list price
  ${NAME} logs [-n 10]                 your recent requests
  ${NAME} doctor                       check your setup, one thing at a time
  ${NAME} claude [arguments]           Claude Code, running on Surplus
  ${NAME} codex [arguments]            Codex, running on Surplus
  ${NAME} aider [arguments]            aider, running on Surplus
  ${NAME} opencode [arguments]         OpenCode, running on Surplus
  ${NAME} run <program> [arguments]    any other tool, pointed at Surplus

  balance, savings, price, logs and compare take --json for scripts.
`;

async function main() {
  // The launchers pass every later argument through, so they skip our own
  // flag parsing.
  const [first, ...passthrough] = process.argv.slice(2);
  if (LAUNCHERS.includes(first)) return run(first, passthrough);
  if (first === "run") return run(passthrough[0], passthrough.slice(1));
  if (first === "--version" || first === "-v") return console.log(VERSION);

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      key: { type: "string" },
      model: { type: "string", short: "m" },
      limit: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
      wait: { type: "string", short: "w" },
      new: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      usdc: { type: "boolean" },
      "no-open": { type: "boolean" },
      stdin: { type: "boolean" },
      json: { type: "boolean" },
      live: { type: "boolean" },
      fixture: { type: "string" },
      save: { type: "string" },
      runs: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) return console.log(HELP);
  if (command === "signup") return signup(values);
  if (command === "login") return login(values);
  if (command === "topup") return topup(rest[0], values);
  if (command === "balance") return balance(values);
  if (command === "savings") return savings(values);
  if (command === "price") return price(rest[0], values);
  if (command === "logs") return logs(values);
  if (command === "ask") return ask(rest.join(" "), values);
  if (command === "compare") return compare(rest.join(" "), values);
  if (command === "doctor") return doctor();
  if (command === "bench") return bench(values);
  fail(`Unknown command "${command}".\n\n${HELP}`);
}

// Run only when started as a program, not when the tests import it.
const startedAs = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === startedAs) {
  main().catch((err) => {
    console.error(`${NAME}: ${err.message}`);
    process.exitCode = 1;
  });
}
