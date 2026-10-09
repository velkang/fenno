# Fenno

**Fenno** lets you earn from the tokens trading on Arc, from established assets to brand-new memecoins. Pick any token paired with USDC, set a price band in dollars, and earn a share of every trade while the price stays inside it. Pip, Fenno's AI guide, can watch your positions and move the band when the price wanders off.

Fenno works with the liquidity pools already on Arc (Uniswap v3 and v4). It doesn't run its own exchange, and it lists new pools within seconds of their creation.

Fenno is live at **https://fenno.velkan.xyz**, on Arc mainnet. It is **custodial**: signing in gives you your own Fenno wallet, and Fenno sends transactions from it on your behalf.

## What it does

- **Pond**: the home page. Each position shows whether it is earning, alongside Pip's notes on what to do next.
- **Explore pools**: every Arc token paired with USDC, newest first, or one looked up from a pasted token address.
- **Add liquidity**: on a pool page, buy the token with USDC if needed, pick a band (Wide, Balanced, Narrow, or custom) and confirm. Fenno won't open a band in a pool that is almost empty, since its price can't be trusted.
- **Swap**: trade in one pool you choose. Trades that would move the price more than 5% are refused, and almost-empty pools are marked.
- **Positions**: see what each position holds and has earned, collect fees, re-centre the band around today's price, or close it. Adding more and removing some work on v3 positions.
- **Pip**: per position, choose off, ask me first, or autopilot, with a limit on how much the position may hold and how many changes a day. Pip re-centres or closes positions when the price leaves the band, and every suggestion and change shows on the alerts page behind the bell.
- **Wallet**: deposit Arc USDC, and withdraw any token with a signature from your own sign-in account.

Listing a pool only means Fenno can work with it. Fenno does not review tokens or judge whether they are safe.

## How custody works

```text
Your sign-in account (email, Google or X) ── signs in (SIWE) and signs withdrawals
        │
        ▼
Fenno wallet (one per user, Circle developer-controlled) ── holds funds and positions
        ▲
        │ signed by Circle, only when the signer asks
Signer Worker (private, no public route) ── checks every transaction first
```

- Each Fenno wallet is a Circle developer-controlled wallet: Circle holds the keys, and no key is stored by Fenno.
- The signer re-checks every transaction on its own: target contract, calldata, amounts, recipient, slippage, deadline, and a fresh simulation. Only then does it ask Circle to sign, and it broadcasts only if the signed transaction is exactly the one it built.
- Requests from Pip are also checked against the user's mandate: only that position's pool, only the steps of a re-centre or close, within the value limit and the number of runs a day. Pip can never withdraw.
- One transaction per wallet is in flight at a time. Each signed transaction is recorded before it is broadcast, then reconciled against the chain.

## Repository layout

| Package       | What it is                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/`        | React 19 + Vite app, styled with Tailwind CSS v4; wallet connection via Reown AppKit and wagmi                                                                                                                                        |
| `api/`        | Hono API on Cloudflare Workers: sign-in, pools, intents, and the D1 migrations in `api/migrations/`                                                                                                                                   |
| `signer/`     | Private Worker that holds the key-wrapping secret, enforces the mainnet policy, and signs. See [signer/README.md](./signer/README.md)                                                                                                 |
| `indexer/`    | Worker that discovers Uniswap v3/v4 USDC pools as they are created (every ~10 s) and keeps a rolling 7-day list of them in D1                                                                                                         |
| `automation/` | Pip: one Durable Object per wallet watches the positions a user handed to Pip, asks Claude or OpenAI what to do when something changes, and re-centres or closes them (ask-first or autopilot) through the API like any other request |
| `chain/`      | Shared Arc and Uniswap addresses, reads, price math, and transaction builders                                                                                                                                                         |

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
   pnpm indexer:dev --inspector-port 9230
   ```

   ```bash
   pnpm web:dev
   ```

   The indexer needs its own debugger port (`--inspector-port 9230`) when it runs beside `pnpm dev`.

   Open http://localhost:5173 and sign in with email, Google or X; the first sign-in creates your account and your Fenno wallet. The web app proxies `/v1` and `/health` to the API. To use your own Reown project, set `VITE_REOWN_PROJECT_ID`.

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

| Variable                                    | Worker                           | Meaning                                                                                                                    |
| ------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CIRCLE_API_KEY`                            | signer                           | **Required secret**: the Circle API key for the account that holds Fenno wallets                                           |
| `CIRCLE_ENTITY_SECRET`                      | signer                           | **Required secret**: the registered 32-byte hex entity secret                                                              |
| `CIRCLE_WALLET_SET_ID`                      | signer                           | **Required**: the Circle wallet set new wallets are created in                                                             |
| `AUTH_URI`                                  | api                              | **Required**: the web app's URL; sign-in messages are bound to its host                                                    |
| `AUTH_COOKIE_SECURE`                        | api                              | Local only: `false` allows the session cookie over plain `http`. Never set it in production                                |
| `AGENT_SECRET`                              | api, automation                  | **Required for re-centring** (secret): shared by the two, so the automation Worker can act for a wallet within its mandate |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`       | automation                       | Secrets for the decision providers. Without a key for the chosen provider, Pip only watches and never decides              |
| `AGENT_PROVIDER`, `AGENT_FALLBACK_PROVIDER` | automation                       | Optional: which provider decides (`claude` by default) and which to try when it fails or declines                          |
| `AGENT_CLAUDE_MODEL`, `AGENT_OPENAI_MODEL`  | automation                       | Optional model overrides; defaults `claude-opus-5-5` and `gpt-6-astra`                                                     |
| `AGENT_DAILY_CALL_LIMIT`                    | automation                       | Optional: most model calls a day across all users (UTC days, default 200). Past it, Pip holds until the next day           |
| `EMERGENCY_STOP`                            | signer                           | Optional: `true` halts all signing                                                                                         |
| `ARC_RPC_URL`                               | api, signer, indexer, automation | Optional; without it, Blockdaemon's keyless Arc RPC (`https://rpc.blockdaemon.mainnet.arc.io`) is used                     |

Mainnet transactions are allowed by default; there are no per-action value or fee limits.

Never commit `.dev.vars` files or the `.wrangler/` state directories. Both are gitignored.

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

`check` type-checks every package; `test` runs the Vitest suites in `chain`, `api`, `signer`, `indexer`, and `automation`. Tests that call the live Arc network are skipped by default.
