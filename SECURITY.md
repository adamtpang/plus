# Security

## What this tool stores

`~/.plus/config.json` holds, as plain text:

- your Surplus API key
- the private key of the wallet made by `plus signup`, if you used it

Anyone who can read that file can spend your Surplus credit and sign in as that account. The file is written readable by your user only where the system supports it. It is not encrypted and is not in the system keychain.

## What it sends, and where

Requests go to the Surplus API (`api.surplusintelligence.ai`, or `SURPLUS_BASE_URL` if you set it). `plus topup` opens a Stripe payment page in your browser. Nothing else is contacted, and there is no telemetry.

The tool never prints your API key or private key.

## The signing code

`cli/wallet.mjs` implements keccak256, secp256k1 and ECDSA from scratch, to keep the tool free of dependencies. It is checked against published test values. It is not constant-time and has not been audited. It is meant for signing one login message on your own machine.

## Reporting a problem

Please open a private security advisory on this repository rather than a public issue.
