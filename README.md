# plus

An unofficial command-line tool for [Surplus Intelligence](https://www.surplusintelligence.ai). It is not made or endorsed by Surplus. Site: [pluscli.vercel.app](https://pluscli.vercel.app).

It does three things:

- Runs your coding tool (Claude Code, or anything that speaks the OpenAI or Anthropic API) on Surplus.
- Streams an answer to a question, then prints a receipt: what you paid, and what list price would have been.
- Signs you up and tops you up without leaving the terminal.

```
> plus ask "In one sentence, what is a keep-alive in streaming?"
A keep-alive in streaming is a mechanism used to maintain an active
connection between a client and server by sending periodic signals...

· gpt-4o-mini via openai · first token 1.1 s · total 1.8 s · 36 tokens
· cost $0.0000010 · list $0.000025, saved 96%
```

## Install

Needs Node 18 or newer. Mac and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/adamtpang/plus/main/cli/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/adamtpang/plus/main/cli/install.ps1 | iex
```

The installer downloads two files, `cli/plus.mjs` and `cli/wallet.mjs`, plus a two-line launcher. Read them first if you like; that is all it installs.

From a checkout instead:

```bash
npm link
```

Then:

```bash
plus login        # or: plus signup
plus doctor
plus ask "hello"
```

## Commands

| Command | What it does |
|---|---|
| `plus signup` | Make a new Surplus account. No browser needed |
| `plus login` | Save an API key you already have. It is checked first |
| `plus topup <dollars>` | Add credit by card. Opens a Stripe page, then waits for the credit |
| `plus topup --usdc` | Where to send USDC instead |
| `plus ask "question" [-m model]` | Stream an answer, then show its cost against list price |
| `plus compare "question" -m a,b` | Ask several models at once: time, cost, list price and saving side by side |
| `plus claude [arguments]` | Start Claude Code running on Surplus |
| `plus codex [arguments]` | Start Codex running on Surplus |
| `plus opencode [arguments]` | Start OpenCode running on Surplus |
| `plus aider [arguments]` | Start aider running on Surplus |
| `plus run <program> [arguments]` | Start any other tool pointed at Surplus |
| `plus run --print-env` | The settings it uses (never the key), and how Cursor, Kilo, Cline and Roo take them |
| `plus price <model>` | The cheapest live sellers for a model, against its list price |
| `plus balance` | Credit left, and what you have saved so far |
| `plus savings` | What you saved, model by model |
| `plus logs` | Your recent requests: cost, list price and wait |
| `plus bench` | Surplus, OpenRouter and Router by Ramp on the same prompts (see below) |
| `plus models` | A short list of models: Surplus's cheapest live price next to an Arena quality score |
| `plus doctor` | Check your setup, one thing at a time |
| `plus update` | Install the latest version |

`balance`, `savings`, `price`, `logs`, `compare` and `bench` take `--json` for scripts. `plus ask "Summarise:" --stdin` adds piped text to the question.

Launchers take `--model` as their first argument, for example `plus claude --model glm-5.3` or `plus codex --model gpt-5-mini`. Before a tool starts, `plus` checks your key with Surplus and stops with a clear message if it is refused. `plus update` installs the latest version. How this compares with OpenRouter's Ori, feature by feature: [PARITY.md](PARITY.md).

## Cheap by default, and careful with money

- **`plus ask "question" -m auto`** uses a cheap open-weight model, currently `glm-5.3-flash`, and the receipt says `auto -> glm-5.3-flash`. Surplus does not tag offers as official or compliant, so `auto` cannot filter on that; Surplus picks the cheapest healthy seller.
- **Retries.** If a request fails with a server error, or the connection dies before any of the answer arrives, `plus ask` tries up to two more times and the receipt says so. Once text has started printing it does not retry, so you never see an answer twice.
- **Spend cap.** `PLUS_SPEND_CAP=0.50 plus ask ...` (dollars per day, or `spendCap` in the config file) stops `ask`, `compare` and `bench --live` once the day's spending reaches it, and the receipt shows `spent today $x of $y`. It counts what `plus` itself spent on this machine, not tools started with `plus claude`.
- **`plus savings`** also shows what OpenRouter lists for the same tokens, or `unknown` when it lists no such model.
- **`plus models`** uses Text Arena scores read from arena.ai on 22 November 2026 and frozen in the code. Four of the eight models had no score on that page and say so.

`plus ask` gives up after 90 seconds of silence (`--wait` changes it) and says so when an answer is cut off, instead of hanging.

## Compare routers

`plus bench` sends the same prompts through Surplus, OpenRouter and Router by Ramp and measures each the same way.

**The prompts.** Ten are built in, two of each kind: short coding, tool use, web pages, long context, and multi-turn repair. Each has a check that needs no judge:

| Kind | How an answer is checked |
|---|---|
| Coding, repair | The function in the reply is run against unit tests, in a bare sandbox with a one second limit |
| Tool use | The model must call the right tool with arguments that parse and match |
| Web | The page or CSS must contain the required parts |
| Long context | One exact value must be found in a 300-line document |

`--quick` uses three one-line prompts instead. `--prompts file.jsonl` uses your own, each checked by a pattern.

**What it reports**, per router and model:

- **failures**, by kind: timeout, a 4xx or 5xx reply, dropped mid-answer, empty, cut off at the length limit, or a tool call that does not parse
- **time to first token** and **tokens per second**, at the middle (p50) and the slow end (p95)
- **cost actually charged**, per 1M tokens, and against that router's own list price for the same tokens
- **cached input** as a share of input tokens
- **correct answers**, overall and by kind
- retries, and how often Surplus changed seller inside one request

```bash
plus bench --fixture cli/bench-fixture.json          # example data: no keys, no network
plus bench --live -m gpt-4o-mini,glm-5.3-flash       # the ten prompts, about a cent on cheap models
plus bench --live --quick                            # three one-line prompts
plus bench --live -m shortlist --out run.jsonl       # eight models; costs more, set PLUS_SPEND_CAP
plus bench --fixture run.jsonl                       # replay a saved run
plus bench --help                                    # every flag
```

`--live` uses every router you have a key for and skips the rest. A model a router does not list is skipped and reported, not scored as zero.

| Router | Settings |
|---|---|
| Surplus | `SURPLUS_API_KEY`, or your `plus login` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Router by Ramp | `RAMP_ROUTER_API_KEY` (address defaults to `https://api.router.com/v1`; Ramp's replies carry no cost, so its tokens are priced from its own model list) |

Keys are never printed or saved. Each router's model list is read first, so the same model is found under each router's own spelling. `--out` writes one JSON line per request, including the exact model each router served.

Limits worth knowing: one run is ten requests per model per router, so p95 is close to "the slowest one"; use `--runs 3` for more. The checks are strict and simple, and passing them shows a model handled ordinary work, not that it is the best model. Replies to coding prompts are run as code on your machine, in a sandbox with no files or network, which contains mistakes but is not a defence against code written to escape.

### Eight models, one real run

24 November 2026, one machine in the US: the ten built-in prompts, once each, on eight models through all three routers (`plus bench --live -m shortlist`). No minimum discount was set on the Surplus key, and it was limited to trusted sellers.

Dollars per 1M tokens, as charged:

| Model | Surplus | OpenRouter | Router by Ramp | Surplus against OpenRouter |
|---|---|---|---|---|
| claude-opus-5.5 | $2.41 | $4.99 | $4.76 | 52% less |
| claude-sonnet-5.5 | $1.18 | $2.51 | $2.37 | 53% less |
| gemini-4-carbon | $0.23 | $2.92 | $2.82 | 92% less |
| kimi-k3 | $0.07 | $1.58 | $5.49 | 96% less |
| glm-5.3 | $0.001 | $1.92 | $2.55 | over 99% less |
| glm-5.3-flash | $0.006 | $0.17 | $0.21 | 97% less |
| deepseek-v4.1-flash | $0.006 | $0.23 | $0.41 | 98% less |
| mimo-v2.6-pro | $0.19 | $0.11 | not listed | 78% more |

| | Surplus | OpenRouter | Router by Ramp |
|---|---|---|---|
| Requests that failed | 0 of 80 | 0 of 80 | 1 of 70 (a 120 second timeout) |
| Answers that passed their check | 79 of 80 | 80 of 80 | 69 of 69 |
| Time to first token, p50, by model | 1.2 to 4.6 s | 0.6 to 6.8 s | 0.7 to 5.1 s |

What it shows, and what it does not:

- **Surplus answered every request and was at least 50% cheaper than OpenRouter on seven of the eight models.**
- **It was not the cheapest on every model.** On mimo-v2.6-pro OpenRouter cost less, because 94% of its input was served from cache.
- **It was slower to the first token on most models**, about 1.5 to 2.5 times OpenRouter. It was close on Claude Opus and faster on Gemini.
- **One Surplus answer was wrong:** glm-5.3-flash missed one long-context prompt. One miss in 80 is not a pattern.
- Some Surplus prices are far below list (glm-5.3 at a tenth of a cent per 1M tokens). They are what was charged on the day; they move with its market and may not last.
- Ramp's figures are its list prices, because its replies report no cost. That gives it no credit for cache discounts.
- Ten requests per model per router, from one place on one day. Rerun it before quoting it.

An earlier run of the same list, with a 50% minimum discount set on the Surplus key, gave the same prices on six models and refused 16 of 80 requests (`minimum_discount_not_met`) on the other two. The minimum caused refusals; it did not change the prices.

### The full set, one real run

24 November 2026, one machine in the US, the ten built-in prompts once each.

| Model | Router | Failed | Correct | First token p50 / p95 | $ per 1M tokens | Against its list |
|---|---|---|---|---|---|---|
| gpt-4o-mini | Surplus | 0 of 10 | 10 of 10 | 0.9 s / 2.0 s | $0.025 | -85% |
| gpt-4o-mini | OpenRouter | 0 of 10 | 10 of 10 | 0.6 s / 1.2 s | $0.139 | -16% |
| gpt-4o-mini | Ramp | 0 of 10 | 10 of 10 | 0.6 s / 1.5 s | $0.166 | 0% |
| glm-5.3-flash | Surplus | 0 of 10 | 10 of 10 | 2.3 s / 4.1 s | $0.005 | -97% |
| glm-5.3-flash | OpenRouter | 0 of 10 | 10 of 10 | 1.0 s / 1.9 s | $0.181 | -11% |
| glm-5.3-flash | Ramp | 1 of 10 | 8 of 9 | 1.4 s / 19.4 s | $0.202 | 0% |
| deepseek-v4.1-flash | Surplus | 0 of 10 | 10 of 10 | 1.7 s / 3.5 s | $0.009 | -97% |
| deepseek-v4.1-flash | OpenRouter | 0 of 10 | 10 of 10 | 0.8 s / 2.7 s | $0.203 | +202% |
| deepseek-v4.1-flash | Ramp | 0 of 10 | 10 of 10 | 0.9 s / 2.5 s | $0.405 | 0% |

What it shows, and what it does not:

- **Surplus was the cheapest on all three models by a wide margin, and the slowest to the first token.**
- Surplus and OpenRouter served part of the input from cache (34% to 47% on Surplus), which lowers their price per token. Ramp's figure is its list price with no cache discount, because its replies report no cost.
- OpenRouter's "+202%" on DeepSeek means the request was served by a pricier provider than the cheapest one its list shows.
- Ramp's one failure was a 60 second timeout on one request. Surplus changed seller three times inside requests for glm-5.3-flash and still answered.
- **The test key had a 50% minimum discount set on Surplus.** Surplus served a request only when a seller could beat list price by half, so its figures here are its price when a deep discount is on offer. With no minimum, more requests are served, at smaller discounts.
- It is ten requests per row from one place on one day. Rerun it before quoting it.

### The quick set, one real run

24 November 2026, from one machine in the US: three prompts, twice each, per model per router. Every answer from every router was correct, and no request failed except where noted.

| Model | Surplus | OpenRouter | Router by Ramp |
|---|---|---|---|
| gpt-4o-mini | $0.039 | $0.203 | $0.210 |
| claude-sonnet-4.5 | $2.82 | $6.00 | refused |
| deepseek-v4-flash | $0.095 | $0.201 | $0.155 |

Dollars per 1M tokens (input and output blended), as charged. OpenRouter includes its 5.5% credit fee. Ramp is priced from its own model list.

| Time to first token | Surplus | OpenRouter | Router by Ramp |
|---|---|---|---|
| gpt-4o-mini | 1.3 s | 0.6 s | 0.6 s |
| claude-sonnet-4.5 | 1.5 s | 1.1 s | refused |
| deepseek-v4-flash | 2.0 s | 0.7 s | 0.7 s |

Read it with care:

- **Surplus was 52% to 81% cheaper than OpenRouter per token, and 1.4 to 3 times slower to the first token.**
- It is six short requests per cell, and prices on Surplus move with its market.
- The test key had a 50% minimum discount set on Surplus. When no seller can beat that, Surplus refuses the request (`minimum_discount_not_met`, sent with a 404 status) instead of serving it at a smaller discount. Two days earlier that refused every claude-sonnet-4.5 request. `plus` now prints the reason.
- Ramp refused Claude because of a US data residency setting on the test account, not a fault in Ramp.
- Run it yourself before trusting it: `plus bench --live`.

## How sign-up works

A Surplus account is a wallet. `plus signup` makes a new private key on your machine, signs Surplus's sign-in message with it, and swaps the signature for an API key. The signing code is in `cli/wallet.mjs`, written without dependencies and checked against published test values.

## Honest limits

- **Secrets are stored as plain text** in `~/.plus/config.json`: your API key, and the wallet's private key if you used `plus signup`. Back that file up and keep it private. See `SECURITY.md`.
- **Sign-up has been tested against a stand-in server and against Surplus up to the last step.** No real account has been made with it yet.
- **The four named launchers were each run for real on Surplus** on 24 November 2026 (Windows): Claude Code, Codex, aider and OpenCode each started and got an answer from a Surplus model. Other tools through `plus run` depend on how each one reads its settings.
- **The seller on the receipt is looked up afterwards** in your request log, which trails by a second or two. If it is not there within about three seconds, the receipt leaves it out.
- **The signing code is hand-written.** It is fine for signing one login on your own machine. It makes no attempt to run in constant time, so do not reuse it on a server.
- **No telemetry.** The tool talks to Surplus and to nothing else.

## Develop

```bash
npm test
```

Tests use Node's built-in runner. `signup`, `topup` and `ask` are tested against pretend servers on your own machine, so the tests never make an account, take a payment, or need a key. Write the test first, watch it fail, then change the code.

Settings: `SURPLUS_API_KEY` overrides the saved key. `SURPLUS_BASE_URL` points the tool at another address.

## Licence

MIT. The idea of a one-line installer and of launching other tools is borrowed from OpenRouter's Ori; none of its code is used.
