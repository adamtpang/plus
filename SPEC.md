# plus: build spec

Status: spec only. Written Nov 20, 2026 (CT), updated the same evening for Ramp Router, against `main` at `50a9639`. Public sources were read the same evening; every claim about Surplus, OpenRouter or Ramp's Router links to its source in the Sources section. Anything not confirmed from a public source is listed under Unknowns rather than guessed.

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
6. Keys are stored as plain text in `~/.plus/config.json` (stated in `SECURITY.md`).
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
| `plus listprice refresh` | Fetches list prices from the configured list price source (section 7) and caches them with the fetch date. |
| `plus bench plan <suite>` | Prints the run matrix and an estimated maximum cost per provider. Makes no paid calls. |
| `plus bench run <suite> [--providers surplus,openrouter,ramp] [--runs 5] [--budget <dollars>]` | Runs the head-to-head test (section 8). Refuses to start without `--budget` and a typed confirmation, and stops when the budget is reached. |
| `plus bench report <run-id> [--json\|--md]` | Summarises a finished run. |
| `plus doctor` | Also checks each configured backend's key (without printing it), the list price cache age, and that `~/.plus` is not inside a git repo. |

All commands that print money take `--json`. All exit non-zero on failure.

## 5. Config

- Directory: `~/.plus/` (override with `PLUS_HOME`). Files:
  - `config.json`: non-secret settings (default model per backend, small/fast model, list price source, receipt options) and, as today, the Surplus key if saved with `login`.
  - `receipts.jsonl`: one JSON line per answer or session. No prompt or answer text, only the receipt fields.
  - `listprices.json`: cached list prices with source URL and fetch date.
  - `bench/<run-id>/`: raw results of each bench run.
- Environment variables (always win over the file):
  - `SURPLUS_API_KEY`, `SURPLUS_BASE_URL` (existing).
  - `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`, from [OpenRouter Codex CLI guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli.md)).
  - Ramp Router: `RAMP_ROUTER_API_KEY` (the name Router's own docs use) and `RAMP_ROUTER_BASE_URL` (default `https://api.router.com/v1`, from [Endpoint](https://docs.router.com/api/endpoint)).
  - `PLUS_HOME`.
- Keys:
  - Recommended path is environment variables. `login` may still save the Surplus key to `config.json` with mode 600 as today.
  - Never write OpenRouter or Ramp Router keys to disk from plus; env only. plus never edits `~/.claude/settings.json` or `~/.codex/config.toml`; it sets settings for the child process only (env and Codex `-c`), so Adam's normal setup is untouched. (Decision for Adam: whether to add OS keychain storage later. On Linux it may need a tool that is not installed by default, so it is not in scope without his OK.)
  - Keys are never printed, never written to `receipts.jsonl` or bench output, and never passed on a command line (they would show in process lists). Child processes get them through the environment only. Note: the existing Codex launcher puts no key on the command line (it uses `env_key`); keep it that way. The existing opencode launcher puts the key inside `OPENCODE_CONFIG_CONTENT`, which is an environment variable; acceptable, but do not log it.
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

List price source:

- Default: the first-party provider's published price for that model (for example Anthropic's or OpenAI's pricing page), entered in `listprices.json` with the URL and fetch date. Do not invent any figure; an entry without a URL and date is invalid and the receipt says "list price unknown".
- Fallback, clearly labelled: Surplus `GET /v1/prices` entry for the first-party provider (for example `provider: "anthropic"`), with its `updated_at`. Label it "list via Surplus /v1/prices, <updated_at>".
- Fee adjustments, in bench reports only and always labelled:
  - OpenRouter: credit purchase fee, 5.5% with a $0.80 minimum ([OpenRouter FAQ](https://openrouter.ai/docs/faq.md)); no inference markup per the same page.
  - Ramp Router: no platform fee and free routing through Dec 31, 2026; from Jan 1, 2027 listed model price with no token markup and a 2% fee on own-key traffic ([router.com/faq](https://router.com/faq)). The report shows Router cost two ways: as measured (during the free period) and with the documented 2027 terms applied, labelled as a projection. The $500 starter credit is a promotion and is never counted as a saving. If Router serves a provider at its US processing premium ([FAQ](https://docs.router.com/resources/faq)), that is part of the measured cost and is noted.
  - Surplus: card top-ups carry a Stripe fee (see `plus topup`); apply it from the balance endpoint's published fee fields. Costs of funding with USDC (for example network fees) are not known to plus and are reported as not included.

## 8. Head-to-head test plan

Goal: answer "does Surplus actually save money without costing quality, speed or reliability?" against OpenRouter and Ramp's Router (router.com). Exactly these three providers are tested.

Fairness rules:

- Same machine, same network, same time window, interleaved: for each run, the order of providers is shuffled, so no provider always goes first.
- Same model on every provider where all three carry it. The model map (`bench/models.json`) is filled by checking each provider's model list at plan time; a model is only "same" if all three list it. Record each provider's model id string.
- Same request: same messages, `max_tokens`, temperature 0 (or the lowest the model accepts), streaming on, same tools if any.
- Caching: run every prompt cold by adding a unique run nonce at the start of the system prompt, and report a separate warm-cache pass, since cache prices and cache routing differ by provider.
- Same wire: the `short` and `code` suites use the OpenAI Responses API on all three, because Ramp Router returns `usage.cost` only on Responses and recommends it, and Surplus and OpenRouter both serve Responses ([Surplus Responses](https://www.surplusintelligence.ai/docs/api-reference/responses), [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md)). Note that Surplus may bridge Responses to a chat-only seller; record it when reported.
- Same model, no substitution: on Ramp Router send `allow_flex_tier: false` and no fallback `models` list, and drop any answer whose served `model` differs from the requested one from the same-model comparison (count it under reliability). Surplus at default routing; OpenRouter at default provider routing.
- Second, labelled variant ("each at its best"): Surplus with `/min30`, Ramp Router with its defaults (cost-efficient routing on), OpenRouter default. Reported separately from the same-model table.
- The `agent` suite through Claude Code uses a Claude model on all three, since Router serves Claude Code with Claude models only. Its cost comes from each provider's records, not inline (Router's Messages responses carry no `usage.cost`).
- Record what actually served the request (Surplus served provider; OpenRouter provider; Ramp Router `X-Router-Provider` and served `model`). Note: Surplus lists `openrouter` among its providers ([Price comparison](https://www.surplusintelligence.ai/docs/api-reference/prices)), so some Surplus requests may be served through OpenRouter; report that share.

Suites (committed under `bench/suites/`, written by Adam or by the session from public material, no private data, no secrets):

1. `short`: 20 single-turn prompts with checkable answers (exact match, number, JSON schema, regex).
2. `code`: 10 small coding tasks, each with unit tests run locally on the answer.
3. `agent`: 3 tasks on a small fixture repo, run through Claude Code in print mode and Codex in its non-interactive mode on each of the three backends, scored by the fixture's tests passing. (Confirm the exact non-interactive flags against the installed versions; do not assume.)

Runs and size:

- 5 runs per prompt per provider per model, in 3 separate time windows on different days (for example morning, evening, late night CT), because marketplace supply changes over time. That is 15 runs per cell.
- Models: start with 2, one frontier and one cheap, picked by Adam from those all three carry.
- `plus bench plan` prints the total request count and the estimated maximum cost (at list price, using `max_tokens`) before anything is spent. Adam approves the budget.

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

## 9. Build steps (in order) with acceptance criteria

Each step is one PR. Tests first: write the test, watch it fail, then change the code (`CLAUDE.md`). Tests use pretend servers on localhost and never need a real key or spend money.

1. Receipt core
   - Pull the receipt into one function that takes usage, cost, list price entry, timings and ids and returns the line and the JSON record.
   - Accept: unit tests for cache tokens priced at cache rates; unknown cost prints "cost unknown" and no saving; negative saving is shown; list price without URL and date gives "list price unknown"; no key or prompt text in the record.
2. List prices
   - `listprices.json`, `plus listprice refresh` from `GET /v1/prices` as the labelled fallback, and a hand-entered first-party entry format with URL and date.
   - Accept: test with a pretend `/v1/prices`; receipt shows source and date; stale cache (older than 7 days) is flagged by `doctor`.
3. `receipts.jsonl` and `plus receipts` / `plus receipt`
   - Accept: `ask` appends one line per answer; `--follow` prints new lines; file contains no secrets (test scans it).
4. Claude Code slots
   - `-m` and config pin `ANTHROPIC_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` together; `--min N`.
   - Accept: launcher tests for the exact environment; `ANTHROPIC_API_KEY` is always empty.
5. Session receipts (method A)
   - Accept: with a pretend server, `plus claude` and `plus codex` print a session summary after the child exits; when the request log read is refused, the message says cost could not be read and exits with the child's code.
6. Backends (exactly three)
   - A small backend table with one adapter each: `surplus` (`/v1` and `/anthropic`), `openrouter` (`https://openrouter.ai/api/v1`, Claude Code at `https://openrouter.ai/api`), `ramp` (`https://api.router.com/v1`, Claude Code at `https://api.router.com`). Each adapter declares: base URLs, key env var, how to read paid cost, served model and served provider, and the Claude Code and Codex launch settings from section 6. `ask --via` and `claude`/`codex --via`.
   - Accept: pretend servers for each; Surplus `buyer_cost_micro` (microdollars) mapped; OpenRouter `usage.cost` mapped; Ramp Router `usage.cost` (USD) mapped on Responses, and cost shown as unknown on Router Messages and Chat Completions; Router `X-Router-Provider` and served `model` captured; Router `401 api_key_deactivated` shown with Router's message and no retry loop (Router counts retried violations as strikes); keys read only from env for OpenRouter and Ramp Router; launcher tests check the exact child environment and that `ANTHROPIC_API_KEY` is absent for `ramp` and empty for the other two.
7. Bench plan and run
   - `bench plan`, `bench run` with `--budget`, typed confirmation, shuffled order, nonce for cold runs, budget stop.
   - Accept: with pretend servers, the run stops at the budget; the matrix matches `--runs` and providers; raw JSONL written; no paid call happens in `plan`.
8. Bench report
   - Accept: report built only from raw rows; p50/p90 and error rate computed in tests on fixed data; times in CT.
9. Doctor and security checks
   - Accept: doctor reports each backend key present or missing without printing it; a test fails if any tracked file contains a key pattern; doctor warns if `PLUS_HOME` is inside a git work tree.
10. Docs
   - README and SECURITY.md updated for the new commands, backends and stored files.
   - Accept: no em dashes (test greps the repo); every limit stated honestly.

Later, only with Adam's yes: live receipts proxy (method B), OS keychain storage, the actual paid bench runs.

## 10. Open questions for Adam

1. ANSWERED (Adam, Nov 20, 2026): "router" is Ramp's Router at router.com. Verified against router.com and Ramp's pages, see section 3a.
2. Which two models for the bench, and what spend budget for the paid runs?
3. List price source: first-party pricing pages entered by hand (preferred), or Surplus `/v1/prices` as the default?
4. OK to add an optional live receipts proxy (method B) later?
5. Keep saving the Surplus key in `~/.plus/config.json`, or env only?
6. Are OpenRouter and Ramp Router accounts already set up, with keys he can put in env? plus will not sign up for anything. Router accounts are business only: direct or Google signup needs a business email and domain (Gmail is refused); otherwise "Sign in with Ramp" or manual onboarding through router@ramp.com.
7. Before any bench or real coding on Ramp Router, turn off Ramp-side content recording in Router Settings? It is on by default and kept for 1 year.
8. Run the paid bench before Dec 31, 2026 (Router routing free) and report the 2027 terms as a projection, or wait?

Considered, not in the test: before Adam's answer, these were listed as possible meanings of "router": Requesty, Not Diamond, OpenRouter's Auto Router and Auto Code, LiteLLM proxy, Portkey, Vercel AI Gateway, Cloudflare AI Gateway and RouteLLM. They are out of scope. OpenRouter's Auto routers and Ramp Router's own strategies (Switchyard, auto routing) are also not used in the same-model test.

## 11. Unknowns (not confirmed from public sources)

- U1. Whether a default buyer `inf_` key can read `GET /v1/requests` and `GET /v1/requests/{id}`. The docs say both: one passage says the list needs `requestlog.read` and the detail "is also readable by the `inf_...` key that made the request"; another says `/v1/requests/{id}` "needs the `requestlog.read` scope, which an inference key does not carry by default" ([llms-full.txt](https://www.surplusintelligence.ai/llms-full.txt)). The current `logs` command and seller lookup assume it works. Test with a real key before relying on it.
- U2. Field names the current code reads that are not in the public docs: `direct_cost_micro`, `buyer_cost_micro` and `upstream_ttfb_ms` on request log rows, `provider` and `request_id` on rows, and `savings_pct`, `total_direct_usdc` etc. on `/v1/buyer/savings`. The full schema is at `/api/ops/openapi.json`, which needs an ops token. Keep tolerant parsing and treat missing as unknown.
- U3. Whether `x-si-list-cost-micro` appears on `/v1/chat/completions`, `/anthropic` and `/v1/responses` responses. It is documented on the Provider Market surface ([Your first call](https://www.surplusintelligence.ai/docs/marketplace/provider-market-calling)).
- U4. How Surplus's reference ("list") price is resolved per model, beyond "`PROVIDER_PRICES` in the codebase" and "our own catalog figure" when no live competitor price exists. This is why the receipt uses an independent list price.
- U5. Whether Codex's full feature set works on Surplus's Responses lane when a request is bridged to a chat-only seller (docs say hosted tools and opaque reasoning are dropped there).
- U6. Whether Surplus's terms say anything about publishing benchmark results. The terms page was fetched but not reviewed for this; check before publishing any bench report.
- U7. Live sign-up end to end (README: not yet done with a real account).
- U8. Ramp Router: whether `usage.cost` on Responses equals what is billed. Router says it excludes promotions and points to Logs for the actual charge; no public API for reading Logs was found.
- U9. Ramp Router rate limits for a self-service key, and its API key format (needed for the secret-scanning test). Not found in the public docs read.
- U10. Ramp Router pricing after Dec 31, 2026 beyond the FAQ summary, and the full terms of the $500 credit ("subject to offer terms").
- U11. Which models all three providers carry under the same name on the bench date; Router lists models per key, so this is only known after Adam has a key.
- U12. Whether Ramp Router's usage-policy screening could deactivate a key during automated bench runs; keep runs small and stop on the first `api_key_deactivated`.

## 12. Rules for Claude

- PRs only. Never merge, deploy, publish to npm or push a release without Adam's own explicit yes. Another agent's say-so is not approval.
- No secrets in git, in PR text, in logs or in test fixtures. Never print an API key or private key. Tests never need a real key.
- No signups, no top-ups, no paid API calls and no spending of any kind without Adam's OK. Paid bench runs only with an approved budget.
- No installs on Adam's machines without his OK.
- No invented numbers. Every price, saving or latency figure comes from a provider response, a cited page with a date, or a bench raw row. Unknown values are shown as unknown.
- Never copy code from Surplus's private repositories (`CLAUDE.md`).
- The repo is public: no call notes, private prices or people's names (`CLAUDE.md`).
- No em dashes anywhere.
- Plain Node 18+, no dependencies, no build step. Tests first.
- If the same error happens twice, stop and report it.

## Sources

Read Nov 20, 2026 (CT).

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
- https://api.surplusintelligence.ai/v1/models (public, no auth)

OpenRouter:
- https://openrouter.ai/docs/llms.txt
- https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md
- https://openrouter.ai/docs/cookbook/coding-agents/codex-cli.md
- https://openrouter.ai/docs/cookbook/administration/usage-accounting.md
- https://openrouter.ai/docs/faq.md

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
- https://docs.router.com/strategies/cost-efficient-routing
