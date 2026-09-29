# Stillwater signer Worker

This Worker is a private signing boundary. It must be called only through a Cloudflare service binding and must never receive a public route, `workers.dev` URL, or preview URL.

Before deployment:

1. Bind the same D1 database used by the API as `DB`.
2. Generate a random 32-byte wrapping key and store its base64 representation as the `WALLET_KEK_V1` Worker secret.
3. Do not copy that secret to the API, automation Worker, D1, CI output, or repository configuration.
4. Bind this Worker to the API or automation Worker as `SIGNER`.

Current internal operations provision encrypted wallets, execute the constrained Arc Testnet proof, rotate wrapping-key versions, and close an empty proof wallet. They never return key material. The proof executor reserves the pending nonce before signing, derives and atomically persists the signed hash before broadcast, verifies the RPC-returned hash, and reconciles the receipt. Ambiguous broadcast errors remain submitted; deterministic insufficient-funds rejection records `broadcast_failed` and releases the wallet slot for a funded retry.

The mainnet policy decoder independently validates exact approval and Uniswap position calldata, payload hashes, ownership context, wallet state, configured value caps, recipient, liquidity, slippage, deadlines, emergency stop, and fresh simulation evidence. A private audit-only route loads prepared intents from D1, revalidates current Arc ownership/liquidity, replays the exact call at a safe block, and stores an allow/reject evaluation.

`POST /internal/v1/intents/rehearse-mainnet` extends that audit with execution-state checks. After an allowed evaluation it reads the wallet's pending nonce, atomically acquires the wallet's single execution slot under a 30-second lease, records the rehearsal, and releases the slot. An unexpired lease produces `WALLET_EXECUTION_BUSY`; an expired lease can be recovered. Rejected evaluations do not read or reserve a nonce.

`POST /internal/v1/attempts/reconcile-mainnet` reconciles an already-persisted transaction attempt. Receipts finalize confirmation or revert; a visible transaction remains submitted; a missing transaction requires three observations over at least ten minutes before being marked dropped. An unknown transaction consuming the reserved nonce, or a hash resolving to a different nonce, fails the intent and quarantines the wallet. Explicit replacements retain the same nonce and link the new attempt to the replaced attempt. No public or private route currently creates a mainnet attempt.

The internal `handoffMainnetSubmission` primitive is reserved for the future signer execution path and is not exposed as a request route. Given a hash and nonce produced after signing inside the signer boundary, it rechecks the pending intent, intent expiry, live lease, wallet, and reserved nonce. One D1 batch then creates exactly one submitted attempt, marks the intent submitted, and moves the wallet execution slot from reserved to submitted. This persistence must occur before broadcast so a later ambiguous broadcast response can be resolved by transaction hash.

`POST /internal/v1/intents/execute-mainnet` connects those controls into one executor, but returns `MAINNET_EXECUTION_DISABLED` unless `MAINNET_EXECUTION_ENABLED` is exactly `true`. Even when enabled, policy evaluation must pass with the emergency stop off and nonzero token caps, and the padded gas limit multiplied by the RPC's maximum fee must not exceed `ALPHA_MAX_TX_FEE_RAW`. The executor signs the same in-memory intent object that passed policy, persists its derived hash before broadcast, and rejects a different RPC-returned hash. The API applies its own disabled flag and ownership check before calling this route.

None of the mainnet audit, rehearsal, or reconciliation paths loads a wrapping key, signs, or broadcasts. Safe defaults are zero token caps and an enabled mainnet emergency stop.
