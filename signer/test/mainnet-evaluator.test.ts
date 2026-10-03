import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import {
  ARC_CHAIN_ID,
  ARC_TOKENS,
  alphaApprovalPayloadHash,
  buildAlphaApproval,
  buildArcV4Swap,
  buildArcV4PositionAction,
  arcV4PositionActionPayloadHash,
  arcV4SwapPayloadHash,
  v4PoolId,
} from "@stillwater/chain";
import {
  evaluateMainnetIntent,
  type LoadedMainnetIntent,
  type MainnetAuditClient,
  type MainnetEvaluation,
  type MainnetEvaluationStore,
} from "../src/mainnet-evaluator";

const wallet = "0x1111111111111111111111111111111111111111" as const;
const blockHash = `0x${"ab".repeat(32)}` as const;
const now = 2_000_000_000_000;

class MemoryStore implements MainnetEvaluationStore {
  evaluations: MainnetEvaluation[] = [];
  constructor(readonly intent: LoadedMainnetIntent | null) {}
  async load() { return this.intent; }
  async save(value: MainnetEvaluation) { this.evaluations.push(value); }
}

function fixture(): LoadedMainnetIntent {
  const approval = buildAlphaApproval({ token: "USDC", amount: 1_000_000n });
  return {
    intentId: "approval-1",
    kind: "erc20_approval",
    status: "pending",
    expiresAt: now + 60_000,
    payloadHash: alphaApprovalPayloadHash(approval),
    wallet: { address: wallet, state: "active" },
    transaction: {
      chainId: ARC_CHAIN_ID,
      to: approval.to,
      data: approval.data,
      value: 0n,
    },
  };
}

function client(call: () => Promise<unknown>): MainnetAuditClient {
  return {
    getBlock: async () => ({ number: 100n, hash: blockHash }),
    call,
  } as unknown as MainnetAuditClient;
}

describe("mainnet audit-only evaluator", () => {
  it("rebuilds a v4 withdrawal from current NFT ownership and rejects transfers", async () => {
    const token = "0x2222222222222222222222222222222222222222" as const;
    const key = { currency0: zeroAddress, currency1: token, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000", lpFee: 3000 };
    const deadline = BigInt(Math.floor(now / 1_000) + 600);
    const action = buildArcV4PositionAction({ kind: "withdraw", pool,
      tokenDecimals: 18, tokenId: 7n, recipient: wallet, liquidity: 100_000n,
      tickLower: -60, tickUpper: 60, slippageBps: 100, deadline });
    const loaded: LoadedMainnetIntent = { ...fixture(), intentId: "v4-withdraw-1",
      kind: "v4_position_withdraw", wallet: { address: wallet, state: "paused" },
      payloadHash: arcV4PositionActionPayloadHash(action),
      transaction: { chainId: ARC_CHAIN_ID, to: action.to, data: action.data, value: 0n },
      v4PositionAction: { kind: "withdraw", poolId: pool.id, tokenId: 7n,
        tickLower: -60, tickUpper: 60, liquidity: 100_000n, tokenDecimals: 18,
        slippageBps: 100, deadline, recipient: wallet } };
    const makeChain = (owner: string) => ({
      getBlock: async () => ({ number: 100n, hash: blockHash }),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getPoolAndPositionInfo") return [key,
          (((1n << 24n) - 60n) << 8n) | (60n << 32n)];
        if (functionName === "getPositionLiquidity") return 100_000n;
        if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
        if (functionName === "getLiquidity") return 1_000_000n;
        if (functionName === "decimals") return 18;
        throw new Error("Unexpected read");
      },
      call: async () => ({ data: "0x" }),
    } as unknown as MainnetAuditClient);
    const allowed = await evaluateMainnetIntent({ intentId: loaded.intentId,
      store: new MemoryStore(loaded), client: makeChain(wallet), emergencyStop: false, now: () => now });
    expect(allowed.decision).toBe("allowed");
    const rejected = await evaluateMainnetIntent({ intentId: loaded.intentId,
      store: new MemoryStore(loaded), client: makeChain(token), emergencyStop: false, now: () => now });
    expect(rejected.reasonCode).toBe("CHAIN_REVALIDATION_FAILED");
  });
  it("re-quotes and reconstructs a v4 swap before allowing signing", async () => {
    const token = "0x2222222222222222222222222222222222222222" as const;
    const key = { currency0: zeroAddress, currency1: token, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000", lpFee: 3000 };
    const swap = buildArcV4Swap({ pool, tokenIn: zeroAddress,
      amountIn: 1_000_000_000_000_000_000n, amountOutMinimum: 990n,
      deadline: BigInt(Math.floor(now / 1_000) + 600) });
    const store = new MemoryStore({
      ...fixture(), intentId: "v4-swap-1", kind: "v4_single_pool_swap",
      payloadHash: arcV4SwapPayloadHash(swap),
      transaction: { chainId: ARC_CHAIN_ID, to: swap.to, data: swap.data, value: swap.value },
      v4Swap: { pool, tokenIn: zeroAddress, amountIn: swap.amountIn,
        amountOutMinimum: swap.amountOutMinimum, deadline: swap.deadline },
    });
    const chain = {
      getBlock: async () => ({ number: 100n, hash: blockHash }),
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "getSlot0" ? [2n ** 96n, 0, 0, 3000] : 1_000_000n,
      simulateContract: async () => ({ result: [1_000n, 100_000n] }),
      call: async () => ({ data: "0x" }),
    } as unknown as MainnetAuditClient;
    const result = await evaluateMainnetIntent({ intentId: "v4-swap-1", store,
      client: chain,
      emergencyStop: false, now: () => now });
    expect(result.decision).toBe("allowed");
  });
  it("holds an agent's swap to the mandate that allowed it", async () => {
    const token = "0x2222222222222222222222222222222222222222" as const;
    const key = { currency0: zeroAddress, currency1: token, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000", lpFee: 3000 };
    // 2 native USDC (18 decimals) into the pool.
    const swap = buildArcV4Swap({ pool, tokenIn: zeroAddress,
      amountIn: 2n * 10n ** 18n, amountOutMinimum: 990n,
      deadline: BigInt(Math.floor(now / 1_000) + 600) });
    const chain = {
      getBlock: async () => ({ number: 100n, hash: blockHash }),
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "getSlot0" ? [2n ** 96n, 0, 0, 3000] : 1_000_000n,
      simulateContract: async () => ({ result: [1_000n, 100_000n] }),
      call: async () => ({ data: "0x" }),
    } as unknown as MainnetAuditClient;
    const evaluate = (mandate: { status: string; maxPositionUsd: number }) =>
      evaluateMainnetIntent({ intentId: "agent-swap-1", client: chain, emergencyStop: false,
        now: () => now, store: new MemoryStore({
          ...fixture(), intentId: "agent-swap-1", kind: "v4_single_pool_swap",
          payloadHash: arcV4SwapPayloadHash(swap),
          transaction: { chainId: ARC_CHAIN_ID, to: swap.to, data: swap.data, value: swap.value },
          v4Swap: { pool, tokenIn: zeroAddress, amountIn: swap.amountIn,
            amountOutMinimum: swap.amountOutMinimum, deadline: swap.deadline },
          automation: { runId: "run-1", runStatus: "running", runsStartedToday: 1,
            mandate: { ...mandate, poolId: pool.id, maxRunsPerDay: 3 } },
        }) });

    expect((await evaluate({ status: "active", maxPositionUsd: 5 })).reasonCode).toBe("POLICY_ALLOWED");
    expect((await evaluate({ status: "active", maxPositionUsd: 1 })).reasonCode)
      .toBe("MANDATE_VALUE_EXCEEDS_LIMIT");
    expect((await evaluate({ status: "revoked", maxPositionUsd: 5 })).reasonCode)
      .toBe("MANDATE_NOT_ACTIVE");
  });
  it("re-quotes a v4 swap when ERC-20 USDC is currency1", async () => {
    const token = "0x2222222222222222222222222222222222222222" as const;
    const key = { currency0: token, currency1: ARC_TOKENS.USDC.address, fee: 10000,
      tickSpacing: 200, hooks: zeroAddress };
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000", lpFee: 10000 };
    const amountOut = 500_000n * 10n ** 18n;
    const swap = buildArcV4Swap({ pool, tokenIn: ARC_TOKENS.USDC.address,
      amountIn: 2_000_000n, amountOutMinimum: (amountOut * 95n) / 100n,
      deadline: BigInt(Math.floor(now / 1_000) + 600) });
    const store = new MemoryStore({
      ...fixture(), intentId: "v4-swap-2", kind: "v4_single_pool_swap",
      payloadHash: arcV4SwapPayloadHash(swap),
      transaction: { chainId: ARC_CHAIN_ID, to: swap.to, data: swap.data, value: swap.value },
      v4Swap: { pool, tokenIn: ARC_TOKENS.USDC.address, amountIn: swap.amountIn,
        amountOutMinimum: swap.amountOutMinimum, deadline: swap.deadline },
    });
    const chain = {
      getBlock: async () => ({ number: 100n, hash: blockHash }),
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "getSlot0" ? [2n ** 96n, 0, 0, 10000] : 1_000_000n,
      simulateContract: async () => ({ result: [amountOut, 100_000n] }),
      call: async () => ({ data: "0x" }),
    } as unknown as MainnetAuditClient;
    const result = await evaluateMainnetIntent({ intentId: "v4-swap-2", store,
      client: chain,
      emergencyStop: false, now: () => now });
    expect(result.reasonCode).toBe("POLICY_ALLOWED");
  });
  it("loads, freshly simulates, evaluates, and records without signing", async () => {
    const store = new MemoryStore(fixture());
    const result = await evaluateMainnetIntent({
      intentId: "approval-1",
      store,
      client: client(async () => ({ data: "0x" })),
      emergencyStop: false,
      now: () => now,
    });

    expect(result).toEqual({
      intentId: "approval-1",
      decision: "allowed",
      reasonCode: "POLICY_ALLOWED",
      blockNumber: 100,
      createdAt: now,
    });
    expect(store.evaluations).toEqual([result]);
  });

  it("records a stable rejection when fresh chain simulation reverts", async () => {
    const store = new MemoryStore(fixture());
    const result = await evaluateMainnetIntent({
      intentId: "approval-1",
      store,
      client: client(async () => { throw new Error("RPC detail"); }),
      emergencyStop: false,
      now: () => now,
    });

    expect(result.reasonCode).toBe("CHAIN_REVALIDATION_FAILED");
    expect(result.decision).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain("RPC detail");
  });

  it("records emergency-stop policy rejection after a successful call", async () => {
    const store = new MemoryStore(fixture());
    const result = await evaluateMainnetIntent({
      intentId: "approval-1",
      store,
      client: client(async () => ({})),
      emergencyStop: true,
      now: () => now,
    });

    expect(result.reasonCode).toBe("EMERGENCY_STOP_ACTIVE");
  });
});
