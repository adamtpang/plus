# plus: build spec

Status: Locked, 20 November 2026 (CT). Locked against PR #1 head `fdf9963` (which was written against `main` at `50a9639`, then updated for Ramp's Router at router.com). Adam's answers of the same date are applied in section 10. Public sources were re-checked that evening for model ids and first-party list prices; every claim about Surplus, OpenRouter or Ramp's Router links to its source in the Sources section. Anything still not confirmed from a public source is listed under Unknowns rather than guessed.

This document is for the coding session that builds plus. Read "Rules for Claude" before starting.

## 1. What plus is

plus is an unofficial command-line tool for Surplus Intelligence. It runs Claude Code, Codex and other coding tools on Surplus, and prints a receipt after every answer: model, tokens, cost, savings against list price, and latency.

Why: Adam expects token usage to grow a great deal over the next 10 years. If Surplus's discounts hold up in real use, routing through it is an easy saving. plus is how he finds out, by using it day to day and by testing it head to head against OpenRouter and Ramp's Router at router.com. Adam confirmed on Nov 20, 2026 that "router" means Ramp's Router; the test is exactly these three: OpenRouter, Ramp Router, Surplus.

Non-goals:

- Not a Surplus product. It is not made or endorsed by Surplus (README says so; keep it that way).
- No telemetry. plus talks to the provider being used and nothing else.
- No npm publish or release without Adam's explicit go (from `CLAUDE.md`).

## 2. What already exists (v0.2.0, `main` at `50a9639`)

The repo is not empty. Plain Node 18+, no dependencies, tests with `node --test`, CI on Linux, Windows and macOS with Node 18 and 22.

| Command | State today |
|---|---|
| `plus signup` | Makes a wallet locally, signs Surplus's sign-in challenge, swaps it for an `inf_` key. README: tested against a stand-in server and against Surplus "up to the last step"; no real account made yet. |
| `plus login [--key]` | Saves a key after checking it against `GET /v1/payments/balance`. |
| `plus topup <dollars>` / `--usdc` | Stripe link or USDC on Base deposit address. Asks before making a link. |
| `plus ask "q" [-m model] [--stdin] [--wait]` | Streams from `/v1/chat/completions`, prints a one-line receipt. Default model `gpt-4o-mini`. |
| `plus compare "q" -m a,b` | Same prompt to several Surplus models in parallel, table of time, tokens, cost, list, saved. |
| `plus balance`, `savings`, `price <model>`, `logs` | Read endpoints, `--json` supported. |
| `plus doctor` | Node version, key present, key accepted, credit above zero, which launchers are on PATH. |
| `plus claude`, `codex`, `aider`, `opencode`, `run <program>` | Starts the tool with environment or `-c` settings pointed at Surplus. |

Known gaps this spec closes:

1. Wrapped tools (`plus claude`, `plus codex`) print no receipt at all. The receipt only exists for `ask`.
2. The `ask` receipt's list price comes from Surplus's own `/v1/models` pricing, which Surplus says is its own reference figure ([Pricing](https://www.surplusintelligence.ai/docs/marketplace/pricing): "Reference prices come from `PROVIDER_PRICES` in the codebase"). There is no independent list price source or date on the receipt.
3. `listPrice()` ignores cache read and cache write tokens, though `/v1/models` publishes `input_cache_read` and `input_cache_write` prices (checked live on `GET https://api.surplusintelligence.ai/v1/models`, Nov 20, 2026).
4. `plus claude` does not pin `ANTHROPIC_SMALL_FAST_MODEL`. Surplus's Claude Code guide says to pin both slots if you pin one ([Claude Code setup](https://www.surplusintelligence.ai/docs/guides/claude-code-setup)).
5. Only Surplus is supported. No OpenRouter or Ramp Router backend, so no head-to-head test is possible.
6. Keys are stored as plain text in `~/.plus/config.json` (stated in `SECURITY.md`, and written by today's `plus login` and `plus signup`). This conflicts with the locked rule that Surplus keys come from environment variables only. Section 5 specifies the migration.
7. Some field names the code reads from Surplus (`direct_cost_micro`, `upstream_ttfb_ms`, `provider` on request log rows, `savings_pct`) do not appear in Surplus's public docs. See Unknowns.

## 3. Facts from Surplus's public docs that the design depends on

| Fact | Source |
|---|---|
| Inference API is at `https://api.surplusintelligence.ai`. OpenAI-compatible at `/v1`. | [llms.txt](https://www.surplusintelligence.ai/llms.txt) |
| Anthropic Messages API at `/anthropic` (`/anthropic/v1/messages`, `/count_tokens`, `/v1/models`). Model-agnostic: routes by model string. | [Messages](https://www.surplusintelligence.ai/docs/api-reference/messages) |
| Claude Code: `ANTHROPIC_BASE_URL=https://api.surplusintelligence.ai/anthropic`, `ANTHROPIC_AUTH_TOKEN=inf_...`, `ANTHROPIC_API_KEY=""`. Slots `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, plus optional `ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_`, `_HAIKU_`, `CLAUDE_CODE_SUBAGENT_MODEL`. No local proxy needed. | [Claude Code setup](https://www.surplusintelligence.ai/docs/guides/claude-code-setup) |
| The Anthropic skin does not issue x402 challenges; it needs a buyer key with credit. | [Messages](https://www.surplusintelligence.ai/docs/api-reference/messages) |
| Codex: `[model_providers.surplus]` with `base_url = "https://api.surplusintelligence.ai/v1"`, `env_key = "SURPLUS_API_KEY"`, `wire_api = "responses"`. Hosted tools and server-side `previous_response_id` state are not in the first compatibility version. | [Responses](https://www.surplusintelligence.ai/docs/api-reference/responses) |
| Responses requests to a chat-only seller are translated; hosted tools and opaque reasoning items are dropped on that lane. | [Responses](https://www.surplusintelligence.ai/docs/api-reference/responses) |
| Streaming chat usage needs `stream_options: {"include_usage": true}`. `buyer_cost_micro` is present only for a known priced charge and is omitted (not zero) otherwise. Integer microdollars, `1_000_000` = 1 USD. | [Chat completions](https://www.surplusintelligence.ai/docs/api-reference/chat-completions), [Long-running responses](https://www.surplusintelligence.ai/docs/reference/long-running-responses) |
| On the Anthropic wire, `message_start.usage` is a zero placeholder; `message_delta.usage` carries counts when the seller reports them, otherwise `GET /v1/requests/{id}` is authoritative. | [Messages](https://www.surplusintelligence.ai/docs/api-reference/messages) |
| `x-request-id` is on responses; non-streamed responses carry `x-si-buyer-cost-micro`. Routing detail in `x-si-*` headers or a `surplus` body object on long requests (`provider`, `served_by`, `attempts`, `upstream_total_ms`, `truncated`, `adapted_params`, and more). | [Long-running responses](https://www.surplusintelligence.ai/docs/reference/long-running-responses) |
| "Never infer a zero cost from a missing inline value." Reconcile against `GET /v1/requests`. | [llms-full.txt](https://www.surplusintelligence.ai/llms-full.txt) |
| Text offers are priced as a `cost_multiplier` on a reference price. "Saved" is measured against that reference. | [Pricing](https://www.surplusintelligence.ai/docs/marketplace/pricing) |
| Where a model has no live competitor price, the discount is measured against Surplus's own catalog figure. | [Minimum-discount routing](https://www.surplusintelligence.ai/docs/marketplace/minimum-discount-routing) |
| `GET /v1/prices` (no auth) returns each model's reference prices per provider, USD per 1M tokens, with an `updated_at`. Providers listed include `openrouter`. | [Price comparison](https://www.surplusintelligence.ai/docs/api-reference/prices) |
| Minimum discount: `/min{N}/v1` path, `X-Min-Discount` header, or key `min_discount_pct`; strictest wins; fails with `minimum_discount_not_met` rather than routing worse. | [Minimum-discount routing](https://www.surplusintelligence.ai/docs/marketplace/minimum-discount-routing), [Pricing](https://www.surplusintelligence.ai/docs/marketplace/pricing) |
| Rate limits per credential per minute: `completions` 1200; `read` 1200 (covers `/v1/responses` and `/anthropic/*`); `analytics` 300; `filtered_logs` 60; `markets` 180 per IP. Responses carry `X-RateLimit-*`; some 429s carry `Retry-After`. | [llms-full.txt](https://www.surplusintelligence.ai/llms-full.txt), "Rate limits" |
| `GET /v1/requests` takes `limit` (max 200), `cursor`, `from`/`to`, `model`, `provider`, `key_id`, `endpoint` and more. | [llms-full.txt](https://www.surplusintelligence.ai/llms-full.txt) |
| Prompt and response bodies are not stored by default; sellers' upstream providers receive the payload and may log it. | [Security and privacy](https://www.surplusintelligence.ai/docs/marketplace/security-privacy) |
| No cryptographic attestation of which weights served a response; model identity is enforced only where the provider echoes a comparable id. | [Provider verification](https://www.surplusintelligence.ai/docs/marketplace/provider-verification) |
| Secret masking (beta), opt-in via `X-SI-Mask-Secrets: on` or key/account setting. | [Secret masking](https://www.surplusintelligence.ai/docs/guides/secret-masking), [Changelog](https://www.surplusintelligence.ai/docs/reference/changelog) |
| An OpenAPI schema exists at `GET /api/ops/openapi.json`, but a request without an ops token returned `401 ops_forbidden` (checked Nov 20, 2026). | [llms-full.txt](https://www.surplusintelligence.ai/llms-full.txt) |

Surplus's homepage shows marketing figures (for example a 7-day "realized savings" mean discount). These are Surplus's own claims, not measurements, and plus must not repeat them as facts. The head-to-head test exists to measure the real number.

## 3a. Facts from Ramp Router's public docs (router.com)

Ownership check: router.com's own files say "Router is an LLM gateway from Ramp" ([router.com/llms.txt](https://router.com/llms.txt)) and "Router is an LLM routing layer from Ramp" ([docs.router.com/llms.txt](https://docs.router.com/llms.txt)). `https://ramp.com/router` answers `301` to `https://router.com/`, and ramp.com's site navigation lists Router as a product (both checked Nov 20, 2026). So it is Ramp's product.

| Fact | Source |
|---|---|
| One base URL: `https://api.router.com/v1`. Endpoints: `GET /v1/models`, `POST /v1/responses` (OpenAI Responses), `POST /v1/chat/completions` (OpenAI Chat Completions), `POST /v1/messages` and `/v1/messages/count_tokens` (Anthropic Messages). No embeddings, files or batches. | [Endpoint](https://docs.router.com/api/endpoint) |
| So it is both OpenAI compatible and Anthropic compatible. Router recommends Responses for new integrations. | [Endpoint](https://docs.router.com/api/endpoint), [FAQ](https://docs.router.com/resources/faq) |
| Auth: Router API key in `Authorization: Bearer` or `X-Api-Key`. Docs use the env var name `RAMP_ROUTER_API_KEY`. Keys are created at app.router.com/keys and the secret is shown once. | [Endpoint](https://docs.router.com/api/endpoint), [Codex setup](https://docs.router.com/coding-agents/codex) |
| Errors: `401 invalid_api_key` / `api_key_deactivated`, `402` no credit, `404` model not available to key, `429` with `retry-after`, `501` unsupported feature. | [Endpoint](https://docs.router.com/api/endpoint) |
| Headers: echoes or generates `x-request-id` and `x-trace-id`; `X-Router-Provider` names the serving provider. Response `model` is the model that actually served (can differ after a fallback or routing strategy). | [Endpoint](https://docs.router.com/api/endpoint), [Responses and Messages](https://docs.router.com/api/responses-and-messages) |
| Cost: on Responses, `usage.cost` in USD (streaming: `response.usage.cost` on the final event). Includes caching and service tier pricing, does not reflect promotional pricing, omitted (not zero) when Router cannot price it. Actual charge is in Logs. `usage.cost` is not included on `/v1/messages` and not available on `/v1/chat/completions`. | [Responses and Messages](https://docs.router.com/api/responses-and-messages) |
| Claude Code: in `~/.claude/settings.json` `env`: `ANTHROPIC_BASE_URL=https://api.router.com`, `ANTHROPIC_AUTH_TOKEN=<router key>`, `ANTHROPIC_CUSTOM_HEADERS=X-Gateway-Client: claude-code`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000`. Do not set `ANTHROPIC_API_KEY`. Needs Claude Code 2.1.118 or newer. Through Router, Claude Code runs Claude models only. | [Claude Code setup](https://docs.router.com/coding-agents/claude-code) |
| Codex: `[model_providers.ramp-router]` with `base_url = "https://api.router.com/v1"`, `env_key = "RAMP_ROUTER_API_KEY"`, `wire_api = "responses"`, `supports_websockets = false`. A key file read by an `auth` command is the documented alternative. | [Codex setup](https://docs.router.com/coding-agents/codex) |
| An optional "Router installer" (the Ramp CLI) makes the same changes and adds a Claude Code status line with cost and savings. Manual setup needs nothing installed. | [Claude Code setup](https://docs.router.com/coding-agents/claude-code), [FAQ](https://docs.router.com/resources/faq) |
| Pricing: no platform or access fee. Through Dec 31, 2026 routing is free with Router keys and with your own provider keys. From Jan 1, 2027: listed model price with no token markup, and a 2% fee on traffic using your own keys. $500 in model credits per company, "subject to offer terms". | [router.com/faq](https://router.com/faq), [router.com/llms.txt](https://router.com/llms.txt) |
| Requests default to US-only inference; some providers charge a US processing premium (Anthropic +10%, Google Vertex AI +10%, xAI +10%, Fireworks +50%, Amazon Bedrock +10%). | [FAQ](https://docs.router.com/resources/faq) |
| Cost-efficient routing (Flex service tier) is on by default; per request `allow_flex_tier: false` turns it off. Router can also fall back to another model or provider. | [Cost-efficient routing](https://docs.router.com/strategies/cost-efficient-routing), [Responses and Messages](https://docs.router.com/api/responses-and-messages) |
| Router's dashboard "Savings" compares against, among other baselines, the highest-priced provider of the same model; it is not the same measure as plus's independent list price. | [Monitor and debug](https://docs.router.com/guides/monitor) |
| Data: Ramp-side content recording (inputs, outputs, tool calls) is on by default and kept for 1 year; it can be turned off in Settings, which does not delete existing archives. | [FAQ](https://docs.router.com/resources/faq), [Monitor and debug](https://docs.router.com/guides/monitor) |
| Accounts are for businesses only. Direct or Google signup needs a business email and domain (Gmail, Outlook and similar are refused); "Sign in with Ramp" or manual onboarding via router@ramp.com are the other paths. Not being a Ramp customer is fine. | [Signup eligibility](https://docs.router.com/resources/signup-eligibility) |
| Requests are screened against usage policy categories; a violation can deactivate the key, and retries by coding agents can count as several strikes. | [FAQ](https://docs.router.com/resources/faq) |

OpenRouter facts used below: Claude Code via `ANTHROPIC_BASE_URL=https://openrouter.ai/api` ([guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md)); Codex via `base_url = "https://openrouter.ai/api/v1"` ([guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli.md)); `usage.cost` on every response ([Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md)); no inference markup, 5.5% ($0.80 minimum) fee on credit purchases ([FAQ](https://openrouter.ai/docs/faq.md)).

## 4. CLI commands

Existing commands keep their names and behaviour unless a step below changes them. New or changed:

| Command | What it does |
|---|---|
| `plus claude [args]` | As today, plus: pins both Claude Code slots when `-m`/config sets a model, and prints a session receipt when Claude Code exits (section 6). |
| `plus codex [args]` | As today, plus a session receipt on exit. |
| `plus ask "q" [-m model] [--via surplus\|openrouter\|ramp]` | `--via` picks the backend; default `surplus`. `ramp` is Ramp's Router. Receipt format from section 7. |
| `plus receipt [request-id\|--last\|--session <id>]` | Reprints a receipt for one request or one wrapped session, from local records plus the provider's log. |
| `plus receipts [--follow] [-n 20] [--json]` | Lists recent receipts from `~/.plus/receipts.jsonl`. `--follow` tails it, so Adam can watch costs in a second terminal while Claude Code runs. |
| `plus login [--key]` | Checks a Surplus `inf_` key against `GET /v1/payments/balance`, then prints an `export SURPLUS_API_KEY=...` line (and a one-line note to add it to the shell profile). Does not write the key to disk. See section 5. |
| `plus signup` | May still exist for Surplus, but it must not write an API key to `config.json`; print the same export line. plus never signs up for OpenRouter or Ramp Router, and never signs up as part of a bench. |
| `plus listprice refresh` | Optional. Fetches Surplus `GET /v1/prices` only when the user passes an explicit flag (off by default). Does not overwrite the frozen first-party list prices in the repo (section 7). |
| `plus bench plan [suite]` | Prints the run matrix, the model-id map, which providers will run or be skipped, and an estimated maximum cost against the $10 hard cap. Default suite is `default`. Makes no paid calls. |
| `plus bench run [suite] [--providers surplus,openrouter,ramp] [--budget <dollars>] [--dry-run]` | Runs the head-to-head test (section 8). Default budget is the $10 hard cap; `--budget` may only lower it. Live runs need a typed confirmation. `--dry-run` (and the fixture path used in tests) spends nothing and makes no live calls. If `RAMP_ROUTER_API_KEY` is missing, Ramp Router is skipped with a clear message and the run continues on the other providers. |
| `plus bench report <run-id> [--json\|--md]` | Summarises a finished run. |
| `plus doctor` | Also checks each backend key from the environment (without printing it), warns if `~/.plus/config.json` still contains a key field, checks the list price file date, and checks that `~/.plus` is not inside a git repo. |

All commands that print money take `--json`. All exit non-zero on failure.

## 5. Config

- Directory: `~/.plus/` (override with `PLUS_HOME`). Files:
  - `config.json`: non-secret settings only (default model per backend, small/fast model, receipt options). It must never contain an API key.
  - `receipts.jsonl`: one JSON line per answer or session. No prompt or answer text, only the receipt fields.
  - `bench/ledger.json` (or equivalent): running paid-spend ledger for the $10 hard cap, across all paid bench runs. No keys, no prompt text.
  - `bench/<run-id>/`: raw results of each bench run.
- Frozen list prices live in the repo, not only under `~/.plus/`: a committed `listprices.json` (or `bench/listprices.json`) with first-party prices, source URL, and fetch date (section 7). A user-level cache may exist for the optional Surplus `/v1/prices` refresh; it must not replace the frozen first-party entries unless the user asks.
- Environment variables (the only source of keys):
  - `SURPLUS_API_KEY`, `SURPLUS_BASE_URL` (existing).
  - `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`, from [OpenRouter Codex CLI guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli.md)).
  - Ramp Router: `RAMP_ROUTER_API_KEY` (the name Router's own docs use) and `RAMP_ROUTER_BASE_URL` (default `https://api.router.com/v1`, from [Endpoint](https://docs.router.com/api/endpoint)). If `RAMP_ROUTER_API_KEY` is unset, Ramp Router features and bench cells are skipped; plus does not prompt to sign up.
  - `PLUS_HOME`.
  - Optional: `PLUS_BENCH_CAP` (dollars, default `10`). May only lower the hard cap, not raise it.
- Keys (locked, Nov 20, 2026): environment variables only. No `~/.plus/config.json` for keys.
  - This conflicts with v0.2.0: `plus login` and `plus signup` currently write `apiKey` to `~/.plus/config.json` (mode 600), and commands fall back to `readConfig().apiKey` when `SURPLUS_API_KEY` is unset. `signup` may also write a wallet private key to that file; that path is not used by the bench, and this lock does not redesign wallet storage, but the Surplus API key itself must not be written or read there.
  - Migration: `plus login` still checks the key against `GET /v1/payments/balance`, then prints `export SURPLUS_API_KEY=<key>` (and a one-line note to add it to the shell profile) and exits 0. It does not write the key to any file. `plus signup`, if kept, prints the same export line and does not write `apiKey`. Commands and `doctor` read Surplus keys only from `SURPLUS_API_KEY`. If `config.json` still has an `apiKey` field from an earlier version, ignore it, do not use it, and have `doctor` (and any command that notices the field) warn: move the key to `SURPLUS_API_KEY` and remove the field from the file. Do not delete the field automatically.
  - Never write OpenRouter or Ramp Router keys to disk from plus; env only. plus never edits `~/.claude/settings.json` or `~/.codex/config.toml`; it sets settings for the child process only (env and Codex `-c`), so Adam's normal setup is untouched. OS keychain storage stays out of scope unless Adam later says yes. On Linux it may need a tool that is not installed by default.
  - Keys are never printed in receipts, logs, help, errors, `receipts.jsonl` or bench output (the `login` export line is the one deliberate exception, written only to stdout for the user to copy). Keys are never passed on a command line (they would show in process lists). Child processes get them through the environment only. Note: the existing Codex launcher puts no key on the command line (it uses `env_key`); keep it that way. The existing opencode launcher puts the key inside `OPENCODE_CONFIG_CONTENT`, which is an environment variable; acceptable, but do not log it.
  - `.gitignore` already covers `.env` and `.env.*`. Add a test that fails if any committed file matches an `inf_` or `sk-or-` key pattern (Router's key format is not documented publicly, see Unknowns).

## 6. Wrapping Claude Code and Codex

Both are supported by Surplus's own public docs, so plus only sets what the docs say.

Claude Code (documented in [Claude Code setup](https://www.surplusintelligence.ai/docs/guides/claude-code-setup)):

- Set `ANTHROPIC_BASE_URL=<base>/anthropic`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_API_KEY=""` (current code does this).
- When the user gives `-m <model>` to plus or has `claude.model` in config, set `ANTHROPIC_MODEL`. Always also set `ANTHROPIC_SMALL_FAST_MODEL` (config `claude.smallFastModel`) when the main model is pinned. Do not set role-specific overrides unless configured.
- For `--min <N>`, use `ANTHROPIC_BASE_URL=<base>/anthropic/min<N>` (documented).
- OpenRouter (`plus claude --via openrouter`): `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY=""` ([OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md)).
- Ramp Router (`plus claude --via ramp`): `ANTHROPIC_BASE_URL=https://api.router.com` (no `/v1`), `ANTHROPIC_AUTH_TOKEN=$RAMP_ROUTER_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS=X-Gateway-Client: claude-code`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000`, and `ANTHROPIC_API_KEY` removed from the child environment rather than blanked, since Router's guide says not to set it ([Router Claude Code setup](https://docs.router.com/coding-agents/claude-code)). `doctor` warns if `claude --version` is below 2.1.118, and `plus claude --via ramp -m <non-Claude model>` refuses with a clear message, since Router serves Claude Code with Claude models only. plus does not use the Ramp CLI installer (no installs).

Codex (documented in [Responses](https://www.surplusintelligence.ai/docs/api-reference/responses)):

- Current `-c model_providers.surplus.*` settings with `wire_api=responses` match the doc. Keep.
- Hosted tools and `previous_response_id` state are not supported by Surplus yet; `plus doctor` should say so when Codex is found.
- OpenRouter (`plus codex --via openrouter`): `-c` settings for a provider with `base_url=https://openrouter.ai/api/v1`, `env_key=OPENROUTER_API_KEY` ([OpenRouter Codex guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli.md); it notes model catalog fetch needs the command-based auth form, so expect an "Unknown model" warning with `env_key`).
- Ramp Router (`plus codex --via ramp`): `-c` settings `model_provider=ramp-router`, `model_providers.ramp-router.base_url=https://api.router.com/v1`, `env_key=RAMP_ROUTER_API_KEY`, `wire_api=responses`, `supports_websockets=false` ([Router Codex setup](https://docs.router.com/coding-agents/codex)).

Session receipts for wrapped tools:

plus does not see the traffic, because the tool talks to Surplus directly. Two ways to get receipts, built in this order:

- A. After the child exits (default, Surplus): record the start time, then read `GET /v1/requests?from=<start>&to=<end>` (filtered by `key_id` if known) and print one session receipt: request count, model(s), tokens in/out/cache, total cost, total list cost, savings, median and p90 latency. Append it to `receipts.jsonl`. This depends on the buyer key being allowed to read the request log, which is unclear (see Unknowns U1). If it is not allowed, print what is known and say plainly that the cost could not be read, never print $0.
- For OpenRouter and Ramp Router, no public request log API was confirmed for plus to read after a session (OpenRouter documents a generation lookup by id; Router documents a Logs page in its dashboard). So for those two, a session receipt needs method B, or says plainly that only a dashboard total is available.
- B. Optional, behind `plus claude --live-receipts`: a loopback proxy on `127.0.0.1` that forwards bytes unchanged to the chosen backend, reads usage from the final stream events and `x-request-id`, and appends one receipt per request to `receipts.jsonl`. It must not print into the tool's terminal (it would corrupt the interface); Adam watches with `plus receipts --follow`. Build B only after A works and Adam says yes, because Surplus's docs present the no-proxy setup as the intended path.

## 7. Receipt format

Printed after every `ask` answer, after every wrapped session (summary), and stored in `receipts.jsonl`.

One-line form (values shown as placeholders, not real numbers):

```
· <model> via <served provider> · first token <s> s · total <s> s · in <n> / out <n> / cache <n> tokens
· paid <$> · list <$> (<source>, <date>) · saved <pct>% · req <request-id>
```

Fields and where each comes from:

| Field | Source | Rule |
|---|---|---|
| backend | plus | `surplus`, `openrouter` or `ramp` (Ramp Router). |
| model | request, and served model if the provider reports one (Ramp Router's response `model` is the serving model) | Show requested model; if served model differs, show both and flag it. |
| served provider | Surplus `x-si-provider-family` header or `surplus.provider`; OpenRouter `provider` field if returned; Ramp Router `X-Router-Provider` header or `provider` field | Omit if unknown. |
| tokens in, out, cache read, cache write, reasoning | `usage` from the provider | Missing means unknown, not zero. |
| paid | Surplus `usage.buyer_cost_micro` or `x-si-buyer-cost-micro`, else request log; OpenRouter `usage.cost` ([Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md)); Ramp Router `usage.cost` on Responses only, labelled "priced, before promotions" because Router says it does not reflect promotional pricing ([Responses and Messages](https://docs.router.com/api/responses-and-messages)) | If unknown, print "cost unknown" and leave out savings. Never print $0 for unknown. On Ramp Router `/v1/messages` and `/v1/chat/completions` (so Claude Code via Router) cost is not returned inline and shows as unknown. |
| list | independent list price (below) times the token counts, including cache rates | Always show the source name and the date the price was fetched. |
| saved | `1 - paid / list` | Only when both are known. Can be negative; show it if so. |
| provider's own saving | Surplus reference price (`/v1/models` pricing); Ramp Router dashboard Savings if ever exposed | Shown in `--json` only, as `provider_reference_list`, separate from the independent list price, because each provider measures "saved" against a different baseline. |
| first token, total | measured by plus on the client with `performance.now()` | Label as client-measured. |
| request id | `x-request-id` (Surplus, Ramp Router, plus Router's `x-trace-id`); generation id (OpenRouter) | Always kept so the charge can be reconciled later. |

List price source (locked, Nov 20, 2026):

- Default: the model makers' own pricing pages, frozen in a committed `listprices.json` with the source URL and the fetch date. For this bench that is Anthropic for Claude and Moonshot (Kimi API platform) for Kimi. Do not invent any figure; an entry without a URL and date is invalid and the receipt says "list price unknown".
- Frozen entries, read 20 November 2026 (CT):
  - Claude Opus 5.5, from [Anthropic model pricing](https://platform.claude.com/docs/en/about-claude/pricing): input $4 / MTok, output $20 / MTok, 5-minute cache writes $5 / MTok, 1-hour cache writes $8 / MTok, cache hits and refreshes $0.20 / MTok.
  - Kimi K3 (`kimi-k3`), from [Kimi / Moonshot model inference pricing](https://platform.kimi.ai/docs/pricing/chat): input $3.00 / MTok, output $15.00 / MTok, cached input $0.30 / MTok, 5-minute cache writes $3.00 / MTok, 1-hour cache writes $6.00 / MTok. (The pricing markdown table is empty in the static doc; these figures are the rows rendered on that page for `kimi-k3`.)
- Surplus `GET /v1/prices` is optional and off by default. `plus listprice refresh` only runs it when explicitly requested. If used, label the figure "list via Surplus /v1/prices, <updated_at>" and do not silently replace the frozen first-party entry.
- Fee adjustments, in bench reports only and always labelled:
  - OpenRouter: credit purchase fee, 5.5% with a $0.80 minimum ([OpenRouter FAQ](https://openrouter.ai/docs/faq.md)); no inference markup per the same page.
  - Ramp Router: no platform fee and free routing through Dec 31, 2026; from Jan 1, 2027 listed model price with no token markup and a 2% fee on own-key traffic ([router.com/faq](https://router.com/faq)). The report shows Router cost two ways: as measured (during the free period) and with the documented 2027 terms applied, labelled as a projection. The $500 starter credit is a promotion and is never counted as a saving. If Router serves a provider at its US processing premium ([FAQ](https://docs.router.com/resources/faq)), that is part of the measured cost and is noted.
  - Surplus: card top-ups carry a Stripe fee (see `plus topup`); apply it from the balance endpoint's published fee fields. Costs of funding with USDC (for example network fees) are not known to plus and are reported as not included.

## 8. Head-to-head test plan

Goal: answer "does Surplus actually save money without costing quality, speed or reliability?" against OpenRouter and Ramp's Router (router.com). These are the three providers. Ramp Router is optional until Adam has a key (section 10).

### Models (locked, Nov 20, 2026)

Two models, both listed on all three public catalogs on 20 November 2026 (CT):

| Bench name | Surplus id (`GET https://api.surplusintelligence.ai/v1/models`) | OpenRouter id (`GET https://openrouter.ai/api/v1/models`) | Ramp Router documented id ([supported models](https://docs.router.com/supported-models.md); [choose a model](https://docs.router.com/guides/choose-a-model.md)) |
|---|---|---|---|
| Kimi K3 (open-weight) | `kimi-k3` | `moonshotai/kimi-k3` | `kimi-k3` |
| Claude Opus 5.5 (current Claude frontier) | `claude-opus-5.5` | `anthropic/claude-opus-5.5` | `claude-opus-5-5` |

Claude Opus 5.5 is the current generally available Claude frontier model on Anthropic's pricing page (input $4 / MTok, output $20 / MTok). All three catalogs also list Claude Sonnet 5.5, Claude Fable 5.2, and other Claude ids; those are not the locked bench models. Do not silently substitute `kimi-k3-fast-api`, `kimi-k3.1-pro`, `:batch` ids, or a Fast / flex tier.

Ramp Router note: the supported-models page says display labels are not necessarily valid request ids, and that `GET /v1/models` is authoritative for the caller's key. Unauthenticated `GET https://api.router.com/v1/models` returned 401, so the Router column above is the documented public id, not a live per-key confirmation. When `RAMP_ROUTER_API_KEY` is present, `plus bench plan` must confirm the callable id from that key's catalog and record it. If that catalog lacks Kimi K3 or Claude Opus 5.5, skip the missing model on Router with a clear message; do not pick a stand-in.

Store the map in `bench/models.json`. At plan time, re-check Surplus and OpenRouter public lists (and Router when a key is present) and record each provider's id string on every raw row.

### Budget (locked, Nov 20, 2026)

Hard cap: $10.00 total across all paid bench runs, not just one invocation.

- Default `--budget` is `10`. The flag may only lower the cap. Raising it needs a later yes from Adam. `PLUS_BENCH_CAP` follows the same rule.
- Keep a running ledger of actual paid spend (including failed requests and capped retries) under `~/.plus/bench/ledger.json`. `plus bench plan` and `plus bench run` print spent-so-far, remaining, and the estimated maximum for this run.
- Before every paid call, estimate the cost of that call at the frozen Claude Opus 5.5 list price (the expensive model) using the prompt's estimated input tokens and `max_tokens` for output. If that estimate would push the ledger over the remaining cap, refuse the call, do not send it, and stop cleanly with a message that names the cap and the remaining budget. Do not hide the refusal as a quality zero.
- `--dry-run` and the fixture path used in tests spend nothing, need no live keys, and make no network calls to the three products. `plus bench plan` also makes no paid calls (public model-list fetches, if any, are not billed inference).
- Live `plus bench run` still requires a typed confirmation. Dry-run and fixtures do not.

### Default run size and math

The default suite is `default` (committed under `bench/suites/`). It is sized so a full 3-product x 2-model run fits well under $10 even if every request is billed at Claude Opus 5.5 list prices (a conservative overestimate, because Kimi K3 list is cheaper). Prompts are public material only, no secrets, no private or sensitive text (see section 8a).

Default matrix:

- 8 single-turn prompts: 3 short checkable answers, 2 small coding tasks with local unit tests, 1 single-turn tool-use (valid JSON tool calls, not a Claude Code session), 1 strict format / schema, 1 short refactor.
- 2 cold runs (unique nonce at the start of the system prompt) plus 1 warm-cache pass of the same prompts: 3 passes.
- 3 products x 2 models, when all keys are present.
- `max_tokens = 1024`. Temperature 0, or the lowest the model accepts. Streaming on.
- Each frozen prompt must be at most 2,000 input tokens at plan time (including the nonce and any tool schema). If a prompt is over that, `bench plan` and `bench run` refuse until it is cut, so the math stays honest.

Request count when all three products run: 3 x 2 x 8 x 3 = 144.

Worst-case estimated cost, every request at Claude Opus 5.5 list, input at the 2,000-token ceiling, output at `max_tokens` 1,024, no cache discount on the estimate (the warm pass may be cheaper in reality; the estimate must not rely on that):

- Per request: (2,000 x $4 + 1,024 x $20) / 1,000,000 = $0.008 + $0.02048 = $0.02648
- 144 requests: 144 x $0.02648 = $3.81312

OpenRouter's credit-purchase fee (5.5%, $0.80 minimum, [OpenRouter FAQ](https://openrouter.ai/docs/faq.md)) is labelled in the report. plus does not buy credits. If that fee is applied only to the OpenRouter third (48 requests, $1.27104 at this estimate), 5.5% is $0.07. The $0.80 minimum would matter only if Adam had to buy a new credit bundle, which plus must not do. Ramp Router routing is free through 31 December 2026 per the public FAQ; the documented 2% own-key fee from 1 January 2027 is a labelled projection in the report and is not counted against the $10 cap. Surplus card/USDC funding fees are also labelled and are not incurred by the bench itself.

Planned maximum charged under current public terms: about $3.81, well under $10, with about $6.19 of headroom. If Ramp Router is skipped: 2 x 2 x 8 x 3 = 96 requests, about $2.54.

The larger suites sketched earlier (20 short + 10 code + 3 agent tasks, 5 runs in 3 time windows, 15 passes per cell) cannot fit under the $10 cap. At the same Claude list and token ceilings, 30 API prompts x 15 passes x 3 products x 2 models = 2,700 requests, about $71.50, and a Claude Code `agent` suite is unbounded. Those suites stay out of the default run. They may be added later only if Adam raises the cap. `plus bench plan` on such a suite must say it exceeds the cap and refuse to start a live run.

### Fairness rules

- Same machine, same network, same time window, interleaved: for each run, the order of providers is shuffled, so no provider always goes first.
- Same model on every provider that actually runs it, using the id map above. A model is only compared across the providers that list it and that have a key.
- Same request: same messages, `max_tokens`, temperature 0 (or the lowest the model accepts), streaming on, same tools if any.
- Caching: cold runs use a unique nonce; the warm-cache pass is reported separately, since cache prices and cache routing differ by provider.
- Same wire: the default suite uses the OpenAI Responses API on all three, because Ramp Router returns `usage.cost` only on Responses and recommends it, and Surplus and OpenRouter both serve Responses ([Surplus Responses](https://www.surplusintelligence.ai/docs/api-reference/responses), [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md)). Note that Surplus may bridge Responses to a chat-only seller; record it when reported.
- Same model, no substitution: on Ramp Router send `allow_flex_tier: false` and no fallback `models` list, and drop any answer whose served `model` differs from the requested one from the same-model comparison (count it under reliability). Surplus at default routing; OpenRouter at default provider routing.
- Second, labelled variant ("each at its best") is not part of the default $10 run (it would add requests). It may be added later under the same cap only if the plan still fits, otherwise it waits.
- Record what actually served the request (Surplus served provider; OpenRouter provider; Ramp Router `X-Router-Provider` and served `model`). Note: Surplus lists `openrouter` among its providers ([Price comparison](https://www.surplusintelligence.ai/docs/api-reference/prices)), so some Surplus requests may be served through OpenRouter; report that share.

### Provider skip

If `OPENROUTER_API_KEY` or `SURPLUS_API_KEY` is missing, `plus bench run` (live) exits 1 with a message naming the missing env var and does not start. Adam has those accounts. If `RAMP_ROUTER_API_KEY` is missing, print a clear message that Ramp Router is skipped because no key is set, and continue with Surplus and OpenRouter. plus never signs up for any product, never opens a signup page, and never prompts Adam to create a Router account.

Metrics:

| Metric | How |
|---|---|
| Cost | Provider-reported charge per request, summed per cell; plus effective cost including top-up or markup fees, labelled. |
| Saving | Against the independent list price (section 7), per request and total. |
| Latency | Client-measured time to first token and total time; report p50 and p90. |
| Quality | Automatic checks only for the score: pass rate on `short` and `code`, tests passing on `agent`. Adam does a blind spot check of 20 random `short` answers per provider (provider names hidden) to catch checker errors; the spot check is reported, not mixed into the score. No model-as-judge scoring in v1. |
| Reliability | Error rate (non-2xx, Ramp Router `501` unsupported-feature errors, served-model substitutions, error in stream, `200` with an error body per [Long-running responses](https://www.surplusintelligence.ai/docs/reference/long-running-responses)), timeouts, truncated answers, 503 no-seller errors, retries. Every failure counted, not dropped. |
| Model identity | Flag answers that self-identify as a different model or whose tokenizer counts differ sharply from other providers for the same prompt; report, do not conclude. |

Output: `bench report` writes a Markdown table per model (provider rows, the metrics above, number of runs, dates and times in CT) and the raw JSONL. Every number in the report traces to a raw row.

## 8a. Terms for the bench

This is not legal advice. It is a short rule list drawn from the public terms read on 20 November 2026. None of the three consumer or Router terms expressly forbids benchmarking or publishing comparison results by name. They do restrict scraping, building a competing service, red teaming, and (for Surplus and OpenRouter) multiple accounts.

For any bench or live call:

- Use each product's documented paid API only, inside published rate limits and the $10 spend cap. Do not scrape marketing pages, model catalogs, or dashboards.
- Do not include jailbreak, prompt-injection, or other adversarial red-team prompts. Surplus and OpenRouter both require prior written approval for that kind of testing.
- Use one legitimate account per service. plus never creates accounts. Surplus allows more than one account when reasonably necessary for legitimate use, but not to evade limits. OpenRouter forbids a single user creating multiple accounts "for purposes of bypassing or circumventing use limits on the Site or Service or for any other reason."
- Stay on the documented API paths in this spec. Do not bypass rate, spend, or safety controls.
- Ramp Router records prompt and response content for 1 year by default, and the user can opt out in [Router Settings](https://app.router.com/settings) ([Monitor and debug](https://docs.router.com/guides/monitor.md)). Adam does not have a Router account yet, so plus cannot change that setting. Bench prompts and fixtures must contain nothing sensitive: no secrets, no personal data, no private code, no customer material. plus does not automate signup or settings changes.
- Publishing a report is not expressly forbidden in those three documents, and it is also not expressly allowed. Model-provider terms still apply and were not fully reviewed here. Do not treat this section as a license.

Sources: [Surplus Terms](https://www.surplusintelligence.ai/terms-of-service) and [AUP](https://www.surplusintelligence.ai/acceptable-use-policy) (14 November 2026); [OpenRouter Terms](https://openrouter.ai/terms) (31 August 2026); [Ramp Router Terms](https://ramp.com/legal/developer-terms/developer-terms/router-terms-of-service) (31 August 2026). `https://www.surplusintelligence.ai/terms` and `https://router.com/terms` 404.

## 9. Build steps (in order) with acceptance criteria

Each step is one PR. Tests first: write the test, watch it fail, then change the code (`CLAUDE.md`). Tests use pretend servers on localhost and never need a real key or spend money.

1. Receipt core
   - Pull the receipt into one function that takes usage, cost, list price entry, timings and ids and returns the line and the JSON record.
   - Accept: unit tests for cache tokens priced at cache rates; unknown cost prints "cost unknown" and no saving; negative saving is shown; list price without URL and date gives "list price unknown"; no key or prompt text in the record.
2. List prices
   - Commit frozen first-party entries (Claude Opus 5.5 and Kimi K3, 20 November 2026, URLs and dates in section 7). `plus listprice refresh` is optional and off by default; when used it only labels Surplus `GET /v1/prices` and does not overwrite the frozen entries.
   - Accept: receipt shows source and date from the frozen file; a test with a pretend `/v1/prices` only applies after an explicit refresh flag; an entry without URL and date prints "list price unknown".
3. `receipts.jsonl` and `plus receipts` / `plus receipt`
   - Accept: `ask` appends one line per answer; `--follow` prints new lines; file contains no secrets (test scans it).
4. Claude Code slots
   - `-m` and config pin `ANTHROPIC_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` together; `--min N`.
   - Accept: launcher tests for the exact environment; `ANTHROPIC_API_KEY` is always empty.
5. Session receipts (method A)
   - Accept: with a pretend server, `plus claude` and `plus codex` print a session summary after the child exits; when the request log read is refused, the message says cost could not be read and exits with the child's code.
6. Backends (exactly three)
   - A small backend table with one adapter each: `surplus` (`/v1` and `/anthropic`), `openrouter` (`https://openrouter.ai/api/v1`, Claude Code at `https://openrouter.ai/api`), `ramp` (`https://api.router.com/v1`, Claude Code at `https://api.router.com`). Each adapter declares: base URLs, key env var, how to read paid cost, served model and served provider, and the Claude Code and Codex launch settings from section 6. `ask --via` and `claude`/`codex --via`.
   - Accept: pretend servers for each; Surplus `buyer_cost_micro` (microdollars) mapped; OpenRouter `usage.cost` mapped; Ramp Router `usage.cost` (USD) mapped on Responses, and cost shown as unknown on Router Messages and Chat Completions; Router `X-Router-Provider` and served `model` captured; Router `401 api_key_deactivated` shown with Router's message and no retry loop (Router counts retried violations as strikes); keys for all three backends, including Surplus, read only from the environment; a missing `RAMP_ROUTER_API_KEY` skips Ramp with a clear message; launcher tests check the exact child environment and that `ANTHROPIC_API_KEY` is absent for `ramp` and empty for the other two.
7. Bench plan and run
   - `bench plan`, `bench run` with the $10 hard cap, a persistent ledger, estimate-before-call refusal, typed confirmation on live runs, shuffled order, nonce for cold runs, and `--dry-run` / fixture mode that spends nothing.
   - Accept: with pretend servers, the default matrix is 144 requests when all three providers are present (8 prompts x 3 passes x 3 providers x 2 models), or 96 when Ramp is skipped; a fixture run with no keys and no network exits 0 and writes a table and JSONL; a missing Router key skips Ramp and still exits 0; the ledger refuses the next call when its Claude-list estimate would exceed the remaining cap, including a case where the cap is already spent; `--budget 11` (or any value above 10) is rejected; `plan` makes no paid call and prints the $3.81 worst-case math (or the live numbers from the frozen prices and the actual prompt token counts, which must be at or under $3.81 at the ceilings in section 8).
8. Bench report
   - Accept: report built only from raw rows; p50/p90 and error rate computed in tests on fixed data; times in CT.
9. Doctor and security checks
   - Accept: doctor reports each backend key present or missing from the environment without printing it; it warns if `config.json` still contains a key field and does not use that field; a test fails if any tracked file contains a key pattern; doctor warns if `PLUS_HOME` is inside a git work tree.
10. Docs, login migration, and terms
   - README and SECURITY.md updated for env-only keys, the new commands, backends and stored files. `plus login --help` describes the export-line behaviour.
   - Accept: no em dashes (test greps the repo); every limit stated honestly; `login` against a pretend balance endpoint prints an export line and leaves `config.json` without an `apiKey`.

Later, only with Adam's yes: live receipts proxy (method B), OS keychain storage, raising the $10 cap, and the larger non-default bench suites. The actual paid default run also waits for Adam's confirmation at run time, after the code is built and `plan` has printed the estimate.

## 10. Decisions (Adam, 20 November 2026)

Every earlier open question is resolved. There is no open-question list left in this locked spec.

1. "router" is Ramp's Router at router.com. Verified against router.com and Ramp's pages, see section 3a. (Already answered in `fdf9963`.)
2. Models: Kimi K3 (open-weight) and Claude Opus 5.5 (current Claude frontier). Both are on all three public catalogs; ids and the Router per-key caveat are in section 8. Paid test budget: hard cap $10 total across all paid runs, enforced in code, with dry-run / fixture mode that spends nothing. Default run size and the $3.81 worst-case math are in section 8.
3. List prices: default source is the model makers' own pricing pages (Moonshot / Kimi API platform for Kimi, Anthropic for Claude), frozen with a date in the repo. Surplus `/v1/prices` is optional and off by default.
4. Optional live receipts proxy (method B) stays out of scope until Adam later says yes.
5. Surplus key: environment variables only. No `~/.plus/config.json` for keys. This conflicts with v0.2.0 `login` / `signup`; the migration is in section 5 (`login` prints the export line and does not write the key).
6. Adam has OpenRouter and Surplus accounts. He does not have router.com yet (needs a business email; Gmail was refused). Ramp Router is optional: the bench skips it cleanly, with a clear message, when `RAMP_ROUTER_API_KEY` is missing. plus never signs up for anything. Router self-serve signup still requires a business email and domain ([signup eligibility](https://docs.router.com/resources/signup-eligibility.md)).
7. Do not block the bench on turning off Ramp content recording. Router stores prompts and outputs for 1 year by default ([Monitor and debug](https://docs.router.com/guides/monitor.md)). Adam can opt out in Settings once he has an account; plus does not change that setting. Bench prompts must contain nothing sensitive (section 8a).
8. Do not wait for 1 January 2027. Run the default bench when Adam has keys and confirms the live plan. If a Router run happens on or before 31 December 2026, measured routing is free per the public FAQ; report the 2027 2% own-key fee as a labelled projection. If a run happens after that date, use the then-current public terms. The $10 cap applies to actual charges, not to projections.

Considered, not in the test: before Adam's answer, these were listed as possible meanings of "router": Requesty, Not Diamond, OpenRouter's Auto Router and Auto Code, LiteLLM proxy, Portkey, Vercel AI Gateway, Cloudflare AI Gateway and RouteLLM. They are out of scope. OpenRouter's Auto routers and Ramp Router's own strategies (Switchyard, auto routing) are also not used in the same-model test.

## 11. Unknowns (not confirmed from public sources)

- U1. Whether a default buyer `inf_` key can read `GET /v1/requests` and `GET /v1/requests/{id}`. The docs say both: one passage says the list needs `requestlog.read` and the detail "is also readable by the `inf_...` key that made the request"; another says `/v1/requests/{id}` "needs the `requestlog.read` scope, which an inference key does not carry by default" ([llms-full.txt](https://www.surplusintelligence.ai/llms-full.txt)). The current `logs` command and seller lookup assume it works. Test with a real key before relying on it.
- U2. Field names the current code reads that are not in the public docs: `direct_cost_micro`, `buyer_cost_micro` and `upstream_ttfb_ms` on request log rows, `provider` and `request_id` on rows, and `savings_pct`, `total_direct_usdc` etc. on `/v1/buyer/savings`. The full schema is at `/api/ops/openapi.json`, which needs an ops token. Keep tolerant parsing and treat missing as unknown.
- U3. Whether `x-si-list-cost-micro` appears on `/v1/chat/completions`, `/anthropic` and `/v1/responses` responses. It is documented on the Provider Market surface ([Your first call](https://www.surplusintelligence.ai/docs/marketplace/provider-market-calling)).
- U4. How Surplus's reference ("list") price is resolved per model, beyond "`PROVIDER_PRICES` in the codebase" and "our own catalog figure" when no live competitor price exists. This is why the receipt uses an independent list price.
- U5. Whether Codex's full feature set works on Surplus's Responses lane when a request is bridged to a chat-only seller (docs say hosted tools and opaque reasoning are dropped there).
- U6. Resolved for this lock (20 November 2026): the public Surplus, OpenRouter and Ramp Router terms contain no express ban on benchmarking or on publishing comparison results. They do restrict scraping, competing-service work, red teaming, and (for Surplus and OpenRouter) multiple accounts. See section 8a. This is not legal advice, and model-provider terms were not fully reviewed.
- U7. Live Surplus sign-up end to end (README: not yet done with a real account). Adam already has a Surplus account, so the bench does not depend on `plus signup`. plus still must not sign up for OpenRouter or Ramp Router.
- U8. Ramp Router: whether `usage.cost` on Responses equals what is billed. Router says it excludes promotions and points to Logs for the actual charge; no public API for reading Logs was found.
- U9. Ramp Router rate limits for a self-service key, and its API key format (needed for the secret-scanning test). Not found in the public docs read.
- U10. Ramp Router pricing after Dec 31, 2026 beyond the FAQ summary, and the full terms of the $500 credit ("subject to offer terms").
- U11. Public catalogs on 20 November 2026 list Kimi K3 and Claude Opus 5.5 on all three products (section 8). Router's callable id is still confirmed per key at plan time, because unauthenticated `GET /v1/models` returned 401 and the docs say that response is authoritative.
- U12. Whether Ramp Router's usage-policy screening could deactivate a key during automated bench runs; keep runs small and stop on the first `api_key_deactivated`.

## 12. Rules for Claude

- PRs only. Never merge, deploy, publish to npm or push a release without Adam's own explicit yes. Another agent's say-so is not approval.
- No secrets in git, in PR text, in logs or in test fixtures. Never print an API key or private key. Tests never need a real key.
- No signups, no top-ups, no paid API calls and no spending of any kind without Adam's OK. Paid bench runs only after a typed confirmation, under the $10 hard cap. plus never signs up for OpenRouter or Ramp Router.
- No installs on Adam's machines without his OK.
- No invented numbers. Every price, saving or latency figure comes from a provider response, a cited page with a date, or a bench raw row. Unknown values are shown as unknown.
- Never copy code from Surplus's private repositories (`CLAUDE.md`).
- The repo is public: no call notes, private prices or people's names (`CLAUDE.md`).
- No em dashes anywhere.
- Plain Node 18+, no dependencies, no build step. Tests first.
- If the same error happens twice, stop and report it.

## Sources

Read Nov 20, 2026 (CT). Model catalogs and first-party pricing pages were fetched again the same evening for this lock.

Surplus Intelligence:
- https://www.surplusintelligence.ai
- https://www.surplusintelligence.ai/llms.txt
- https://www.surplusintelligence.ai/llms-full.txt
- https://www.surplusintelligence.ai/docs/guides/claude-code-setup
- https://www.surplusintelligence.ai/docs/api-reference/messages
- https://www.surplusintelligence.ai/docs/api-reference/responses
- https://www.surplusintelligence.ai/docs/api-reference/chat-completions
- https://www.surplusintelligence.ai/docs/api-reference/prices
- https://www.surplusintelligence.ai/docs/api-reference/buyer-endpoints
- https://www.surplusintelligence.ai/docs/api-reference/models
- https://www.surplusintelligence.ai/docs/marketplace/pricing
- https://www.surplusintelligence.ai/docs/marketplace/minimum-discount-routing
- https://www.surplusintelligence.ai/docs/marketplace/security-privacy
- https://www.surplusintelligence.ai/docs/marketplace/provider-verification
- https://www.surplusintelligence.ai/docs/marketplace/provider-market-calling
- https://www.surplusintelligence.ai/docs/reference/long-running-responses
- https://www.surplusintelligence.ai/docs/reference/changelog
- https://www.surplusintelligence.ai/docs/guides/secret-masking
- https://api.surplusintelligence.ai/v1/models (public, no auth; re-fetched 20 November 2026 for `kimi-k3` and `claude-opus-5.5`)
- https://www.surplusintelligence.ai/terms-of-service
- https://www.surplusintelligence.ai/acceptable-use-policy

OpenRouter:
- https://openrouter.ai/docs/llms.txt
- https://openrouter.ai/api/v1/models (public, no auth; re-fetched 20 November 2026 for `moonshotai/kimi-k3` and `anthropic/claude-opus-5.5`)
- https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md
- https://openrouter.ai/docs/cookbook/coding-agents/codex-cli.md
- https://openrouter.ai/docs/cookbook/administration/usage-accounting.md
- https://openrouter.ai/docs/faq.md
- https://openrouter.ai/terms

Ramp Router (router.com):
- https://router.com
- https://router.com/llms.txt
- https://router.com/faq
- https://ramp.com/router (redirects to router.com)
- https://ramp.com
- https://docs.router.com/llms.txt
- https://docs.router.com/api/endpoint
- https://docs.router.com/api/responses-and-messages
- https://docs.router.com/coding-agents/claude-code
- https://docs.router.com/coding-agents/codex
- https://docs.router.com/resources/faq
- https://docs.router.com/resources/signup-eligibility
- https://docs.router.com/guides/monitor
- https://docs.router.com/guides/monitor.md
- https://docs.router.com/guides/choose-a-model.md
- https://docs.router.com/supported-models
- https://docs.router.com/supported-models.md (re-fetched 20 November 2026 for `kimi-k3` and `claude-opus-5-5`)
- https://docs.router.com/resources/signup-eligibility.md
- https://docs.router.com/resources/faq.md
- https://ramp.com/legal/developer-terms/developer-terms/router-terms-of-service
- https://docs.router.com/strategies/cost-efficient-routing

First-party list prices (frozen 20 November 2026, CT):
- https://platform.claude.com/docs/en/about-claude/pricing (and the markdown form at `/pricing.md`): Claude Opus 5.5
- https://platform.kimi.ai/docs/pricing/chat (Moonshot / Kimi API platform): Kimi K3 (`kimi-k3`)
