# Stillwater

Stillwater manages Uniswap liquidity positions on the Arc blockchain for people who don't want to deal with ticks, raw token units, or transaction plumbing. You pick a pool, choose a price range in dollars, and Stillwater opens, tracks, and closes the position for you.

It is a **custodial alpha**. Anyone who signs in with a wallet gets their own Stillwater-managed wallet, and Stillwater's signer can send transactions from it. Every action is capped at a small value, checked by an isolated signer, and can be halted with an emergency stop. Nothing is deployed to Cloudflare yet; the stack runs locally.

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

4. Start the API and signer (port 8787), the indexer (port 8788), and the web app (port 5173), each in its own terminal:

   ```bash
   pnpm dev
   ```

   ```bash
   pnpm indexer:dev
   ```

   ```bash
   pnpm web:dev
   ```

   Open http://localhost:5173 and sign in with any wallet; the first sign-in creates your account. The web app proxies `/v1` and `/health` to the API. To use your own Reown project, set `VITE_REOWN_PROJECT_ID`.

The indexer runs three jobs on their own schedules: wallets (`*/5`), v3 pools (`1-59/5`) and v4 pools (`2-59/5`). To trigger one by hand, for example the wallet job:

```bash
curl 'http://127.0.0.1:8788/__scheduled?cron=*/5+*+*+*+*'
```

`GET /health/indexer` on the API reports whether indexing is running and recent.

## Configuration

The `wrangler.jsonc` files hold only what is not a setting: Worker names, the database binding, the links between Workers and the indexer's schedule. The D1 binding names two databases: `database_id` is production, and `preview_database_id` is the separate database used by `wrangler dev` and local D1 commands.

All variables and secrets live outside the repository: in the Cloudflare dashboard for production (`keep_vars` stops deploys from overwriting them) and in each Worker's gitignored `.dev.vars` locally. Copy the `.dev.vars.example` files to start.

| Variable | Worker | Meaning |
| --- | --- | --- |
| `WALLET_KEK_V1` | signer | **Required secret**: the key that wraps every managed wallet key |
| `AUTH_URI` | api | **Required**: the web app's URL; sign-in messages are bound to its host |
| `AUTH_COOKIE_SECURE` | api | Local only: `false` allows the session cookie over plain `http`. Never set it in production |
| `EMERGENCY_STOP` | signer | Optional: `true` halts all signing except USDC withdrawals |
| `ARC_RPC_URL` | api, signer, indexer | Optional; without it, Blockdaemon's keyless Arc RPC (`https://rpc.blockdaemon.mainnet.arc.io`) is used |
| `WALLET_KEK_V2` | signer | Optional secret, only needed to rotate to a new wrapping key |

Mainnet transactions are allowed by default; there are no per-action value or fee limits.

Never commit `.dev.vars` files or the `.wrangler/` state directories. Both are gitignored.

## Deploying to Cloudflare

Stillwater fits Cloudflare's free plan and free `*.workers.dev` addresses, and is deployed from the Cloudflare dashboard. There are four Workers: the website (`stillwater-web`) serves the app and forwards `/v1` and `/health` to the API (`stillwater-api`) through a service binding, so each has its own URL while the sign-in cookie stays on the website's host. The API reaches the private signer (`stillwater-signer`); the indexer (`stillwater-indexer`) runs on a schedule.

1. **Create the production database.** In the dashboard, go to Storage & Databases → D1 and create a database named `stillwater-prod`. Copy its ID into `database_id` in `api/`, `signer/` and `indexer/wrangler.jsonc` (replacing `PASTE_PRODUCTION_D1_ID`), and push.

2. **Create the Workers from the repository.** In Workers & Pages, choose Create → Import a repository, pick this repository, and create one Worker per row, in this order (the API needs the signer, and the website needs the API). The Worker name must match the `name` in that folder's `wrangler.jsonc`.

   | Worker name | Root directory | Build command | Deploy command |
   | --- | --- | --- | --- |
   | `stillwater-signer` | `signer` | `pnpm install --frozen-lockfile` | `npx wrangler deploy` (default) |
   | `stillwater-api` | `api` | `pnpm install --frozen-lockfile` | `npx wrangler d1 migrations apply stillwater-prod --remote && npx wrangler deploy` |
   | `stillwater-web` | `web` | `pnpm install --frozen-lockfile && pnpm build` | `npx wrangler deploy` (default) |
   | `stillwater-indexer` | `indexer` | `pnpm install --frozen-lockfile` | `npx wrangler deploy` (default) |

   - The API's deploy command applies any new database migrations before each deploy.
   - For `stillwater-web`, add the build variable `VITE_REOWN_PROJECT_ID` (your Reown project ID) and add the website's URL to that Reown project's allowed domains.
   - Optionally set build watch paths so a Worker rebuilds only when its folder or `chain/` changes.
   - If a build fails on the Node or pnpm version, add the build variables `NODE_VERSION` = `22` and `PNPM_VERSION` = `11.1.0`. If the migration step fails for lack of permission, give the build's API token D1 edit access, or run the migrations once yourself.

3. **Set the two required values.** Under each Worker's Settings → Variables & Secrets:

   | Worker | Name | Type | Value |
   | --- | --- | --- | --- |
   | `stillwater-signer` | `WALLET_KEK_V1` | Secret | Output of `openssl rand -base64 32`. Keep a copy somewhere safe: without it no managed wallet can be decrypted |
   | `stillwater-api` | `AUTH_URI` | Text | The website's URL, shown on the `stillwater-web` Worker's page, e.g. `https://stillwater-web.<your-subdomain>.workers.dev` |

4. **Open the website and sign in.** Saving a variable in the dashboard applies it immediately, so setting `EMERGENCY_STOP` to `true` on the signer halts signing without a commit.

In production, Explore lists pools with trades or liquidity changes from the first indexer run onward; it does not crawl older history. The indexer's three jobs run on separate schedules so each stays within the free plan's per-run limits.

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
- An independent security review of custody, the signer policy, and withdrawals.
