import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import { ARC_TOKENS, UNISWAP_V3_ARC, v4PoolId } from "@stillwater/chain";
import type { Decider } from "../src/decide/provider";
import type { Decision } from "../src/decide/decision";
import { reserveModelCall, watchWallet, type WatchChain } from "../src/watcher";

const NOW = 2_000_000_000_000;
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const key = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const poolId = v4PoolId(key);

// One live position (token id 7, ticks -60..60, worth about $60) in a native-USDC pool at $1.
const chain = {
  async readContract({ functionName }: { functionName: string }) {
    if (functionName === "ownerOf") return wallet;
    if (functionName === "getPoolAndPositionInfo") return [key, (((1n << 24n) - 60n) << 8n) | (60n << 32n)];
    if (functionName === "getPositionLiquidity") return 10n ** 22n;
    if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
    if (functionName === "getLiquidity") return 10n ** 22n;
    if (functionName === "getFeeGrowthInside") return [0n, 0n];
    if (functionName === "getPositionInfo") return [10n ** 22n, 0n, 0n];
    throw new Error(`Unexpected ${functionName}`);
  },
  async getGasPrice() { return 20_000_000_000n; },
} as unknown as WatchChain;

function setup(mandate: { mode: "ask" | "autopilot"; band: string; max_position_usd?: number } | null,
  latestRun: Record<string, unknown> | null = null) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const answer = (sql: string): unknown => {
    if (sql.includes("FROM managed_wallets")) return { id: "wallet-1", address: wallet, state: "active" };
    if (sql.includes("FROM automation_mandates")) return mandate ? [{ id: "mandate-1", pool_id: poolId,
      max_position_usd: 500, max_runs_per_day: 2, ...mandate }] : [];
    if (sql.includes("v4_mint_intents")) return [{ token_id: "7" }];
    if (sql.includes("v4_pool_directory")) return { token_address: token, token_symbol: "MEME", token_decimals: 18 };
    if (sql.includes("COUNT(*)")) return { runs: 0 };
    if (sql.includes("ORDER BY created_at DESC LIMIT 1")) return latestRun;
    return null;
  };
  const db = { prepare: (sql: string) => {
    const statement = { sql, args: [] as unknown[],
      bind(...args: unknown[]) { statement.args = args; return statement; },
      async first() { return answer(sql); },
      async all() { return { results: answer(sql) ?? [] }; },
      async run() { writes.push(statement); return {}; } };
    return statement;
  } } as unknown as D1Database;
  return { db, writes };
}

const decider = (decision: Decision | null): Decider & { asked: number } => {
  const result = { provider: "claude" as const, model: "claude-opus-5-5", asked: 0,
    async decide() { result.asked += 1; return { provider: "claude" as const, model: "claude-opus-5-5", decision }; } };
  return result;
};
const recentre: Decision = { action: "rebalance", band: "narrow", reason: "The price has moved; a new band earns again.", confidence: "high" };

describe("the watcher", () => {
  it("turns an ask-first decision into a proposal for the user, with the model's reason", async () => {
    const { db, writes } = setup({ mode: "ask", band: "agent" });
    const result = await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW,
      deciders: { primary: decider(recentre) } });
    expect(result.start).toBeUndefined();
    const [insert] = writes.filter((write) => write.sql.includes("INSERT INTO automation_runs"));
    const [, mandateId, kind, status, band, trigger, reason, provider, , tokenId] = insert!.args;
    expect({ mandateId, kind, status, band, trigger, reason, provider, tokenId }).toEqual({ mandateId: "mandate-1",
      kind: "rebalance", status: "proposed", band: "narrow", trigger: "daily_review", reason: recentre.reason,
      provider: "claude", tokenId: "7" });
  });

  it("starts a run at once on autopilot, at the mandate's band", async () => {
    const { db, writes } = setup({ mode: "autopilot", band: "wide" });
    const result = await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW,
      deciders: { primary: decider(recentre) } });
    expect(writes.find((write) => write.sql.includes("INSERT INTO automation_runs"))!.args[3]).toBe("running");
    expect(result.start).toMatchObject({ walletId: "wallet-1", walletAddress: wallet, mandateId: "mandate-1",
      tokenId: "7", kind: "rebalance", band: "wide", revokeMandate: false });
  });

  it("records nothing when the model holds or gives no answer, and remembers that it asked", async () => {
    for (const decision of [{ ...recentre, action: "hold" as const, band: null }, null]) {
      const { db, writes } = setup({ mode: "autopilot", band: "agent" });
      const result = await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW,
        deciders: { primary: decider(decision) } });
      expect(writes).toHaveLength(0);
      expect(result.state.memories["mandate-1"]!.lastAskedAt).toBe(NOW);
    }
  });

  it("only watches when no provider is set up", async () => {
    const { db, writes } = setup({ mode: "autopilot", band: "agent" });
    const result = await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW, deciders: null });
    expect(writes).toHaveLength(0);
    expect(result.state.memories["mandate-1"]!.samples).toHaveLength(1);
    expect(result.stop).toBe(false);
  });

  it("asks once, then not again on the next check", async () => {
    const { db } = setup({ mode: "ask", band: "agent" });
    const holding = decider({ ...recentre, action: "hold", band: null });
    const first = await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW, deciders: { primary: holding } });
    await watchWallet("wallet-1", first.state, { db, chain, now: NOW + 5 * 60_000, deciders: { primary: holding } });
    expect(holding.asked).toBe(1);
  });

  it("doesn't re-centre a position worth more than the mandate allows, but may still close it", async () => {
    // The position is worth about $60; the limit is $50.
    const { db, writes } = setup({ mode: "autopilot", band: "agent", max_position_usd: 50 });
    const result = await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW,
      deciders: { primary: decider(recentre) } });
    expect(writes).toHaveLength(0);
    expect(result.start).toBeUndefined();
    const closing = setup({ mode: "autopilot", band: "agent", max_position_usd: 50 });
    const closed = await watchWallet("wallet-1", { memories: {} }, { db: closing.db, chain, now: NOW,
      deciders: { primary: decider({ ...recentre, action: "close", band: null }) } });
    expect(closed.start).toMatchObject({ kind: "close" });
  });

  it("doesn't ask the model about a position worth less than a dollar", async () => {
    const tiny = { ...chain, async readContract(call: { functionName: string }) {
      return call.functionName === "getPositionLiquidity" ? 10n ** 15n : chain.readContract(call as never);
    } } as WatchChain;
    const { db } = setup({ mode: "autopilot", band: "agent" });
    const asked = decider(recentre);
    await watchWallet("wallet-1", { memories: {} }, { db, chain: tiny, now: NOW, deciders: { primary: asked } });
    expect(asked.asked).toBe(0);
  });

  it("lets a run nobody is carrying out lapse after an hour, so the mandate isn't blocked", async () => {
    const { db, writes } = setup({ mode: "ask", band: "agent" },
      { id: "run-old", status: "running", created_at: NOW - 3 * 3_600_000, started_at: NOW - 3 * 3_600_000, finished_at: null });
    await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW, deciders: { primary: decider(recentre) } });
    const lapse = writes.find((write) => write.sql.includes("RUN_LOST"));
    expect(lapse?.args[0]).toBe("run-old");
    expect(writes.some((write) => write.sql.includes("INSERT INTO automation_runs"))).toBe(true);
  });

  it("stops asking the model once the day's calls across all users are used", async () => {
    const { db } = setup({ mode: "ask", band: "agent" });
    const asked = decider(recentre);
    const result = await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW,
      deciders: { primary: asked }, reserveCall: async () => false });
    expect(asked.asked).toBe(0);
    // Not counted as asked: it tries again once calls are available.
    expect(result.state.memories["mandate-1"]!.lastAskedAt).toBe(0);
  });

  it("counts calls per UTC day and refuses past the limit without writing", async () => {
    const counted: Array<{ sql: string; args: unknown[] }> = [];
    const answers = [{ calls: 1 }, { calls: 2 }, null];
    const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
      async first() { counted.push({ sql, args }); return answers.shift(); } }) }) } as unknown as D1Database;
    expect(await reserveModelCall(db, NOW, 2)).toBe(true);
    expect(await reserveModelCall(db, NOW, 2)).toBe(true);
    expect(await reserveModelCall(db, NOW, 2)).toBe(false);
    expect(counted[0]!.args).toEqual([new Date(NOW).toISOString().slice(0, 10), 2]);
    expect(counted[0]!.sql).toContain("WHERE calls < ?2");
  });

  it("watches a v3 position the same way, asking about it with the same facts", async () => {
    const v3Pool = "0x3333333333333333333333333333333333333333";
    const usdc = ARC_TOKENS.USDC.address;
    // Token ids 5 (closed, empty) and 9 (live): the newest live one in the mandate's pool is watched.
    // About $60: liquidity 10^9 across ticks -600..600 at $1 (token and USDC both 6 decimals).
    const v3Chain = {
      async readContract({ address, functionName, args = [] }: { address: string; functionName: string; args?: unknown[] }) {
        if (address === UNISWAP_V3_ARC.nonfungiblePositionManager.address && functionName === "balanceOf") return 2n;
        if (functionName === "tokenOfOwnerByIndex") return args[1] === 0n ? 5n : 9n;
        if (functionName === "positions") {
          return [0n, wallet, token, usdc, 3000, -600, 600, args[0] === 9n ? 10n ** 9n : 0n, 0n, 0n, 0n, 0n];
        }
        if (functionName === "getPool") return v3Pool;
        if (functionName === "slot0") return [2n ** 96n, 0, 0, 0, 0, 0, true];
        if (functionName === "decimals") return 6;
        if (functionName === "symbol") return "QUANTS";
        if (functionName === "balanceOf" || functionName === "allowance") return 0n;
        throw new Error(`Unexpected ${functionName}`);
      },
      async simulateContract() { return { result: [0n, 0n] }; },
      async getGasPrice() { return 20_000_000_000n; },
    } as unknown as WatchChain;
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const answer = (sql: string): unknown => {
      if (sql.includes("FROM managed_wallets")) return { id: "wallet-1", address: wallet, state: "active" };
      if (sql.includes("FROM automation_mandates")) return [{ id: "mandate-3", pool_id: v3Pool, mode: "ask",
        band: "agent", max_position_usd: 500, max_runs_per_day: 2 }];
      if (sql.includes("FROM pool_directory")) return { token_address: token, token_symbol: "QUANTS", token_decimals: 6,
        token0_address: token, token1_address: usdc, fee: 3000 };
      if (sql.includes("COUNT(*)")) return { runs: 0 };
      return null;
    };
    const db = { prepare: (sql: string) => {
      const statement = { sql, args: [] as unknown[],
        bind(...args: unknown[]) { statement.args = args; return statement; },
        async first() { return answer(sql); },
        async all() { return { results: answer(sql) ?? [] }; },
        async run() { writes.push(statement); return {}; } };
      return statement;
    } } as unknown as D1Database;
    let facts: unknown;
    const watching: Decider = { provider: "openai", model: "gpt-6-luna",
      async decide(given) { facts = given; return { provider: "openai", model: "gpt-6-luna", decision: recentre }; } };

    await watchWallet("wallet-1", { memories: {} }, { db, chain: v3Chain, now: NOW, deciders: { primary: watching } });
    expect(facts).toMatchObject({ token: { symbol: "QUANTS" }, feeTierPercent: 0.3, band: { priceIs: "inside" } });
    const { priceUsd, band, position } = facts as { priceUsd: number; band: { minUsd: number; maxUsd: number };
      position: { valueUsd: number } };
    expect(priceUsd).toBeCloseTo(1, 6);
    expect(band.minUsd).toBeCloseTo(0.9418, 3);
    expect(band.maxUsd).toBeCloseTo(1.0618, 3);
    expect(position.valueUsd).toBeGreaterThan(50);
    expect(position.valueUsd).toBeLessThan(70);
    const insert = writes.find((write) => write.sql.includes("INSERT INTO automation_runs"))!;
    expect(insert.args[9]).toBe("9");
  });

  it("stops when the wallet has no active mandate", async () => {
    const { db } = setup(null);
    expect((await watchWallet("wallet-1", { memories: {} }, { db, chain, now: NOW, deciders: null })).stop).toBe(true);
  });
});
