# Stillwater signer Worker

This Worker is a private signing boundary for Arc Mainnet. It must be called only through a Cloudflare service binding and must never receive a public route, `workers.dev` URL, or preview URL (`wrangler.jsonc` disables both).

Before deployment:

1. The D1 database it shares with the API (`DB`) is set in `wrangler.jsonc`.
2. Generate a random 32-byte wrapping key (`openssl rand -base64 32`) and add it as the `WALLET_KEK_V1` secret under the Worker's Settings → Variables & Secrets in the Cloudflare dashboard. Keep a copy: without it no managed wallet can be decrypted.
3. Do not copy that secret to the API, D1, build logs, or repository configuration.
4. The API reaches this Worker through its `SIGNER` service binding.

Internal operations provision encrypted wallets, rotate wrapping-key versions, and evaluate, execute, and reconcile mainnet intents. They never return key material.

The mainnet policy decoder independently validates exact approval and Uniswap position calldata, payload hashes, ownership context, wallet state, configured value caps, recipient, liquidity, slippage, deadlines, emergency stop, and fresh simulation evidence. A private audit-only route loads prepared intents from D1, revalidates current Arc ownership/liquidity, replays the exact call at a safe block, and stores an allow/reject evaluation.

`POST /internal/v1/intents/rehearse-mainnet` extends that audit with execution-state checks. After an allowed evaluation it reads the wallet's pending nonce, atomically acquires the wallet's single execution slot under a 30-second lease, records the rehearsal, and releases the slot. An unexpired lease produces `WALLET_EXECUTION_BUSY`; an expired lease can be recovered. Rejected evaluations do not read or reserve a nonce.

`POST /internal/v1/attempts/reconcile-mainnet` reconciles an already-persisted transaction attempt. Receipts finalize confirmation or revert; a visible transaction remains submitted; a missing transaction requires three observations over at least ten minutes before being marked dropped. An unknown transaction consuming the reserved nonce, or a hash resolving to a different nonce, fails the intent and quarantines the wallet. Explicit replacements retain the same nonce and link the new attempt to the replaced attempt. No public or private route currently creates a mainnet attempt.

The internal `handoffMainnetSubmission` primitive is reserved for the future signer execution path and is not exposed as a request route. Given a hash and nonce produced after signing inside the signer boundary, it rechecks the pending intent, intent expiry, live lease, wallet, and reserved nonce. One D1 batch then creates exactly one submitted attempt, marks the intent submitted, and moves the wallet execution slot from reserved to submitted. This persistence must occur before broadcast so a later ambiguous broadcast response can be resolved by transaction hash.

`POST /internal/v1/intents/execute-mainnet` connects those controls into one executor. Policy evaluation must pass with the optional emergency stop off (`EMERGENCY_STOP` unset or not `true`). The executor signs the same in-memory intent object that passed policy, persists its derived hash before broadcast, and rejects a different RPC-returned hash. The API applies its own ownership check before calling this route.

None of the mainnet audit, rehearsal, or reconciliation paths loads a wrapping key, signs, or broadcasts.
