# Fenno

Fenno manages Uniswap liquidity positions on the Arc blockchain for people who don't want to deal with ticks, raw token units, or transaction plumbing. You pick a pool, choose a price range in dollars, and Fenno opens, tracks, and closes the position for you.

It is a **custodial alpha**. Anyone who signs in with a wallet gets their own Fenno-managed wallet, and Fenno's signer can send transactions from it. Every action is capped at a small value, checked by an isolated signer, and can be halted with an emergency stop. Nothing is deployed to Cloudflare yet; the stack runs locally.

Fenno does not run its own exchange. It uses the existing Uniswap v3 and v4 deployments on Arc.

## What it does

- **Explore pools**: lists Arc token/USDC pools on Uniswap v3 and v4, or looks one up from a pasted token address.
- **Add liquidity**: on a pool page, buy the token with USDC if needed, pick a range (Wide, Balanced, Narrow, or custom), and review the exact transactions before confirming.
- **Positions**: see whether each position is earning, collect fees, add more, remove some, or close it.
- **Wallet**: deposit Arc USDC to your Fenno wallet and withdraw it with a signature from your own wallet.

Listing a pool only means Fenno can work with it. Fenno does not review tokens or judge whether they are safe.

## How custody works

```text
Your owner wallet ── signs in (SIWE) and signs withdrawals
        │
        ▼
Fenno wallet (one EOA per user) ── holds funds and Uniswap positions
        ▲
        │ signs only after its own policy checks
Signer Worker (private, no public route)
```

- The Fenno wallet's private key is encrypted (AES-256-GCM, per-wallet data key wrapped by a signer-only key) and stored in D1. The API can't decrypt it and never returns it.
- The signer re-checks every transaction on its own: target contract, calldata, amounts against the caps, recipient, slippage, deadline, and a fresh simulation.
- One transaction per wallet is in flight at a time. Each signed transaction is recorded before it is broadcast, then reconciled against the chain.

## Repository layout

| Package | What it is |
| --- | --- |
| `web/` | React 19 + Vite app, styled with Tailwind CSS v4; wallet connection via Reown AppKit and wagmi |
| `api/` | Hono API on Cloudflare Workers: sign-in, pools, intents, and the D1 migrations in `api/migrations/` |
| `signer/` | Private Worker that holds the key-wrapping secret, enforces the mainnet policy, and signs. See [signer/README.md](./signer/README.md) |
| `indexer/` | Worker that discovers Uniswap v3/v4 USDC pools as they are created (every ~10 s) and keeps a rolling 7-day list of them in D1 |
| `automation/` | Worker that looks after v3 and v4 positions: one Durable Object per wallet watches the positions a user handed to Pip, asks Claude or OpenAI what to do when something changes, and re-centres or closes them (ask-first or autopilot) through the API like any other request |
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
   cp automation/.dev.vars.example automation/.dev.vars
   ```

   To run re-centring locally, put the same random value in `AGENT_SECRET` in `api/.dev.vars` and `automation/.dev.vars` (for example from `openssl rand -hex 32`). Without it, a re-centre stops before sending anything.

   In `signer/.dev.vars`, set the three `CIRCLE_*` values (see [Circle wallets](#circle-wallets)). Anyone with the API key and entity secret controls every Fenno wallet in that Circle account.

3. Create the local database:

   ```bash
   pnpm db:migrate:local
   ```

4. Start the API, signer and automation Worker (port 8787), the indexer (port 8788), and the web app (port 5173), each in its own terminal:

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

The indexer finds pools from their creation events (v3 `PoolCreated`, v4 `Initialize`), filtered to USDC pairs. The database holds only a rolling list of recent pools, because the chain can't answer "list the newest pools" or "find by symbol". Prices, liquidity, balances and positions are read from the chain when shown:

- **Live:** a Durable Object (`PoolDiscovery`) checks for new pools every ~10 s, so a new pool is listed within seconds. It saves its position about once a minute.
- **Refresh:** every 5 minutes (offset by 2), a slice of the list is re-checked. It records only when a pool's liquidity appears or disappears, and removes pools that have gone a week without that, unless someone has used them through Fenno.
- **Expired actions:** every 5 minutes, approved actions nobody confirmed in time are marked expired.

Older pools are not stored. A contract address pasted into search that is not listed is looked up on chain at once (the API asks the indexer through a service binding) and listed again for a week. Search by symbol matches from the start of the symbol.

Triggering the minute cron by hand also starts the live loop:

```bash
curl 'http://127.0.0.1:8788/__scheduled?cron=*+*+*+*+*'
```

`GET /health/indexer` on the API reports how long ago each protocol's live discovery position was saved, and `stale` once that is more than 3 minutes.

## Configuration

The `wrangler.jsonc` files hold only what is not a setting: Worker names, the database binding, the links between Workers and the indexer's schedule. The D1 binding names two databases: `database_id` is production, and `preview_database_id` is the separate database used by `wrangler dev` and local D1 commands.

All variables and secrets live outside the repository: in the Cloudflare dashboard for production (`keep_vars` stops deploys from overwriting them) and in each Worker's gitignored `.dev.vars` locally. Copy the `.dev.vars.example` files to start.

| Variable | Worker | Meaning |
| --- | --- | --- |
| `CIRCLE_API_KEY` | signer | **Required secret**: the Circle API key for the account that holds Fenno wallets |
| `CIRCLE_ENTITY_SECRET` | signer | **Required secret**: the registered 32-byte hex entity secret |
| `CIRCLE_WALLET_SET_ID` | signer | **Required**: the Circle wallet set new wallets are created in |
| `AUTH_URI` | api | **Required**: the web app's URL; sign-in messages are bound to its host |
| `AUTH_COOKIE_SECURE` | api | Local only: `false` allows the session cookie over plain `http`. Never set it in production |
| `AGENT_SECRET` | api, automation | **Required for re-centring** (secret): shared by the two, so the automation Worker can act for a wallet within its mandate |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | automation | Secrets for the decision providers. Without a key for the chosen provider, Pip only watches and never decides |
| `AGENT_PROVIDER`, `AGENT_FALLBACK_PROVIDER` | automation | Optional: which provider decides (`claude` by default) and which to try when it fails or declines |
| `AGENT_CLAUDE_MODEL`, `AGENT_OPENAI_MODEL` | automation | Optional model overrides; defaults `claude-opus-5-5` and `gpt-6-astra` |
| `AGENT_DAILY_CALL_LIMIT` | automation | Optional: most model calls a day across all users (UTC days, default 200). Past it, Pip holds until the next day |
| `EMERGENCY_STOP` | signer | Optional: `true` halts all signing except USDC withdrawals |
| `ARC_RPC_URL` | api, signer, indexer, automation | Optional; without it, Blockdaemon's keyless Arc RPC (`https://rpc.blockdaemon.mainnet.arc.io`) is used |

Mainnet transactions are allowed by default; there are no per-action value or fee limits.

Never commit `.dev.vars` files or the `.wrangler/` state directories. Both are gitignored.

## Deploying to Cloudflare

Fenno is deployed from the Cloudflare dashboard.

Fenno was called Stillwater, and its Workers, database, packages and internal headers keep the `stillwater` name: nobody sees them, and renaming a Worker means recreating it.

There are five Workers:
- **`stillwater-web`**, the website, serves the app and forwards `/v1` and `/health` to the API through a service binding. Each Worker keeps its own URL while the sign-in cookie stays on the website's host.
- **`stillwater-api`**, the API, reaches the private signer and the indexer through service bindings.
- **`stillwater-signer`**, the private signer.
- **`stillwater-indexer`**, which runs pool discovery and the scheduled jobs.
- **`stillwater-automation`**, which re-centres positions. The API wakes it through a service binding, and it calls the API back as the agent.

1. **Create the production database.** In the dashboard, go to Storage & Databases → D1 and create a database named `stillwater-prod`. Copy its ID into `database_id` in `api/`, `signer/` and `indexer/wrangler.jsonc` (replacing `PASTE_PRODUCTION_D1_ID`), and push.

2. **Create the Workers from the repository.** In Workers & Pages, choose Create → Import a repository, pick this repository, and create one Worker per row, in this order (the API needs the signer, and the website needs the API). The Worker name must match the `name` in that folder's `wrangler.jsonc`.

   | Worker name | Root directory | Build command | Deploy command |
   | --- | --- | --- | --- |
   | `stillwater-signer` | `signer` | `pnpm install --frozen-lockfile` | `npx wrangler deploy` (default) |
   | `stillwater-api` | `api` | `pnpm install --frozen-lockfile` | `npx wrangler d1 migrations apply stillwater-prod --remote && npx wrangler deploy` |
   | `stillwater-web` | `web` | `pnpm install --frozen-lockfile && pnpm build` | `npx wrangler deploy` (default) |
   | `stillwater-indexer` | `indexer` | `pnpm install --frozen-lockfile` | `npx wrangler deploy` (default) |
   | `stillwater-automation` | `automation` | `pnpm install --frozen-lockfile` | `npx wrangler deploy` (default) |

   The API and the automation Worker each bind to the other. Create `stillwater-automation` after the API exists. If the API's own build fails because `stillwater-automation` doesn't exist yet, retry it once the automation Worker is deployed.

   - The API's deploy command applies any new database migrations before each deploy.
   - For `stillwater-web`, add the build variable `VITE_REOWN_PROJECT_ID` (your Reown project ID) and add the website's URL to that Reown project's allowed domains. People sign in with email, Google or X only; if the Reown project shows sign-in toggles, turn those three on and wallets off.
   - Optionally set build watch paths so a Worker rebuilds only when its folder or `chain/` changes.
   - If a build fails on the Node or pnpm version, add the build variables `NODE_VERSION` = `22` and `PNPM_VERSION` = `11.1.0`. If the migration step fails for lack of permission, give the build's API token D1 edit access, or run the migrations once yourself.

3. **Set the required values.** Under each Worker's Settings → Variables & Secrets:

   | Worker | Name | Type | Value |
   | --- | --- | --- | --- |
   | `stillwater-signer` | `CIRCLE_API_KEY` | Secret | Your Circle mainnet API key |
   | `stillwater-signer` | `CIRCLE_ENTITY_SECRET` | Secret | Your registered entity secret |
   | `stillwater-signer` | `CIRCLE_WALLET_SET_ID` | Text | The wallet set's id |
   | `stillwater-api` | `AUTH_URI` | Text | The website's URL, shown on the `stillwater-web` Worker's page, e.g. `https://stillwater-web.<your-subdomain>.workers.dev` |
   | `stillwater-api` | `AGENT_SECRET` | Secret | A long random value, e.g. from `openssl rand -hex 32` |
   | `stillwater-automation` | `AGENT_SECRET` | Secret | The same value as the API's |
   | `stillwater-automation` | `ANTHROPIC_API_KEY` | Secret | For Claude to decide (the default provider) |
   | `stillwater-automation` | `OPENAI_API_KEY` | Secret | Optional: for OpenAI, as the provider or the fallback |
   | `stillwater-automation` | `AGENT_PROVIDER` | Text | Optional: `claude` (default) or `openai` |
   | `stillwater-automation` | `AGENT_FALLBACK_PROVIDER` | Text | Optional: the other provider, used when the first fails or declines |

4. **Open the website and sign in.** Saving a variable in the dashboard applies it immediately, so setting `EMERGENCY_STOP` to `true` on the signer halts signing without a commit.

In production, Explore lists the last week's pools newest first, with live on-chain prices. New pools appear within seconds. An older token is found by pasting its contract address.

## Circle wallets

Fenno wallets are Circle developer-controlled wallets: Circle holds the keys, and the signer asks Circle to sign each transaction it has checked, then broadcasts it itself. Set this up once in the Circle Developer Console, on mainnet:

1. Create an API key.
2. Generate and register an entity secret, and keep the recovery file somewhere safe.
3. Create a wallet set and note its id.

Wallets are created on Circle's `EVM` chain, which signs for Arc by chain id. The signer fetches the entity public key from Circle itself.

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
