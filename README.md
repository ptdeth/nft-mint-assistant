# NFT Mint Assistant

A safety-first TypeScript Node.js CLI for analyzing NFT mint pages and preparing validated EVM mint project configs for wallets you own and control.

This MVP targets:

- Ethereum mainnet
- Base mainnet
- Arbitrum One

The current MVP includes the project scaffold, CLI skeleton, config schema, chain registry, example config, README, and EVM dry-run support. Mint execution is intentionally not implemented yet.

## Safety Boundaries

This tool is only for wallets and private keys that you provide and control. It will not include captcha bypassing, anti-bot evasion, exploit logic, spam logic, allowlist bypassing, or rules circumvention.

Execution will remain blocked unless a saved config passes validation, the dry run shows a clear transaction summary, and `approved` is explicitly set to `true`. Low-confidence detections are never executable. Dry runs do not send transactions.

## Setup

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
```

Node.js 20 or newer is required.

## RPC URLs

Add RPC endpoints to `.env`:

```bash
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
BASE_RPC_URL=https://mainnet.base.org
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
```

The chain registry lives in `src/chains/chainRegistry.ts`.

## Wallets

For the MVP, wallets can be loaded from `.env`:

```bash
WALLETS=wallet1:0xYOUR_PRIVATE_KEY,wallet2:0xANOTHER_PRIVATE_KEY
```

Use only wallets you own and control. Prefer dedicated mint wallets with limited funds. Do not commit `.env`.

## Telegram Bot

Create a bot with Telegram's BotFather:

1. Open Telegram and message `@BotFather`.
2. Send `/newbot`.
3. Follow the prompts for bot name and username.
4. Copy the bot token into `.env` as `TELEGRAM_BOT_TOKEN`.
5. Find your numeric Telegram user ID, for example by messaging `@userinfobot`.
6. Add allowed IDs to `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:YOUR_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Run the bot:

```bash
npm run telegram
```

Telegram commands:

```text
/start
/help
/analyze <url>
/dryrun <configName>
/approve <configName>
/mint <configName>
/status
/limits
```

The bot only responds to `TELEGRAM_ALLOWED_USER_IDS`. It refuses private-key-like input and never needs private keys in Telegram. Keep wallet keys local in `.env`.

Config names map to files in `./mints`, so `/dryrun example.base` loads `./mints/example.base.json`. `/approve` runs a dry run first and only writes `approved: true` if the dry run passes cleanly. `/mint` refuses unless the config is already approved.

## Analyze Flow

```bash
npm run analyze -- --url "https://example.com/mint"
npm run analyze -- --url "https://example.com/mint" --verbose
```

`analyze` creates a draft config in `./mints`. For direct mint pages, it fetches public HTML and a small number of same-origin script assets, then scans for supported chain IDs, EVM contract addresses, ABI fragments, common mint functions, ETH price candidates, and possible start-time text.

For OpenSea collection URLs, it extracts the collection slug, tries to scan the public collection page for chain, contract, and external project URL hints, and scans the external project URL when one is visible.

Analyzer output is conservative. If required fields cannot be detected with enough confidence, the config is still saved with `approved: false` and `confidence: "low"`.

Examples for real mint pages:

```bash
npm run analyze -- --url "https://project.example/mint" --verbose
npm run analyze -- --url "https://mint.project.example" --out ./mints/project.example.json --verbose
npm run analyze -- --url "https://opensea.io/collection/example" --verbose
```

Review `detection.candidates` in the saved JSON before editing any selected contract, function, price, or limit values. The analyzer never sets `approved` to `true`.

## Dry Run Flow

```bash
npm run dryrun -- --config ./mints/example.base.json
```

This loads and validates the config, connects to the configured RPC, selects wallets from `.env`, prepares calldata, estimates gas, checks balances, runs a safe static call where possible, enforces spend and gas limits, and prints a no-send transaction summary.

Dry run requires:

- the matching RPC URL in `.env`
- at least one wallet in `WALLETS`
- an ABI fragment when the mint function cannot be represented as `function name(uint256 quantity) payable`

No transaction is sent by `dryrun`.

## Mint Flow

```bash
npm run mint -- --config ./mints/example.base.json
```

Mint execution sends real transactions only when the config is explicitly approved:

- `config.approved === true`
- detection confidence is not `low`
- wallets are loaded from `.env`
- RPC chain matches the config chain ID
- gas price is at or below `maxGasGwei`
- mint price is at or below `maxMintPriceEth`
- each next estimated send stays within `maxTotalSpendEth`
- selected wallets stay within `maxWallets`
- quantity stays within `perWalletMintLimit`
- attempts per wallet stay within `maxAttemptsPerWallet`

Before each send, the command estimates gas, checks balance, and performs a static call where possible. It logs every prepared, sent, confirmed, failed, or skipped attempt as JSONL under `./logs`.

`stopAfterSuccess: true` stops after the first confirmed successful receipt. When it is false, the command continues through configured wallets, but it still stops retrying a wallet after one successful receipt.

## Why Detection Can Be Incomplete

Some mint pages hide contract details behind client-side state, dynamic API calls, wallet-gated flows, custom routers, proxy contracts, or backend-generated signatures. The assistant may produce low or medium confidence output when it cannot safely determine the chain, contract, function, price, or timing from public page data.

When confidence is low, the config is review-only and cannot be approved for execution.
