# Stillwater

Stillwater manages Uniswap liquidity positions on the Arc blockchain for people who don't want to deal with ticks, raw token units, or transaction plumbing. You pick a pool, choose a price range in dollars, and Stillwater opens, tracks, and closes the position for you.

It is a **private, custodial alpha**. Each invited user gets their own Stillwater-managed wallet, and Stillwater's signer can send transactions from it. Every action is capped at a small value, checked by an isolated signer, and can be halted with an emergency stop. Nothing is deployed to Cloudflare yet; the stack runs locally.

Stillwater does not run its own exchange. It uses the existing Uniswap v3 and v4 deployments on Arc.

## What it does

- **Explore pools**: lists Arc token/USDC pools on Uniswap v3 and v4, or looks one up from a pasted token address.
- **Add liquidity**: on a pool page, buy the token with USDC if needed, pick a range (Wide, Balanced, Narrow, or custom), and review the exact transactions before confirming.
- **Positions**: see whether each position is earning, collect fees, add more, remove some, or close it.
- **Wallet**: deposit Arc USDC to your Stillwater wallet and withdraw it with a signature from your own wallet.

Listing a pool only means Stillwater can work with it. Stillwater does not review tokens or judge whether they are safe.

## How custody works

```text
Your owner wallet ── signs in (SIWE) and signs withdrawals
        │
        ▼
Stillwater wallet (one EOA per user) ── holds funds and Uniswap positions
        ▲
        │ signs only after its own policy checks
Signer Worker (private, no public route)
```

- The Stillwater wallet's private key is encrypted (AES-256-GCM, per-wallet data key wrapped by a signer-only key) and stored in D1. The API can't decrypt it and never returns it.
- The signer re-checks every transaction on its own: target contract, calldata, amounts against the caps, recipient, slippage, deadline, and a fresh simulation.
- One transaction per wallet is in flight at a time. Each signed transaction is recorded before it is broadcast, then reconciled against the chain.

## Repository layout

| Package | What it is |
| --- | --- |
| `web/` | React 19 + Vite app, styled with Tailwind CSS v4; wallet connection via Reown AppKit and wagmi |
| `api/` | Hono API on Cloudflare Workers: sign-in, pools, intents, and the D1 migrations in `api/migrations/` |
| `signer/` | Private Worker that holds the key-wrapping secret, enforces the mainnet policy, and signs. See [signer/README.md](./signer/README.md) |
| `indexer/` | Scheduled Worker (every 5 minutes) that snapshots pools, wallets, and positions into D1 |
| `chain/` | Shared Arc and Uniswap addresses, reads, price math, and transaction builders |

## Running locally

Requires Node 22.13 or newer and pnpm 11.

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create the local secrets files from the examples:

   ```bash
   cp api/.dev.vars.example api/.dev.vars
   cp signer/.dev.vars.example signer/.dev.vars
   ```

   In `signer/.dev.vars`, set `WALLET_KEK_V1` to a fresh 32-byte key (`openssl rand -base64 32`). Use it only for local development. Anyone with this key and the local database controls the wallets in it.

3. Create the local database:

   ```bash
   pnpm db:migrate:local
   ```

4. Create an invitation code. It is printed once:

   ```bash
   pnpm invite:create:local
   ```

   This script lives in `api/scripts/`, which is not committed to this repository.

5. Start the API and signer (port 8787), the indexer (port 8788), and the web app (port 5173), each in its own terminal:

   ```bash
   pnpm dev
   ```

   ```bash
   pnpm indexer:dev
   ```

   ```bash
   pnpm web:dev
   ```

   Open http://localhost:5173. The web app proxies `/v1` and `/health` to the API. To use your own Reown project, set `VITE_REOWN_PROJECT_ID`.

The indexer only runs on its schedule. To trigger one run by hand:

```bash
curl 'http://127.0.0.1:8788/__scheduled?cron=*/5+*+*+*+*'
```

`GET /health/indexer` on the API reports whether indexing is running and recent.

## Mainnet safety settings

These are Worker variables in `api/wrangler.jsonc` and `signer/wrangler.jsonc`. Values in a `.dev.vars` file override them locally.

| Variable | Worker | Meaning |
| --- | --- | --- |
| `MAINNET_EXECUTION_ENABLED` | api, signer | Must be exactly `true` in both for any mainnet transaction to be sent |
| `MAINNET_EMERGENCY_STOP` | signer | `true` blocks all mainnet signing |
| `ALPHA_MAX_USDC_RAW` | signer | Largest USDC amount per action, in raw units (`10000000` = 10 USDC) |
| `ALPHA_MAX_CIRBTC_RAW` | signer | Largest cirBTC amount per action (`50000` = 0.0005 cirBTC); scaled to other tokens' decimals |
| `ALPHA_MAX_TX_FEE_RAW` | signer | Largest network fee per transaction (`100000000000000000` = 0.1 USDC) |

The committed configuration currently has mainnet execution **enabled** with the emergency stop **off**, for funded local testing. Set `MAINNET_EXECUTION_ENABLED` to `false` whenever you are not deliberately testing with real funds.

Never commit `.dev.vars` files or the `.wrangler/` state directories. Both are gitignored.

## Checks

```bash
pnpm check
```

```bash
pnpm test
```

`check` type-checks every package; `test` runs the Vitest suites in `chain`, `api`, `signer`, and `indexer`. Tests that call the live Arc network are skipped by default.

## Not built yet

- Automation: rebalancing when the price leaves the range, fee compounding, retries, and alerts.
- Deployment to Cloudflare (Workers, remote D1, secrets, secure cookies).
- An independent security review of custody, the signer policy, and withdrawals.
