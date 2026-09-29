# Actora

Actora is an automated Uniswap liquidity-position manager for Arc.

The first release is a restricted private alpha. Each invited user receives a unique Actora-managed EOA, funds it directly, and can use Actora to manage one of a small set of allowlisted Uniswap positions. The alpha is custodial: Actora's signer can authorize transactions from the managed wallet. Hard value caps, verified withdrawal addresses, isolated signing, and an emergency stop are launch requirements.

Actora is not deploying its own AMM for the alpha. The LFJ Liquidity Book code under `contracts/` is retained as prior compatibility research and is not a production dependency. See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for the current plan.

The invitation, SIWE authentication, local D1, private signer binding, and encrypted managed-wallet provisioning flow runs locally. See [docs/local-development.md](./docs/local-development.md).

The constrained signer transaction is confirmed on Arc Testnet; evidence is recorded in [docs/arc-testnet-signer-proof.md](./docs/arc-testnet-signer-proof.md).

The authenticated API exposes an Arc mainnet summary at `GET /v1/wallets/summary`, including the pinned cirBTC/USDC pool, decimal-correct price, managed-wallet balances and allowances, matching Uniswap v3 positions, and claimable fees. It also supports minimal CA discovery for existing initialized Arc Uniswap v3 token/USDC pools and generic approval/mint preparation; it does not score or endorse tokens. Live Arc Mainnet position minting is active and verified under strict policy value caps. See [docs/code-summary.md](./docs/code-summary.md) for the complete journey and current architecture state.

## Contract research

The archived baseline is pinned to LFJ `joe-v2` v2.2.0 at commit `1297c3822f0605e643155c35948959c0a0d05e17`. Core AMM source has not been modified.

```sh
pnpm contracts:build
pnpm contracts:test
```

The default test command runs the reproducible local baseline. Avalanche fork tests and two upstream resource-exhaustion oracle cases are separate; their status is documented in [docs/upstream-baseline.md](./docs/upstream-baseline.md).

## Deployment accounts

Actora deployment commands use a Foundry keystore account. Raw private-key environment variables are not supported.

```sh
cd contracts
cp .env.example .env
# Fill only public deployment configuration in .env.
set -a; source .env; set +a
./bin/deploy-reference-core arc-testnet YOUR_FOUNDRY_ACCOUNT
```

The command passes the account name to `forge script --account`; Foundry prompts for the keystore password. Do not put a password or private key in `.env`.

Before deploying the reference core, deploy the small compatibility probe to Arc Testnet:

```sh
cd contracts
export ACTORA_COMPATIBILITY_RECIPIENT=0xYourAddress
./bin/deploy-arc-compatibility YOUR_FOUNDRY_ACCOUNT
```

This uses the same keystore flow and writes the resulting addresses to `contracts/deployments/compatibility-5042002.json`. The probe does not deploy the AMM or require a WNATIVE decision.
