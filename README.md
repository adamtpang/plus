# plus

An unofficial command-line tool for [Surplus Intelligence](https://www.surplusintelligence.ai). It is not made or endorsed by Surplus.

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

`plus bench` sends the same three short prompts, each with one right answer, through Surplus, OpenRouter and Router by Ramp, and reports for each router and model:

- **price actually charged**, as each router reports it, plus OpenRouter's 5.5% credit fee
- **time to first token** and **tokens per second** (medians)
- **error rate**
- **quality**: the share of answers that match the expected reply

```bash
plus bench --fixture cli/bench-fixture.json          # example data: no keys, no network
plus bench --live -m gpt-4o-mini,deepseek-v4-flash   # real requests, costs a fraction of a cent
plus bench --live --save run.json                    # keep a run, replay it later with --fixture
```

`--live` uses every router you have a key for and skips the rest:

| Router | Settings |
|---|---|
| Surplus | `SURPLUS_API_KEY`, or your `plus login` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Router by Ramp | `RAMP_ROUTER_API_KEY` (address defaults to `https://api.router.com/v1`; Ramp's replies carry no cost, so its tokens are priced from its own model list) |

Keys are never printed or saved. Three prompts are a quick reading, not a benchmark: use `--runs 3` for more samples. OpenRouter model names get a vendor prefix guessed from the name (`gpt-4o-mini` becomes `openai/gpt-4o-mini`).

### One real run

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
- It is six short requests per cell. Prices on Surplus move with its market, and a model can be unavailable: two days earlier, every claude-sonnet-4.5 request on Surplus failed.
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
