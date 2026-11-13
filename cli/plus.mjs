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
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
async function api(path, key = apiKey(), body) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const post = body && {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify(body),
  };
  const res = await fetch(BASE + path, post || { headers });
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

async function balance() {
  const [bal, saved] = await Promise.all([
    api("/v1/payments/balance"),
    api("/v1/buyer/savings?period=all_time"),
  ]);
  const s = saved.summary ?? {};
  console.log(`Credit available  ${usd(dollars(bal.fiat_available_usdc))}`);
  if (Number(bal.usdc_available_usdc) > 0) console.log(`USDC available    ${usd(dollars(bal.usdc_available_usdc))}`);
  console.log(`Spent so far      ${usd(dollars(s.total_actual_usdc))} over ${s.request_count ?? 0} requests`);
  console.log(`At list price     ${usd(dollars(s.total_direct_usdc))}`);
  console.log(`Saved             ${usd(dollars(s.total_saved_usdc))} (${Math.round(s.savings_pct ?? 0)}%)`);
}

// What you saved, model by model.
async function savings() {
  const saved = await api("/v1/buyer/savings?period=all_time");
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
async function price(model) {
  if (!model) fail(`Usage: ${NAME} price <model>   (for example: ${NAME} price gpt-4o-mini)`);
  const market = await api(`/api/markets/${encodeURIComponent(model)}`);
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

async function ask(prompt, flags) {
  if (!prompt) fail(`Usage: ${NAME} ask "your question" [-m model]`);
  const model = flags.model ?? DEFAULT_MODEL;
  const started = performance.now();
  let firstToken = null;
  let usage = null;
  let finished = false; // the model said it was done, or [DONE] arrived

  // The watchdog. Waiting on a silent connection runs no code at all, so
  // nothing in the loop below can notice the silence. A timer can: it is
  // pushed back every time data arrives, and if it ever fires it aborts the
  // request, which makes the waiting fetch or read throw.
  const waitSeconds = Number(flags.wait ?? 90) || 90;
  const request = new AbortController();
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => request.abort(), waitSeconds * 1000);
  };

  const handle = (line) => {
    const event = parseEvent(line);
    if (!event) return;
    if (event === "done") return (finished = true);
    if (event.error) fail(`error inside the stream: ${JSON.stringify(event.error).slice(0, 200)}`);
    const choice = event.choices?.[0];
    if (choice?.delta?.content) {
      firstToken ??= performance.now();
      process.stdout.write(choice.delta.content);
    }
    if (choice?.finish_reason) finished = true;
    if (event.usage) usage = event.usage;
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

    // Read the stream line by line and print text as it arrives. A chunk can
    // end in the middle of a line, so the unfinished part waits in `buffer`.
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      arm();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      lines.forEach(handle);
    }
    handle(buffer + decoder.decode()); // a last line with no line break after it
  } catch (err) {
    if (!request.signal.aborted) throw err;
    if (firstToken) console.log();
    fail(`no data for ${waitSeconds} s, so the request was dropped. Wait longer with --wait <seconds>.`);
  } finally {
    clearTimeout(watchdog); // a timer left running would keep the program alive
  }
  if (!finished) {
    console.log();
    fail("the answer was cut off: the stream ended with no finish marker.");
  }
  const total = performance.now() - started;

  // The receipt: what it cost against the list price for the same tokens.
  const paid = dollars(usage?.buyer_cost_micro);
  const info = await api(`/v1/models/${encodeURIComponent(model)}`).catch(() => null);
  const list = listPrice(info?.pricing, usage);
  const parts = [
    model,
    firstToken ? `first token ${((firstToken - started) / 1000).toFixed(1)} s` : "no text",
    `total ${(total / 1000).toFixed(1)} s`,
    usage ? `${usage.completion_tokens} tokens` : null,
    // Surplus bills in whole millionths of a dollar, so a tiny answer can round to 0.
    usage?.buyer_cost_micro != null ? `cost ${paid === 0 ? "under $0.000001" : usd(paid)}` : null,
    list ? `list ${usd(list)}${paid > 0 ? `, saved ${savedPct(paid, list)}%` : ""}` : null,
  ].filter(Boolean);
  console.log(`\n\n· ${parts.join(" · ")}`);
}

// Start another program with its settings pointed at Surplus. Everything
// after the program's name is passed through untouched.
function run(program, args) {
  if (!program) fail(`Usage: ${NAME} run <program> [its arguments]`);
  const windows = process.platform === "win32";
  // On Windows the program may be a .cmd file, which needs a shell, and a
  // shell takes one command line, with arguments that have spaces quoted.
  const options = { stdio: "inherit", env: { ...process.env, ...surplusEnv(apiKey()) } };
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

// ---- entry point ----

const HELP = `${NAME}: Surplus Intelligence from the terminal

  ${NAME} signup                       make a new account, no browser needed
  ${NAME} login [--key inf_...]        save an API key you already have
  ${NAME} topup <dollars>              add credit by card (10 to 2000)
  ${NAME} topup --usdc                 where to send USDC instead
  ${NAME} ask "question" [-m model]    stream an answer, then show its cost
                                      (--wait 90: seconds of silence before giving up)
  ${NAME} balance                      credit left and money saved
  ${NAME} savings                      what you saved, model by model
  ${NAME} price <model>                cheapest live sellers against list price
  ${NAME} logs [-n 10]                 your recent requests
  ${NAME} claude [arguments]           Claude Code, running on Surplus
  ${NAME} run <program> [arguments]    any tool, pointed at Surplus
`;

async function main() {
  // The launchers pass every later argument through, so they skip our own
  // flag parsing.
  const [first, ...passthrough] = process.argv.slice(2);
  if (first === "claude") return run("claude", passthrough);
  if (first === "run") return run(passthrough[0], passthrough.slice(1));

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
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) return console.log(HELP);
  if (command === "signup") return signup(values);
  if (command === "login") return login(values);
  if (command === "topup") return topup(rest[0], values);
  if (command === "balance") return balance();
  if (command === "savings") return savings();
  if (command === "price") return price(rest[0]);
  if (command === "logs") return logs(values);
  if (command === "ask") return ask(rest.join(" "), values);
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
