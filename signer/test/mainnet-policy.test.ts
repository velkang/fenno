import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import {
  ARC_CHAIN_ID,
  ARC_TOKENS,
  alphaApprovalPayloadHash,
  approvalPayloadHash,
  buildApproval,
  buildAlphaApproval,
  buildCollectAll,
  buildFullWithdrawal,
  buildIncreaseLiquidity,
  buildMint,
  buildSwap,
  buildUsdcWithdrawal,
  buildArcV4Mint,
  buildArcV4Approval,
  buildArcV4Swap,
  buildArcV4PositionAction,
  arcV4MintPayloadHash,
  arcV4ApprovalPayloadHash,
  arcV4SwapPayloadHash,
  arcV4PositionActionPayloadHash,
  v4PoolId,
  positionActionPayloadHash,
  mintPayloadHash,
  swapPayloadHash,
  withdrawalPayloadHash,
} from "@actora/chain";
import {
  validateMainnetIntent,
  type MainnetPolicyRequest,
} from "../src/mainnet-policy";

const now = 2_000_000_000_000;
const wallet = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222" as const;

function request(
  overrides: Partial<MainnetPolicyRequest> = {},
): MainnetPolicyRequest {
  const approval = buildAlphaApproval({ token: "USDC", amount: 1_000_000n });
  return {
    now,
    emergencyStop: false,
    limits: { maxUsdc: 1_000_000_000n, maxCirBtc: 10_000_000n },
    wallet: { address: wallet, state: "active" },
    intent: {
      kind: "erc20_approval",
      status: "pending",
      expiresAt: now + 60_000,
      payloadHash: alphaApprovalPayloadHash(approval),
    },
    transaction: {
      chainId: ARC_CHAIN_ID,
      to: ARC_TOKENS.USDC.address,
      data: approval.data,
      value: 0n,
    },
    simulation: {
      success: true,
      blockNumber: 100n,
      latestBlockNumber: 101n,
    },
    ...overrides,
  };
}

describe("mainnet signer policy", () => {
  it("allows v4 collect and full withdrawal while paused without a trading cap", () => {
    const key = { currency0: zeroAddress, currency1: other, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000000000000000", lpFee: 3000 };
    for (const kind of ["collect", "withdraw"] as const) {
      const action = buildArcV4PositionAction({ kind, pool, tokenDecimals: 18,
        tokenId: 7n, recipient: wallet, liquidity: 100_000n,
        tickLower: -60, tickUpper: 60, slippageBps: 100,
        deadline: BigInt(Math.floor(now / 1_000) + 600) });
      const v4Request = request({
        wallet: { address: wallet, state: "paused" },
        limits: { maxUsdc: 0n, maxCirBtc: 0n },
        intent: { kind: kind === "collect" ? "v4_position_collect" : "v4_position_withdraw",
          status: "pending", expiresAt: now + 60_000,
          payloadHash: arcV4PositionActionPayloadHash(action) },
        transaction: { chainId: ARC_CHAIN_ID, to: action.to, data: action.data, value: 0n },
        v4PositionAction: { transaction: action },
      });
      expect(validateMainnetIntent(v4Request)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
      expect(validateMainnetIntent({ ...v4Request, transaction: { ...v4Request.transaction,
        data: "0x" } })).toEqual({ allowed: false, reason: "V4_POSITION_ACTION_INVALID" });
    }
  });
  it("binds a native-USDC v4 swap to the quoted limit and exact transaction", () => {
    const key = { currency0: zeroAddress, currency1: other, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000000000000000", lpFee: 3000 };
    const swap = buildArcV4Swap({ pool, tokenIn: zeroAddress,
      amountIn: 1_000_000_000_000_000_000n, amountOutMinimum: 950n,
      deadline: BigInt(Math.floor(now / 1_000) + 600) });
    const v4Request = request({
      limits: { maxUsdc: 10_000_000n, maxCirBtc: 0n },
      intent: { kind: "v4_single_pool_swap", status: "pending", expiresAt: now + 60_000,
        payloadHash: arcV4SwapPayloadHash(swap) },
      transaction: { chainId: ARC_CHAIN_ID, to: swap.to, data: swap.data, value: swap.value },
      v4Swap: { transaction: swap, freshAmountOut: 1_000n, usdcNotional: 1_000_000n },
    });
    expect(validateMainnetIntent(v4Request)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
    expect(validateMainnetIntent({ ...v4Request, transaction: { ...v4Request.transaction,
      value: 0n } })).toEqual({ allowed: false, reason: "V4_SWAP_LIMITS_INVALID" });
    expect(validateMainnetIntent({ ...v4Request, v4Swap: { ...v4Request.v4Swap!,
      freshAmountOut: 1_100n } })).toEqual({ allowed: false, reason: "V4_SWAP_LIMITS_INVALID" });
  });
  it("accepts only the exact native-USDC v4 mint value and calldata", () => {
    const key = { currency0: zeroAddress, currency1: other, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000000000000000", lpFee: 3000 };
    const mint = buildArcV4Mint({ pool, tokenDecimals: 18, recipient: wallet,
      tickLower: -60, tickUpper: 60, amount0Desired: 1_000_000_000_000_000_000n,
      amount1Desired: 1_000_000_000_000_000_000n, slippageBps: 100,
      deadline: BigInt(Math.floor(now / 1_000) + 600) });
    const v4Request = request({
      limits: { maxUsdc: 10_000_000n, maxCirBtc: 0n },
      intent: { kind: "v4_position_mint", status: "pending", expiresAt: now + 60_000,
        payloadHash: arcV4MintPayloadHash(mint) },
      transaction: { chainId: ARC_CHAIN_ID, to: mint.to, data: mint.data, value: mint.value },
      v4Mint: { transaction: mint, tokenNotionalUsdc: 1_000_000n, usdcAmount: 1_000_000n },
    });
    expect(validateMainnetIntent(v4Request)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
    expect(validateMainnetIntent({ ...v4Request, transaction: { ...v4Request.transaction,
      value: mint.value + 1n } })).toEqual({ allowed: false, reason: "V4_MINT_PARAMETERS_INVALID" });
    expect(validateMainnetIntent({ ...v4Request, v4Mint: { ...v4Request.v4Mint!,
      usdcAmount: 11_000_000n } })).toEqual({ allowed: false, reason: "VALUE_CAP_EXCEEDED" });
  });

  it("requires an exact v4 Permit2 approval for the selected pool", () => {
    const approval = buildArcV4Approval({ poolId: `0x${"11".repeat(32)}`, token: other,
      stage: "permit2", amount: 100n, expiration: BigInt(Math.floor(now / 1_000) + 600) });
    const v4Request = request({
      intent: { kind: "v4_approval", status: "pending", expiresAt: now + 60_000,
        payloadHash: arcV4ApprovalPayloadHash(approval) },
      transaction: { chainId: ARC_CHAIN_ID, to: approval.to, data: approval.data, value: 0n },
      v4Approval: { transaction: approval, usdcNotional: 1_000_000n },
    });
    expect(validateMainnetIntent(v4Request)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
    expect(validateMainnetIntent({ ...v4Request, transaction: { ...v4Request.transaction,
      data: "0x" } })).toEqual({ allowed: false, reason: "V4_APPROVAL_INVALID" });
  });
  it("allows an exact approval but never an altered payload", () => {
    expect(validateMainnetIntent(request())).toEqual({
      allowed: true,
      reason: "POLICY_ALLOWED",
    });
    expect(validateMainnetIntent(request({
      intent: { ...request().intent, payloadHash: `0x${"00".repeat(32)}` },
    }))).toEqual({ allowed: false, reason: "PAYLOAD_HASH_MISMATCH" });
  });

  it("allows a generic token approval only when its selected token is carried into policy", () => {
    const token = other;
    const approval = buildApproval({ tokenAddress: token, tokenSymbol: "MEME", amount: 10n });
    const generic = request({
      intent: {
        kind: "erc20_approval",
        status: "pending",
        expiresAt: now + 60_000,
        payloadHash: approvalPayloadHash(approval),
      },
      transaction: { chainId: ARC_CHAIN_ID, to: token, data: approval.data, value: 0n },
      approval: { tokenAddress: token, poolAddress: "0x3333333333333333333333333333333333333333" },
    });
    expect(validateMainnetIntent(generic)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
    expect(validateMainnetIntent({ ...generic, approval: { tokenAddress: ARC_TOKENS.USDC.address, poolAddress: "0x3333333333333333333333333333333333333333" } })).toEqual({
      allowed: false,
      reason: "TOKEN_NOT_ALLOWED",
    });
  });

  it("requires the configured private-alpha value cap", () => {
    expect(validateMainnetIntent(request({
      limits: { maxUsdc: 999_999n, maxCirBtc: 10_000_000n },
    }))).toEqual({ allowed: false, reason: "VALUE_CAP_EXCEEDED" });
  });

  it.each([
    [{ emergencyStop: true }, "EMERGENCY_STOP_ACTIVE"],
    [{ transaction: { ...request().transaction, chainId: 1 } }, "CHAIN_NOT_ALLOWED"],
    [{ transaction: { ...request().transaction, value: 1n } }, "NATIVE_VALUE_NOT_ALLOWED"],
    [{ simulation: { success: false, blockNumber: 100n, latestBlockNumber: 100n } }, "SIMULATION_FAILED"],
    [{ simulation: { success: true, blockNumber: 90n, latestBlockNumber: 100n } }, "SIMULATION_STALE"],
  ] as const)("rejects common unsafe state %#", (override, reason) => {
    expect(validateMainnetIntent(request(override))).toEqual({ allowed: false, reason });
  });

  it("allows collect while paused only when proceeds return to the wallet", () => {
    const action = buildCollectAll({ tokenId: 7n, recipient: wallet });
    const collect = request({
      wallet: { address: wallet, state: "paused" },
      intent: {
        kind: "position_collect",
        status: "pending",
        expiresAt: now + 60_000,
        payloadHash: positionActionPayloadHash(action),
      },
      transaction: {
        chainId: ARC_CHAIN_ID,
        to: action.to,
        data: action.data,
        value: 0n,
      },
      position: { tokenId: 7n, owner: wallet, liquidity: 500n },
    });
    expect(validateMainnetIntent(collect).allowed).toBe(true);
    expect(validateMainnetIntent({
      ...collect,
      position: { ...collect.position!, owner: other },
    })).toEqual({ allowed: false, reason: "POSITION_NOT_OWNED" });
  });

  it("blocks increases while paused", () => {
    const action = buildIncreaseLiquidity({
      tokenId: 7n,
      recipient: wallet,
      amountCirBtc: 100n,
      amountUsdc: 200n,
      slippageBps: 100,
      deadline: BigInt(Math.floor(now / 1_000) + 600),
    });
    const increase = request({
      wallet: { address: wallet, state: "paused" },
      intent: {
        kind: "position_increase",
        status: "pending",
        expiresAt: now + 60_000,
        payloadHash: positionActionPayloadHash(action),
      },
      transaction: { chainId: ARC_CHAIN_ID, to: action.to, data: action.data, value: 0n },
      position: { tokenId: 7n, owner: wallet, liquidity: 500n },
    });
    expect(validateMainnetIntent(increase)).toEqual({
      allowed: false,
      reason: "WALLET_NOT_SIGNABLE",
    });
  });

  it("allows only a complete ordered full-withdrawal multicall", () => {
    const action = buildFullWithdrawal({
      tokenId: 7n,
      recipient: wallet,
      liquidity: 500n,
      expectedCirBtc: 100n,
      expectedUsdc: 200n,
      slippageBps: 100,
      deadline: BigInt(Math.floor(now / 1_000) + 600),
    });
    const withdrawal = request({
      wallet: { address: wallet, state: "paused" },
      intent: {
        kind: "position_withdraw",
        status: "pending",
        expiresAt: now + 60_000,
        payloadHash: positionActionPayloadHash(action),
      },
      transaction: { chainId: ARC_CHAIN_ID, to: action.to, data: action.data, value: 0n },
      position: {
        tokenId: 7n,
        owner: wallet,
        liquidity: 500n,
        expectedCirBtc: 100n,
        expectedUsdc: 200n,
      },
    });
    expect(validateMainnetIntent(withdrawal)).toEqual({
      allowed: true,
      reason: "POLICY_ALLOWED",
    });
    expect(validateMainnetIntent({
      ...withdrawal,
      position: { ...withdrawal.position!, liquidity: 501n },
    })).toEqual({ allowed: false, reason: "WITHDRAWAL_SEQUENCE_INVALID" });
  });

  it("allows owner-authorized USDC exits while paused without applying the trading cap", () => {
    const transfer = buildUsdcWithdrawal({ wallet, recipient: other, amount: 20_000_000n,
      nonce: `0x${"11".repeat(32)}`, expiresAt: BigInt(Math.floor(now / 1_000) + 120) });
    const signature = `0x${"22".repeat(65)}` as const;
    const exit = request({
      wallet: { address: wallet, state: "paused" },
      emergencyStop: true,
      limits: { maxUsdc: 1_000_000n, maxCirBtc: 1n },
      intent: { kind: "usdc_withdrawal", status: "pending", expiresAt: now + 60_000,
        payloadHash: withdrawalPayloadHash(transfer, signature) },
      transaction: { chainId: ARC_CHAIN_ID, to: transfer.to, data: transfer.data, value: 0n },
      withdrawal: { transaction: transfer, signature, signatureValid: true },
    });
    expect(validateMainnetIntent(exit)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
    expect(validateMainnetIntent({ ...exit, withdrawal: { ...exit.withdrawal!, signatureValid: false } }))
      .toEqual({ allowed: false, reason: "OWNER_SIGNATURE_INVALID" });
    expect(validateMainnetIntent({ ...exit, transaction: { ...exit.transaction, data: "0x" } }))
      .toEqual({ allowed: false, reason: "WITHDRAWAL_CONTEXT_MISMATCH" });
  });

  it("checks single-pool swap output, deadline, cap, and exact calldata", () => {
    const swap = buildSwap({ poolAddress: "0x3333333333333333333333333333333333333333",
      poolFee: 3000, tokenIn: ARC_TOKENS.USDC.address, tokenOut: other,
      recipient: wallet, amountIn: 1_000_000n, amountOutMinimum: 950n,
      deadline: BigInt(Math.floor(now / 1_000) + 600) });
    const trade = request({
      intent: { kind: "single_pool_swap", status: "pending", expiresAt: now + 60_000,
        payloadHash: swapPayloadHash(swap) },
      transaction: { chainId: ARC_CHAIN_ID, to: swap.to, data: swap.data, value: 0n },
      swap: { transaction: swap, tokenAddress: other, freshAmountOut: 1000n },
    });
    expect(validateMainnetIntent(trade)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
    expect(validateMainnetIntent({ ...trade, swap: { transaction: swap, tokenAddress: other, freshAmountOut: 1100n } }))
      .toEqual({ allowed: false, reason: "SWAP_LIMITS_INVALID" });
    expect(validateMainnetIntent({ ...trade, swap: { transaction: swap, tokenAddress: wallet, freshAmountOut: 1000n } }))
      .toEqual({ allowed: false, reason: "SWAP_PAIR_INVALID" });
    expect(validateMainnetIntent({ ...trade, limits: { maxUsdc: 999_999n, maxCirBtc: 1n } }))
      .toEqual({ allowed: false, reason: "VALUE_CAP_EXCEEDED" });
    expect(validateMainnetIntent({ ...trade, transaction: { ...trade.transaction, data: "0x" } }))
      .toEqual({ allowed: false, reason: "SWAP_LIMITS_INVALID" });
  });

  it("caps a memecoin mint by quoted USDC value instead of cirBTC-sized token units", () => {
    const selectedPool = "0x3333333333333333333333333333333333333333" as const;
    const mint = buildMint({ pool: { address: selectedPool,
      token0: { address: other, symbol: "MEME", decimals: 18 },
      token1: ARC_TOKENS.USDC, fee: 3000, tickSpacing: 60 },
      recipient: wallet, tickLower: -120, tickUpper: 120,
      amount0Desired: 1_000_000_000_000_000_000n, amount1Desired: 1_000_000n,
      slippageBps: 100, deadline: BigInt(Math.floor(now / 1_000) + 600) });
    const mintRequest = request({
      limits: { maxUsdc: 10_000_000n, maxCirBtc: 50_000n },
      intent: { kind: "position_mint", status: "pending", expiresAt: now + 60_000,
        payloadHash: mintPayloadHash(mint) },
      transaction: { chainId: ARC_CHAIN_ID, to: mint.to, data: mint.data, value: 0n },
      mintPool: { poolAddress: selectedPool, token0: other, token1: ARC_TOKENS.USDC.address,
        fee: 3000, tickSpacing: 60, tokenDecimals: 18,
        tokenAmountQuoted: mint.amount0Desired, tokenNotionalUsdc: 2_000_000n },
    });
    expect(validateMainnetIntent(mintRequest)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
    expect(validateMainnetIntent({ ...mintRequest,
      mintPool: { ...mintRequest.mintPool!, tokenNotionalUsdc: 11_000_000n } }))
      .toEqual({ allowed: false, reason: "VALUE_CAP_EXCEEDED" });
  });
});
