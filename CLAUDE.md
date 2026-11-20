# Notes for coding sessions

- This is the `plus` CLI on its own: an unofficial command-line tool for Surplus Intelligence. It was split out of `Aether/surplusminus` on 2026-11-13, so there is no starter template; the files came from that repo's `cli/` folder.
- Keep it small and readable. Plain Node 18+, no dependencies, no build step.
- Tests first, every change: write the test, watch it fail, then change the code. `npm test`.
- Never commit secrets. Tests must never need a real key, make an account, or take a payment; use a pretend server on localhost.
- Never print an API key or a private key.
- Never copy code from Surplus's private repositories into this one.
- No em dashes anywhere.
- The repo is public. Everything committed here is visible to anyone: no call notes, prices from private conversations, or names of people. Do not publish to npm or push a release without Adam's explicit go.
- `Aether/surplusminus/cli/` still holds an older copy that the live installer serves. This repo is the one to change; the old copy gets replaced when this goes public.
