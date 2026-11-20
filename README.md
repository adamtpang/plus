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

· gpt-4o-mini · first token 1.1 s · total 1.8 s · 36 tokens
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
| `plus claude [arguments]` | Start Claude Code running on Surplus |
| `plus run <program> [arguments]` | Start any other tool pointed at Surplus |
| `plus price <model>` | The cheapest live sellers for a model, against its list price |
| `plus balance` | Credit left, and what you have saved so far |
| `plus savings` | What you saved, model by model |
| `plus logs` | Your recent requests: cost, list price and wait |

`plus ask` gives up after 90 seconds of silence (`--wait` changes it) and says so when an answer is cut off, instead of hanging.

## How sign-up works

A Surplus account is a wallet. `plus signup` makes a new private key on your machine, signs Surplus's sign-in message with it, and swaps the signature for an API key. The signing code is in `cli/wallet.mjs`, written without dependencies and checked against published test values.

## Honest limits

- **Secrets are stored as plain text** in `~/.plus/config.json`: your API key, and the wallet's private key if you used `plus signup`. Back that file up and keep it private. See `SECURITY.md`.
- **Sign-up has been tested against a stand-in server and against Surplus up to the last step.** No real account has been made with it yet.
- **`plus run` was tested with Claude Code only.** Other tools depend on how each one reads its settings.
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
