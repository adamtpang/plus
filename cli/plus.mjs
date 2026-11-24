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
import { runInNewContext } from "node:vm";

const NAME = basename(process.argv[1] ?? "plus").replace(/\.(mjs|js|cmd)$/, "");
const BASE = process.env.SURPLUS_BASE_URL ?? "https://api.surplusintelligence.ai";
const CONFIG_DIR = join(homedir(), ".plus");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// Where the tool kept its config before it was called plus. Still read, so
// an earlier login keeps working; new saves go to CONFIG_FILE.
const OLD_CONFIG_FILE = join(homedir(), ".surplusminus", "config.json");
const DEFAULT_MODEL = "gpt-4o-mini";
const VERSION = "0.5.2"; // kept equal to package.json by a test
// What `-m auto` means: a cheap open-weight model. Surplus exposes no
// "official" or compliance flag on its offers, so there is nothing to filter
// on; Surplus itself picks the cheapest healthy seller for the model.
export const AUTO_MODEL = "glm-5.3-flash";
const MAX_RETRIES = 2;
const SPEND_FILE = join(CONFIG_DIR, "spend.json");

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
// `model` is the one given with --model, or null to keep the tool's default.
export function launcher(tool, key, base = BASE, models = [], model = null) {
  const env = surplusEnv(key, base);
  if (tool === "claude") {
    // Claude Code uses a smaller model for background tasks; point those at
    // the chosen one too, so every request uses a model Surplus serves.
    const picked = model
      ? Object.fromEntries(
          ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"].map((k) => [k, model]),
        )
      : {};
    return { program: "claude", args: [], env: { ...env, ...picked } };
  }
  if (tool === "aider") return { program: "aider", args: model ? ["--model", `openai/${model}`] : [], env };
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
    const args = [...settings.flatMap((s) => ["-c", s]), ...(model ? ["-m", model] : [])];
    return { program: "codex", args, env: { ...env, SURPLUS_API_KEY: key } };
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
    const args = model ? ["--model", `surplus/${model}`] : [];
    return { program: "opencode", args, env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
  }
  return null;
}
const LAUNCHERS = ["claude", "codex", "aider", "opencode"];

// How to install each launcher's tool, for when it is missing.
const INSTALL_HINTS = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
  aider: "python -m pip install aider-install && aider-install",
};

// `plus claude --model x ...`: the model is ours only when it comes first.
// Anywhere later it belongs to the tool and is passed through untouched.
export function splitModelFlag(args) {
  if ((args[0] === "--model" || args[0] === "-m") && args[1]) return { model: args[1], rest: args.slice(2) };
  return { model: null, rest: args };
}

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

// What a router said when it refused a request: its status, its error code
// and its message, without the surrounding JSON. Routers explain themselves
// in the body, and a bare "404" hides the reason.
export function refusal(status, bodyText) {
  try {
    const err = JSON.parse(bodyText).error ?? {};
    const code = typeof err === "string" ? null : err.code;
    const message = typeof err === "string" ? err : err.message;
    return [`${status}${code ? `, ${code}` : ""}`, message].filter(Boolean).join(": ").split(" Unusual bug?")[0].slice(0, 400);
  } catch {
    return `${status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`;
  }
}

// Stop with a message. It throws rather than exiting on the spot, so open
// network connections get to close first (exiting mid-close crashes Node on
// Windows). The entry point at the bottom prints it.
// The error is marked as ours, so code that catches network failures can
// tell "we decided to stop" from "the connection broke".
function fail(message) {
  throw Object.assign(new Error(message), { ours: true });
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
  const models = saved.by_model ?? [];
  if (models.length === 0) return console.log("No requests yet.");
  const openrouter = await openRouterPrices();
  const rows = models.map((m) => {
    // What the same tokens would have cost at OpenRouter's listed price.
    const p = openrouter[m.model];
    const there = p ? p.prompt * (m.input_tokens ?? 0) + p.completion * (m.output_tokens ?? 0) : null;
    return [
      m.model,
      m.requests,
      usd(dollars(m.spent)),
      usd(dollars(m.direct_spent)),
      usd(dollars(m.saved)),
      `${Math.round(m.discount)}%`,
      there == null ? "unknown" : usd(there),
      there == null ? "" : usd(Math.max(0, there - dollars(m.spent))),
    ];
  });
  console.log(table([["MODEL", "REQUESTS", "PAID", "LIST", "SAVED", "OFF", "OPENROUTER LIST", "SAVED VS OPENROUTER"], ...rows]));
  console.log("\nOpenRouter list is its public price for the same tokens, without its 5.5% credit fee or cache discounts. \"unknown\" means it lists no such model.");
}

// OpenRouter's public price list as { model: { prompt, completion } } in
// dollars per token, keyed by the name without its "vendor/" prefix. Kept
// for a day in the config folder. Empty when it cannot be fetched.
async function openRouterPrices() {
  const file = join(CONFIG_DIR, "openrouter-prices.json");
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (Date.now() - cached.at < 24 * 3600 * 1000) return cached.prices;
  } catch {
    // no usable cache: fetch below
  }
  const url = process.env.OPENROUTER_MODELS_URL ?? "https://openrouter.ai/api/v1/models";
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res?.ok) return {};
  const body = await res.json().catch(() => ({}));
  const prices = {};
  for (const m of body.data ?? []) {
    if (!m.pricing) continue;
    prices[m.id.split("/").pop()] = { prompt: Number(m.pricing.prompt) || 0, completion: Number(m.pricing.completion) || 0 };
  }
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now(), prices }));
  } catch {
    // a cache that cannot be written is not worth failing over
  }
  return prices;
}

// Text Arena scores (arena.ai, formerly LMArena), frozen here so `plus
// models` needs no scraping. null means the model was not on the page when
// it was read. To refresh: open https://arena.ai/leaderboard/chat/text (or
// the dataset at huggingface.co/datasets/lmarena-ai/leaderboard-dataset),
// copy the Text scores, and change the date.
export const ARENA = {
  date: "2026-11-22",
  models: {
    "gemini-4-carbon": 1527,
    "claude-opus-5.5": 1507,
    "mimo-v2.6-pro": 1481,
    "glm-5.3-flash": 1476,
    "claude-sonnet-5.5": null,
    "kimi-k3": null,
    "glm-5.3": null,
    "deepseek-v4.1-flash": null,
  },
};

// A short list of models: Surplus's best live price next to a quality score.
async function models(flags = {}) {
  const rows = await Promise.all(
    Object.entries(ARENA.models).map(async ([id, score]) => {
      const market = await api(`/api/markets/${encodeURIComponent(id)}`, undefined, undefined, 8000).catch(() => null);
      const best = (market?.offers ?? []).find((o) => o.available && o.healthy);
      const input = best ? dollars(best.price_input_per_1m) : null;
      const output = best ? dollars(best.price_output_per_1m) : null;
      // Three parts input to one part output, a usual mix for coding work.
      const blended = best ? (3 * input + output) / 4 : null;
      return { model: id, input, output, score, perThousandPoints: blended != null && score ? (blended / score) * 1000 : null };
    }),
  );
  if (flags.json) return console.log(JSON.stringify({ arena_date: ARENA.date, models: rows }, null, 2));
  const money = (v) => (v == null ? "no offer" : usd(v));
  console.log(
    table([
      ["MODEL", "INPUT $/1M", "OUTPUT $/1M", "ARENA TEXT", "$ PER 1000 POINTS"],
      ...rows.map((r) => [r.model, money(r.input), money(r.output), r.score ?? "no score", r.perThousandPoints == null ? "" : usd(r.perThousandPoints)]),
    ]),
  );
  console.log(`\nPrices are Surplus's cheapest live offer right now. Arena Text scores were read from arena.ai on ${ARENA.date}.`);
  console.log("$ per 1000 points is the blended price (3 parts input, 1 part output) per 1M tokens, divided by the score: lower is more quality per dollar.");
  console.log(`\n-m auto uses ${AUTO_MODEL}. Surplus does not tag offers as official or compliant, so auto cannot filter on that.`);
}

// The settings that point a tool at Surplus, by name. The key is never shown.
function printEnv() {
  const env = surplusEnv("(your Surplus key)");
  console.log(table(Object.entries(env).map(([name, value]) => [name, value === "" ? "(empty on purpose)" : value])));
  console.log(`
${NAME} run <program> sets these and starts the program. Nothing is written to any config file.

  Claude Code   ${NAME} claude            reads the ANTHROPIC_* names
  Codex         ${NAME} codex             set through its own -c flags
  OpenCode      ${NAME} opencode
  aider         ${NAME} aider             reads OPENAI_API_BASE and OPENAI_API_KEY
  Kilo, Cline, Roo   editor extensions: choose "OpenAI Compatible" in the extension's
                provider settings and enter the OPENAI_BASE_URL above and your key
  Cursor        Settings, Models: turn on "Override OpenAI Base URL", enter the
                OPENAI_BASE_URL above and your key

The Kilo and Cursor steps are from each tool's own settings screens and have not been run by this project.`);
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

// ---- spend cap ----
// PLUS_SPEND_CAP (dollars), or "spendCap" in the config file, limits what
// `ask`, `compare` and `bench --live` may spend per day on this machine. It
// counts what plus itself spent; tools started with `plus claude` are not
// counted. Returns null when no cap is set.
function spendCap() {
  const raw = process.env.PLUS_SPEND_CAP || readConfig().spendCap;
  if (raw == null || raw === "") return null;
  const cap = Number(raw);
  return Number.isFinite(cap) && cap >= 0 ? cap : null;
}
const today = () => new Date().toISOString().slice(0, 10);
function spentToday() {
  try {
    const saved = JSON.parse(readFileSync(SPEND_FILE, "utf8"));
    return saved.date === today() ? Number(saved.usd) || 0 : 0;
  } catch {
    return 0;
  }
}
// Stop before a paid request once the day's spending has reached the cap.
function checkSpendCap() {
  const cap = spendCap();
  if (cap != null && spentToday() >= cap) {
    fail(`spend cap reached: ${usd(spentToday())} spent today of a ${usd(cap)} cap. Raise PLUS_SPEND_CAP to continue.`);
  }
}
// Record what a request cost. Only kept when a cap is set. Returns the new total.
function addSpend(amount) {
  if (spendCap() == null) return null;
  const total = spentToday() + (amount || 0);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SPEND_FILE, JSON.stringify({ date: today(), usd: total }));
  return total;
}
const spendLine = (total) => (total == null ? null : `spent today ${usd(total)} of ${usd(spendCap())}`);

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
  const auto = flags.model === "auto";
  const model = auto ? AUTO_MODEL : (flags.model ?? DEFAULT_MODEL);
  checkSpendCap();
  const started = performance.now();

  // One try at the request. It throws an error marked `retryable` when
  // trying again could help and nothing has been printed yet: a 5xx reply, or
  // a connection that died before any of the answer arrived.
  const retryable = (message) => Object.assign(new Error(message), { retryable: true });
  const attempt = async () => {
  let requestId = null;
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
    if (!res.ok) {
      const message = `Surplus refused the request (${refusal(res.status, await res.text())})`;
      if (res.status >= 500) throw retryable(message);
      fail(message);
    }
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
      if (err.retryable || err.ours) throw err; // already explained: pass it on unchanged
      if (firstToken) fail("the connection was dropped before the answer finished.");
      // Nothing was printed, so another try cannot show the answer twice.
      throw retryable(gotResponse ? "the connection was dropped before any answer arrived" : `could not reach Surplus: ${err.message}`);
    }
  } finally {
    clearTimeout(watchdog); // a timer left running would keep the program alive
    request.abort("finished"); // close the connection if the server left it open
  }
  if (!finished) {
    console.log();
    fail("the answer was cut off: the stream ended with no finish marker.");
  }
  return { requestId, firstToken, usage };
  };

  // Up to two more tries. On each, Surplus is free to pick another seller.
  let result;
  let retries = 0;
  for (;;) {
    try {
      result = await attempt();
      break;
    } catch (err) {
      if (!err.retryable) throw err;
      if (retries === MAX_RETRIES) fail(`the request failed ${retries + 1} times. Last error: ${err.message}`);
      retries++;
    }
  }
  const { requestId, firstToken, usage } = result;
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
    `${auto ? "auto -> " : ""}${model}${seller ? ` via ${seller}` : ""}`,
    firstToken ? `first token ${((firstToken - started) / 1000).toFixed(1)} s` : "no text",
    `total ${(total / 1000).toFixed(1)} s`,
    usage ? `${usage.completion_tokens} tokens` : null,
    // Surplus bills in whole millionths of a dollar, so a tiny answer can round to 0.
    usage?.buyer_cost_micro != null ? `cost ${paid === 0 ? "under $0.000001" : usd(paid)}` : null,
    list ? `list ${usd(list)}${paid > 0 ? `, saved ${savedPct(paid, list)}%` : ""}` : null,
    retries ? `retried ${retries} time${retries > 1 ? "s" : ""}` : null,
    spendLine(addSpend(paid)),
  ].filter(Boolean);
  console.log(`\n\n· ${parts.join(" · ")}`);
}

// Which seller served a request. The answer itself does not say, so we look
// the request up in the account's own log by its id. Best effort: the log
// can lag, and a missing name must never break the receipt.
async function sellerOf(requestId) {
  if (!requestId) return null;
  // The log is usually a second or two behind the answer, so look a few times.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000);
    const log = await api("/v1/requests?limit=5", undefined, undefined, 3000).catch(() => null);
    const seller = log?.items?.find((r) => r.request_id === requestId)?.provider;
    if (seller) return seller;
  }
  return null;
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
  checkSpendCap();
  const results = await Promise.all(models.map(one)); // all at once, so the wait is the slowest one
  addSpend(results.reduce((sum, r) => sum + (r.paid || 0), 0));

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
async function run(program, givenArgs) {
  if (!program) fail(`Usage: ${NAME} run <program> [its arguments]`);
  const key = apiKey();

  // Check the key first: a tool that starts with a refused key fails later,
  // in its own words, which are harder to read.
  const check = await fetch(`${BASE}/v1/payments/balance`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!check) fail(`could not reach Surplus at ${BASE}. Check your connection and try again.`);
  if (check.status === 401 || check.status === 403) {
    fail(`Surplus refused your API key (status ${check.status}). Save a working one with: ${NAME} login`);
  }
  if (!onPath(program)) {
    const hint = INSTALL_HINTS[program] ? ` Install it with: ${INSTALL_HINTS[program]}` : " Is it installed and on your PATH?";
    fail(`${program} was not found.${hint}`);
  }

  const { model, rest: userArgs } = LAUNCHERS.includes(program) ? splitModelFlag(givenArgs) : { model: null, rest: givenArgs };
  // opencode has to be told which models exist, so ask Surplus for the list.
  const models = program === "opencode" ? ((await api("/v1/models", key)).data ?? []).map((m) => m.id) : [];
  const recipe = launcher(program, key, BASE, models, model) ?? { program, args: [], env: surplusEnv(key) };
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

// Update by running the same installer again, into the folder plus runs from.
const INSTALLER = "https://raw.githubusercontent.com/adamtpang/plus/main/cli";
function update(flags) {
  const windows = process.platform === "win32";
  const [program, args] = windows
    ? ["powershell", ["-NoProfile", "-Command", `irm ${INSTALLER}/install.ps1 | iex`]]
    : ["sh", ["-c", `curl -fsSL ${INSTALLER}/install.sh | sh`]];
  if (flags.print) return console.log([program, ...args].join(" "));
  // Running from a checkout of the repository: git, not the installer, updates it.
  const here = realpathSync(process.argv[1]);
  if (existsSync(join(here, "..", "..", "package.json"))) fail("This is a checkout of the repository. Update it with: git pull");
  const env = { ...process.env, PLUS_INSTALL_DIR: join(here, ".."), PLUS_NO_MODIFY_PATH: "1" };
  const child = spawn(program, args, { stdio: "inherit", env });
  child.on("error", (err) => {
    console.error(`${NAME}: could not run the installer: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

// ---- bench: the same prompts through several routers ----

// The quick set: three short prompts with one right answer each. `sample` is
// a correct reply, used by tests.
export const BENCH_PROMPTS = [
  { id: "math", text: "What is 17 * 23? Reply with only the number.", expect: /\b391\b/, sample: "391" },
  { id: "capital", text: "What is the capital of Australia? Reply with one word.", expect: /canberra/i, sample: "Canberra" },
  { id: "reverse", text: "Write the word stream backwards. Reply with only that.", expect: /maerts/i, sample: "maerts" },
];

// Does the code in a reply define `name`, and does it give the expected
// result for every case? The code runs in a bare sandbox (no files, no
// network, no require) with a one second limit per step. That keeps honest
// mistakes contained; it is not a defence against code written to escape.
function passesTests(reply, name, cases) {
  const fenced = reply.match(/```[\w-]*\n([\s\S]*?)```/);
  const code = (fenced ? fenced[1] : reply).replace(/^\s*export\s+(default\s+)?/gm, "");
  try {
    const box = {};
    runInNewContext(`${code}\n;this.__f = typeof ${name} === "function" ? ${name} : null;`, box, { timeout: 1000 });
    if (!box.__f) return false;
    return cases.every(([args, want]) => {
      const got = runInNewContext(`JSON.stringify(__f(...${JSON.stringify(args)}))`, box, { timeout: 1000 });
      return got === JSON.stringify(want);
    });
  } catch {
    return false;
  }
}

// Did the model call the tool, with arguments that parse and match?
function calledTool(calls, name, want) {
  const call = calls.find((c) => c.name === name);
  if (!call) return false;
  try {
    const args = JSON.parse(call.arguments);
    return Object.entries(want).every(([key, value]) => String(args[key]).toLowerCase() === String(value).toLowerCase());
  } catch {
    return false;
  }
}

// A long document with one fact to find. Made by a formula, so every run
// sends the same text and the right answer is known.
const accessCode = (i) => `K${((i * 7919 + 104729) % 900000) + 100000}`;
const records = (count) =>
  Array.from({ length: count }, (_, i) => `Record ${i + 1}: access code ${accessCode(i + 1)}, status active, reviewed by desk ${(i % 7) + 1}.`).join("\n");
const findRecord = (id, count, n) => ({
  id,
  type: "long-context",
  messages: [{ role: "user", content: `${records(count)}\n\nWhat is the access code for record ${n}? Reply with only the code.` }],
  check: (reply) => reply.includes(accessCode(n)),
  sample: { text: accessCode(n) },
});

const tool = (name, description, properties) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required: Object.keys(properties) } },
});
const SLUGIFY = "function slugify(s) {\n  return s.toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n}";
const CHUNK = "function chunk(items, size) {\n  const out = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}";
const MEDIAN = "function median(values) {\n  const v = [...values].sort((a, b) => a - b);\n  const mid = Math.floor(v.length / 2);\n  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;\n}";
const CAPITALIZE = "function capitalize(s) {\n  return s.split(\" \").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(\" \");\n}";
const COUNTER_PAGE =
  '<!doctype html>\n<html><body>\n<button id="counter">0</button>\n<script>\nconst b = document.getElementById("counter");\nb.addEventListener("click", () => { b.textContent = Number(b.textContent) + 1; });\n</script>\n</body></html>';
const CENTERED_CSS = ".card-wrap {\n  display: flex;\n  justify-content: center;\n  align-items: center;\n  min-height: 100vh;\n}";

// The full set: two prompts of each kind the spec names. Every one has a
// check that needs no judge: unit tests for code, the tool call itself for
// tool use, required markup for web pages, an exact value for long context.
export const BENCH_SET = [
  {
    id: "code-slugify",
    type: "coding",
    messages: [{ role: "user", content: "Write a JavaScript function slugify(s) that lowercases s, turns every run of characters that are not a-z or 0-9 into a single hyphen, and removes hyphens from both ends. Reply with only the function in a code block." }],
    check: (reply) => passesTests(reply, "slugify", [[["Hello, World!"], "hello-world"], [["  A  b__C "], "a-b-c"], [["x"], "x"]]),
    sample: { text: "```js\n" + SLUGIFY + "\n```" },
  },
  {
    id: "code-chunk",
    type: "coding",
    messages: [{ role: "user", content: "Write a JavaScript function chunk(items, size) that splits the array items into arrays of at most size elements, in order. Reply with only the function in a code block." }],
    check: (reply) => passesTests(reply, "chunk", [[[[1, 2, 3, 4, 5], 2], [[1, 2], [3, 4], [5]]], [[[], 3], []], [[[1, 2], 5], [[1, 2]]]]),
    sample: { text: "```js\n" + CHUNK + "\n```" },
  },
  {
    id: "tool-weather",
    type: "tool-use",
    messages: [{ role: "user", content: "What is the weather in Paris right now? Use the tool." }],
    tools: [tool("get_weather", "Get the current weather for a city", { city: { type: "string" } })],
    check: (_reply, calls) => calledTool(calls, "get_weather", { city: "Paris" }),
    sample: { tool: { name: "get_weather", arguments: { city: "Paris" } } },
  },
  {
    id: "tool-cart",
    type: "tool-use",
    messages: [{ role: "user", content: "Add 3 apples to my cart. Use the tool." }],
    tools: [tool("add_to_cart", "Add an item to the shopping cart", { item: { type: "string" }, quantity: { type: "integer" } })],
    check: (_reply, calls) => {
      const call = calls.find((c) => c.name === "add_to_cart");
      try {
        const args = JSON.parse(call.arguments);
        return /apple/i.test(args.item) && Number(args.quantity) === 3;
      } catch {
        return false;
      }
    },
    sample: { tool: { name: "add_to_cart", arguments: { item: "apples", quantity: 3 } } },
  },
  {
    id: "web-counter",
    type: "webdev",
    messages: [{ role: "user", content: 'Write one complete HTML page with a button whose id is "counter". It shows 0 and goes up by one on each click. Use a script tag, no libraries. Reply with only the HTML.' }],
    check: (reply) => /<button[^>]*id=["']counter["']/i.test(reply) && /<script/i.test(reply) && /addEventListener|onclick/i.test(reply),
    sample: { text: COUNTER_PAGE },
  },
  {
    id: "web-center",
    type: "webdev",
    messages: [{ role: "user", content: "Write the CSS for a class .card-wrap that centers its one child both horizontally and vertically using flexbox and is at least as tall as the screen. Reply with only the CSS." }],
    check: (reply) => /display:\s*flex/i.test(reply) && /justify-content:\s*center/i.test(reply) && /align-items:\s*center/i.test(reply),
    sample: { text: CENTERED_CSS },
  },
  findRecord("long-187", 300, 187),
  findRecord("long-42", 300, 42),
  {
    id: "repair-median",
    type: "repair",
    messages: [
      { role: "user", content: "Write a JavaScript function median(values) for an array of numbers." },
      { role: "assistant", content: "```js\nfunction median(values) {\n  const v = values.sort();\n  return v[Math.floor(v.length / 2)];\n}\n```" },
      { role: "user", content: "That is wrong: median([10, 9, 100]) gives 100, and median([1, 2, 3, 4]) should be 2.5. It also must not change the array passed in. Fix it. Reply with only the corrected function in a code block." },
    ],
    check: (reply) => passesTests(reply, "median", [[[[10, 9, 100]], 10], [[[1, 2, 3, 4]], 2.5], [[[5]], 5]]),
    sample: { text: "```js\n" + MEDIAN + "\n```" },
  },
  {
    id: "repair-capitalize",
    type: "repair",
    messages: [
      { role: "user", content: "Write a JavaScript function capitalize(s) that makes the first letter of every word uppercase." },
      { role: "assistant", content: "```js\nfunction capitalize(s) {\n  return s[0].toUpperCase() + s.slice(1);\n}\n```" },
      { role: "user", content: 'That only does the first word, and it crashes on an empty string. capitalize("hello big world") should give "Hello Big World" and capitalize("") should give "". Words are separated by single spaces. Fix it. Reply with only the corrected function in a code block.' },
    ],
    check: (reply) => passesTests(reply, "capitalize", [[["hello big world"], "Hello Big World"], [[""], ""], [["a"], "A"]]),
    sample: { text: "```js\n" + CAPITALIZE + "\n```" },
  },
];

// The spec's short list of models, for `-m shortlist`.
const BENCH_MODELS = ["gemini-4-carbon", "claude-opus-5.5", "claude-sonnet-5.5", "kimi-k3", "glm-5.3", "glm-5.3-flash", "mimo-v2.6-pro", "deepseek-v4.1-flash"];

// The routers. Keys come only from the environment (Surplus also from the
// saved login). `fee` is added to what a router reports: OpenRouter charges
// 5.5% when credits are bought, not per request. `cost` reads the charge in
// dollars from a reply's usage, or null when the router does not report it.
// `guess` is the model name to try when the router's own list cannot be read.
function benchRouters() {
  return [
    {
      name: "surplus",
      base: `${BASE}/v1`,
      key: process.env.SURPLUS_API_KEY || readConfig().apiKey,
      fee: 0,
      guess: (m) => m,
      cost: (u) => (u?.buyer_cost_micro != null ? dollars(u.buyer_cost_micro) : null),
    },
    {
      name: "openrouter",
      base: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      key: process.env.OPENROUTER_API_KEY,
      fee: 0.055,
      extra: { usage: { include: true } }, // asks OpenRouter to report the charge
      guess: (m) => (m.includes("/") ? m : `${vendorOf(m)}/${m}`),
      cost: (u) => (u?.cost != null ? Number(u.cost) : null),
    },
    {
      name: "ramp",
      // Address from Lago's Ramp Router guide (getlago.com), not Ramp's own docs.
      base: process.env.RAMP_ROUTER_BASE_URL ?? "https://api.router.com/v1",
      key: process.env.RAMP_ROUTER_API_KEY,
      fee: 0,
      guess: rampModelName,
      // Ramp's replies carry no cost (it is in its dashboard), so its tokens
      // are priced from its own model list instead.
      cost: (u) => (u?.cost != null ? Number(u.cost) : null),
    },
  ];
}

// Ramp writes Claude versions with dashes: claude-sonnet-4-5, not 4.5.
export const rampModelName = (m) => (m.startsWith("claude") ? m.replaceAll(".", "-") : m);

// OpenRouter names models "vendor/model". A guess from the name's start.
function vendorOf(model) {
  const known = [["gpt", "openai"], ["o1", "openai"], ["o3", "openai"], ["claude", "anthropic"], ["gemini", "google"], ["deepseek", "deepseek"], ["glm", "z-ai"], ["kimi", "moonshotai"], ["qwen", "qwen"], ["llama", "meta-llama"], ["grok", "x-ai"], ["mistral", "mistralai"], ["mimo", "xiaomi"]];
  return known.find(([start]) => model.startsWith(start))?.[1] ?? "openai";
}

// Routers spell the same model differently: "vendor/glm-5.3", "glm-5p3",
// "claude-sonnet-5-5". This reduces a name to one comparable form.
const plainName = (id) => id.toLowerCase().replace(/^.*\//, "").replace(/(\d)[p-](\d)/g, "$1.$2");

// A router's own model list: the exact ids it accepts, and its list price for
// each in dollars per token. null when the list cannot be read.
async function catalog(router) {
  const res = await fetch(`${router.base}/models`, {
    headers: { authorization: `Bearer ${router.key}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = await res.json().catch(() => ({}));
  const prices = {};
  const ids = [];
  for (const m of body.data ?? []) {
    ids.push(m.id);
    // Ramp: router.pricing, dollars per 1M tokens. Others: pricing, dollars per token.
    const r = m.router?.pricing;
    if (r?.input != null) prices[m.id] = { prompt: Number(r.input) / 1e6, completion: Number(r.output ?? 0) / 1e6 };
    else if (m.pricing) prices[m.id] = { prompt: Number(m.pricing.prompt) || 0, completion: Number(m.pricing.completion) || 0 };
  }
  return ids.length ? { ids, prices } : null;
}

// The name this router uses for a model, or null if its list has no such model.
function routerModel(router, model) {
  if (!router.catalog) return router.guess(model);
  const { ids } = router.catalog;
  return ids.find((id) => id === model) ?? ids.find((id) => id === router.guess(model)) ?? ids.find((id) => plainName(id) === plainName(model)) ?? null;
}

// The value at a percentile, by nearest rank. null for an empty list.
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)];
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
    if (s.skipped) continue;
    const key = `${s.router} ${s.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.values()].map((group) => {
    const { router, model } = group[0];
    const fee = 1 + (fees[router] ?? 0);
    const ok = group.filter((s) => s.ok);
    const failed = group.filter((s) => !s.ok);
    const costs = ok.map((s) => s.costUsd);
    const known = costs.length > 0 && costs.every((c) => c != null);
    const costUsd = known ? costs.reduce((a, b) => a + b, 0) * fee : null;
    const tokens = ok.reduce((a, s) => a + (s.inTokens ?? 0) + (s.outTokens ?? 0), 0);
    const inTokens = ok.reduce((a, s) => a + (s.inTokens ?? 0), 0);
    const listed = ok.every((s) => s.listUsd != null) && ok.length > 0 ? ok.reduce((a, s) => a + s.listUsd, 0) : null;
    const sources = new Set(ok.map((s) => s.costSource ?? (s.costUsd != null ? "reported" : null)));
    // A rate needs time to measure over. An answer that lands in one burst
    // (under a quarter second after its first token) has no meaningful rate.
    const rates = ok.map((s) => (s.totalMs - s.ttftMs >= 250 ? s.outTokens / ((s.totalMs - s.ttftMs) / 1000) : NaN));
    const failureKinds = {};
    for (const s of failed) failureKinds[s.kind ?? "error"] = (failureKinds[s.kind ?? "error"] ?? 0) + 1;
    const byType = {};
    for (const s of group) {
      // Only answered requests count: one that failed was not answered wrongly.
      const t = (byType[s.type ?? "quick"] ??= { pass: 0, of: 0 });
      if (!s.ok) continue;
      t.of++;
      if (s.pass) t.pass++;
    }
    return {
      router,
      model,
      attempts: group.length,
      failures: failed.length,
      failureKinds,
      errors: [...new Set(failed.map((s) => s.error))],
      errorRate: failed.length / group.length,
      retries: group.reduce((a, s) => a + (s.retries ?? 0), 0),
      failovers: group.reduce((a, s) => a + (s.failovers ?? 0), 0),
      quality: ok.length ? ok.filter((s) => s.pass).length / ok.length : null,
      byType,
      ttftMs: median(ok.map((s) => s.ttftMs)),
      ttftP50Ms: percentile(ok.map((s) => s.ttftMs), 50),
      ttftP95Ms: percentile(ok.map((s) => s.ttftMs), 95),
      tokensPerSecond: median(rates),
      tokensPerSecondP95: percentile(rates, 95),
      costUsd,
      costSource: !known ? null : sources.size === 1 ? [...sources][0] : "mixed",
      perMillionTokensUsd: costUsd != null && tokens > 0 ? (costUsd / tokens) * 1e6 : null,
      listUsd: listed,
      vsListPct: costUsd != null && listed ? Math.round((costUsd / listed - 1) * 100) : null,
      cacheSharePct: inTokens > 0 ? Math.round((ok.reduce((a, s) => a + (s.cachedTokens ?? 0), 0) / inTokens) * 100) : null,
    };
  });
}

// What a request cost: as the router reported it, or else priced from its
// model list. Also what the same tokens cost at that router's list price.
function costOf(router, sentAs, usage) {
  const p = router.catalog?.prices[sentAs];
  const listUsd = p && usage ? p.prompt * (usage.prompt_tokens ?? 0) + p.completion * (usage.completion_tokens ?? 0) : null;
  const reported = router.cost(usage);
  if (reported != null) return { costUsd: reported, costSource: "reported", listUsd };
  return { costUsd: listUsd, costSource: listUsd == null ? null : "catalog", listUsd };
}

// One streamed request, measured. Never throws: a failure is a sample too.
// `kind` names the failure: timeout, http_4xx, http_5xx, dropped, empty,
// truncated or tool_parse.
async function benchOnce(router, model, sentAs, prompt, waitMs) {
  const sample = { router: router.name, model, requestedAs: sentAs, prompt: prompt.id, type: prompt.type ?? "quick" };
  const started = performance.now();
  let ttft = null;
  let text = "";
  let usage = null;
  let served = null;
  let finish = null;
  const calls = []; // tool calls, built up from pieces as they stream in
  try {
    const res = await fetch(`${router.base}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(waitMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${router.key}` },
      body: JSON.stringify({
        model: sentAs,
        messages: prompt.messages ?? [{ role: "user", content: prompt.text }],
        ...(prompt.tools && { tools: prompt.tools }),
        stream: true,
        stream_options: { include_usage: true },
        ...router.extra,
      }),
    });
    if (!res.ok) {
      const why = refusal(res.status, await res.text().catch(() => "")).split(": ")[0]; // status and code, not the long message
      return { ...sample, ok: false, kind: res.status >= 500 ? "http_5xx" : "http_4xx", error: `answered ${why}` };
    }
    const failovers = Math.max(0, Number(res.headers.get("x-si-marketplace-attempts") ?? 1) - 1) || 0;
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
        if (event.model) served = event.model;
        const choice = event.choices?.[0];
        if (choice?.delta?.content) {
          ttft ??= performance.now() - started;
          text += choice.delta.content;
        }
        for (const piece of choice?.delta?.tool_calls ?? []) {
          ttft ??= performance.now() - started;
          const call = (calls[piece.index ?? 0] ??= { name: "", arguments: "" });
          call.name += piece.function?.name ?? "";
          call.arguments += piece.function?.arguments ?? "";
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (event.usage) usage = event.usage;
      }
      if (done) break;
    }
    const totalMs = performance.now() - started;
    const toolCalls = calls.filter(Boolean);
    const measured = { servedModel: served, failovers, ttftMs: ttft == null ? null : Math.round(ttft), totalMs: Math.round(totalMs) };
    if (!text && toolCalls.length === 0) return { ...sample, ...measured, ok: false, kind: "empty", error: "no text" };
    if (!finish && !done) return { ...sample, ...measured, ok: false, kind: "dropped", error: "ended with no finish marker" };
    if (finish === "length") return { ...sample, ...measured, ok: false, kind: "truncated", error: "cut off at the length limit" };
    const badCall = toolCalls.some((c) => {
      try {
        JSON.parse(c.arguments || "{}");
        return false;
      } catch {
        return true;
      }
    });
    if (badCall) return { ...sample, ...measured, ok: false, kind: "tool_parse", error: "tool call arguments were not valid JSON" };
    return {
      ...sample,
      ...measured,
      ok: true,
      pass: prompt.check ? prompt.check(text, toolCalls) : prompt.expect.test(text),
      inTokens: usage?.prompt_tokens ?? null,
      outTokens: usage?.completion_tokens ?? null,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? null,
      ...costOf(router, sentAs, usage),
    };
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    if (timedOut) return { ...sample, ok: false, kind: "timeout", error: `no answer in ${waitMs / 1000} s` };
    return { ...sample, ok: false, kind: "dropped", error: text ? "connection dropped mid-answer" : "connection failed" };
  }
}

// One request, tried again once if it failed before giving any answer. The
// retry is counted on the sample, and a request that fails both times still
// counts as one failure.
async function benchOne(router, model, sentAs, prompt, waitMs) {
  const first = await benchOnce(router, model, sentAs, prompt, waitMs);
  const worthRetrying = !first.ok && (first.kind === "http_5xx" || first.error === "connection failed");
  if (!worthRetrying) return first;
  return { ...(await benchOnce(router, model, sentAs, prompt, waitMs)), retries: 1 };
}

// Prompts from a file, one JSON object per line: { id, type, text or
// messages, expect }. `expect` is a pattern the reply must match.
function loadPrompts(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      const p = JSON.parse(line);
      if (!p.expect || !(p.text || p.messages)) fail(`${file} line ${i + 1}: each prompt needs "expect" and "text" or "messages".`);
      return { id: p.id ?? `prompt-${i + 1}`, type: p.type ?? "custom", text: p.text, messages: p.messages, expect: new RegExp(p.expect, "i") };
    });
}

// Saved results: JSONL (one request per line), or the older { samples } file.
function loadSamples(file) {
  const text = readFileSync(file, "utf8").trim();
  if (text.startsWith("{") && !text.includes("\n{")) {
    try {
      const data = JSON.parse(text);
      if (data.samples) return { samples: data.samples, note: data.note };
    } catch {
      // not one JSON document: read it as JSONL below
    }
  }
  return { samples: text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)), note: null };
}

const BENCH_HELP = `${NAME} bench: the same prompts through Surplus, OpenRouter and Router by Ramp

  ${NAME} bench --live [-m models]     send real requests (costs money, see below)
  ${NAME} bench --fixture <file>       replay saved results: no keys, no network

  -m a,b            models to test, by Surplus's names. "-m shortlist" is the
                    eight-model list in the README. Default: ${DEFAULT_MODEL}
  --quick           three one-line prompts instead of the full set of ten
  --prompts <file>  your own prompts, one JSON object per line:
                    {"id": "...", "type": "...", "text": "...", "expect": "pattern"}
  --runs <n>        repeat every prompt n times (1 to 5, default 1)
  --wait <seconds>  give up on a request after this long (default 60)
  --out <file>      write one JSON line per request (replay it with --fixture)
  --json            print the summary as JSON instead of tables

  Keys: SURPLUS_API_KEY (or your login), OPENROUTER_API_KEY, RAMP_ROUTER_API_KEY.
  A router with no key is skipped. A model a router does not list is skipped.
  The full set on one cheap model costs about a cent; on a frontier model,
  tens of cents. PLUS_SPEND_CAP=<dollars> stops a run before it starts.
`;

async function bench(flags) {
  if (flags.help) return console.log(BENCH_HELP);
  let samples;
  let note = null;
  const skipped = [];
  if (flags.fixture) {
    const loaded = loadSamples(flags.fixture);
    samples = loaded.samples;
    note = loaded.note ?? `Replayed from ${flags.fixture}.`;
  } else if (flags.live) {
    const asked = flags.model ?? DEFAULT_MODEL;
    const models = asked === "shortlist" ? BENCH_MODELS : asked.split(",").map((m) => m.trim()).filter(Boolean);
    const prompts = flags.prompts ? loadPrompts(flags.prompts) : flags.quick ? BENCH_PROMPTS : BENCH_SET;
    const runs = Math.max(1, Math.min(Number(flags.runs ?? 1) || 1, 5));
    const waitMs = (Number(flags.wait ?? 60) || 60) * 1000;
    const routers = benchRouters().filter((r) => {
      if (r.key && r.base) return true;
      skipped.push(r.name);
      return false;
    });
    if (routers.length === 0) fail("No router has a key. Set SURPLUS_API_KEY, OPENROUTER_API_KEY, or RAMP_ROUTER_API_KEY.");
    checkSpendCap();
    for (const r of routers) r.catalog = await catalog(r);
    // Routers run side by side; within a router, one request at a time, so
    // they do not slow each other down.
    const perRouter = await Promise.all(
      routers.map(async (router) => {
        const out = [];
        for (const model of models) {
          const sentAs = routerModel(router, model);
          if (!sentAs) {
            out.push({ router: router.name, model, skipped: "not listed by this router" });
            continue;
          }
          for (let i = 0; i < runs; i++) for (const prompt of prompts) out.push(await benchOne(router, model, sentAs, prompt, waitMs));
        }
        return out;
      }),
    );
    samples = perRouter.flat();
    addSpend(samples.reduce((sum, x) => sum + (x.costUsd || 0), 0));
    note = `Live run, ${new Date().toISOString()}. ${prompts.length} prompts x ${runs} run(s) per model per router.`;
    if (flags.save) writeFileSync(flags.save, JSON.stringify({ note, samples }, null, 2));
  } else {
    fail(
      `bench needs a source.\n  ${NAME} bench --fixture <file>      replay saved results: no keys, no network\n  ${NAME} bench --live [-m models]    send real requests to every router you have a key for (costs a little)\n  ${NAME} bench --help                every flag`,
    );
  }
  if (flags.out) writeFileSync(flags.out, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");

  const rows = benchSummary(samples);
  const skips = samples.filter((s) => s.skipped);
  if (flags.json) return console.log(JSON.stringify({ rows, skips }, null, 2));
  const pct = (v) => (v == null ? "" : `${Math.round(v * 100)}%`);
  const secs = (ms) => (ms == null ? "" : `${(ms / 1000).toFixed(1)} s`);
  console.log(note + "\n");
  console.log(
    table([
      ["ROUTER", "MODEL", "FAILED", "QUALITY", "FIRST TOKEN P50", "P95", "TOKENS/S P50", "P95"],
      ...rows.map((r) => [
        r.router,
        r.model,
        `${r.failures} of ${r.attempts}`,
        pct(r.quality),
        secs(r.ttftP50Ms ?? r.ttftMs),
        secs(r.ttftP95Ms),
        r.tokensPerSecond == null ? (r.ttftMs == null ? "" : "one burst") : Math.round(r.tokensPerSecond),
        r.tokensPerSecondP95 == null ? "" : Math.round(r.tokensPerSecondP95),
      ]),
    ]),
  );
  console.log(
    "\n" +
      table([
        ["ROUTER", "MODEL", "COST", "$ PER 1M TOKENS", "VS LIST", "CACHED INPUT"],
        ...rows.map((r) => [
          r.router,
          r.model,
          r.costUsd == null ? "not reported" : usd(r.costUsd),
          r.perMillionTokensUsd == null ? "" : usd(r.perMillionTokensUsd),
          r.vsListPct == null ? "" : `${r.vsListPct > 0 ? "+" : ""}${r.vsListPct}%`,
          r.cacheSharePct == null ? "" : `${r.cacheSharePct}%`,
        ]),
      ]),
  );
  const types = [...new Set(rows.flatMap((r) => Object.keys(r.byType ?? {})))];
  if (types.length > 1) {
    const cell = (t) => (t?.of ? `${t.pass}/${t.of}` : "-");
    console.log("\nCorrect answers by kind of prompt, out of those that got an answer:\n" + table([["ROUTER", "MODEL", ...types.map((t) => t.toUpperCase())], ...rows.map((r) => [r.router, r.model, ...types.map((t) => cell(r.byType[t]))])]));
  }
  console.log();
  for (const r of rows) {
    if (r.failures) console.log(`${r.router} ${r.model}: ${r.failures} failed (${Object.keys(r.failureKinds).join(", ")}: ${r.errors.join("; ")})`);
    if (r.retries) console.log(`${r.router} ${r.model}: ${r.retries} request(s) retried once`);
    if (r.failovers) console.log(`${r.router} ${r.model}: ${r.failovers} seller change(s) inside the router`);
    if (r.costSource === "catalog") console.log(`${r.router} ${r.model}: cost priced from its model list, since its replies do not report one`);
  }
  for (const s of skips) console.log(`${s.router} ${s.model}: skipped, ${s.skipped}`);
  for (const name of skipped) console.log(`${name}: skipped, no key`);
  console.log("\nCost includes OpenRouter's 5.5% credit fee. VS LIST compares it with the router's own list price for the same tokens.");
  console.log("Quality is the share of answers that pass a fixed check: unit tests for code, the tool call for tool use, required markup for web pages, an exact value for long context.");
}

// ---- entry point ----

const HELP = `${NAME}: Surplus Intelligence from the terminal

  ${NAME} signup                       make a new account, no browser needed
  ${NAME} login [--key inf_...]        save an API key you already have
  ${NAME} topup <dollars>              add credit by card (10 to 2000)
  ${NAME} topup --usdc                 where to send USDC instead
  ${NAME} ask "question" [-m model]    stream an answer, then show its cost
                                      (-m auto: a cheap open-weight model, named on the receipt)
                                      (--wait 90: seconds of silence before giving up)
                                      (--stdin: add piped text to the question)
  ${NAME} compare "question" -m a,b    one question, several models, side by side
  ${NAME} balance                      credit left and money saved
  ${NAME} savings                      what you saved, model by model
  ${NAME} price <model>                cheapest live sellers against list price
  ${NAME} logs [-n 10]                 your recent requests
  ${NAME} models                       a short list: Surplus price next to an Arena quality score
  ${NAME} doctor                       check your setup, one thing at a time
  ${NAME} bench --live [-m a,b]        Surplus, OpenRouter and Ramp, same prompts, side by side
                                      (${NAME} bench --help: the prompt set and every flag)
                                      (--fixture <file>: replay saved results, no keys or network)
                                      (--save <file>: keep a live run to replay later)
  ${NAME} claude [arguments]           Claude Code, running on Surplus
  ${NAME} codex [arguments]            Codex, running on Surplus
  ${NAME} aider [arguments]            aider, running on Surplus
  ${NAME} opencode [arguments]         OpenCode, running on Surplus
  ${NAME} run <program> [arguments]    any other tool, pointed at Surplus
  ${NAME} run --print-env              the settings it uses, and how Cursor and Kilo take them
  ${NAME} update                       install the latest version

  ask retries twice on a failed start. PLUS_SPEND_CAP=<dollars> limits a day's spending by ask, compare and bench.
  Launchers take --model first to pick the model: ${NAME} claude --model glm-5.3

  balance, savings, price, logs and compare take --json for scripts.
`;

async function main() {
  // The launchers pass every later argument through, so they skip our own
  // flag parsing.
  const [first, ...passthrough] = process.argv.slice(2);
  if (LAUNCHERS.includes(first)) return run(first, passthrough);
  if (first === "run" && passthrough[0] === "--print-env") return printEnv();
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
      print: { type: "boolean" },
      quick: { type: "boolean" },
      out: { type: "string" },
      prompts: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help && command === "bench") return bench(values);
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
  if (command === "models") return models(values);
  if (command === "update") return update(values);
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
