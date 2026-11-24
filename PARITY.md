# plus and Ori, feature by feature

Ori is OpenRouter's CLI (closed source). `plus` aims for the same everyday experience on Surplus Intelligence. This list is from Ori's public docs (openrouter.ai/docs/guides/ori, read 20 Nov 2026) and is kept honest: "partial" means partial.

| Ori | What it does | plus |
|---|---|---|
| One-line install | `curl ... \| bash` | Yes, Mac, Linux and Windows |
| `ori login` | Sign in with OpenRouter (OAuth) | `plus login` takes a key; `plus signup` makes an account from the terminal. Surplus has no OAuth to sign in with |
| `ori claude`, `codex`, `opencode` | Launch the tool on OpenRouter | Yes, plus `aider`. All four run for real on Surplus, 24 Nov 2026 |
| `ori hermes`, `pi`, `cline`, `kilo`, `crush`, `droid`, `grok`, `omp` and more | More launchers | Not yet. Each is added only after it is tested for real. `plus run <tool>` covers tools that read the standard OpenAI or Anthropic settings |
| `--model` on any launcher | Pick the model | Yes, `plus claude --model <id>` and the same for each launcher |
| Offers to install a missing tool | | Says how to install it |
| Stops when the key is rejected | Before the tool starts | Yes |
| `ori update` | Self-update | Yes, `plus update` |
| `ori doctor` | Checks the setup | Yes, `plus doctor` |
| `ori eval` | Test prompts across models | `plus compare` (one prompt, several models) and `plus bench` (several routers) |
| Cost shown | Tokens and cost | Yes, plus list price and percent saved on every answer |
| `ori harness setup` / `reset` | Write settings into the tool's own config, so its desktop app works too | Not yet |
| `ori alias` | Make plain `claude` run through Ori | Not yet |
| Spend limit (`ORI_KEY_LIMIT`) | Cap what a key can spend | Not yet. Surplus budgets need a management key |
| Organisation policies | Admin-set rules | No |
| Ori Code, Slack interns, Mac app | Its own agent and apps | No, by choice |

Things plus has that Ori does not show: sign-up and top-up from the terminal, the list price and saving on every receipt, and a side-by-side router benchmark.
