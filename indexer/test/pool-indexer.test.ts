import { createPublicClient, getAddress, http, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ALPHA_POOL, arc, v4PoolId } from "@stillwater/chain";
import { indexV4PoolDirectory } from "../src/v4-pool-directory";
import {
  indexAlphaPool,
  reconcilePoolSnapshot,
  type IndexerChainClient,
  type PoolIndexerStore,
  type PoolSnapshot,
  type Reconciliation,
} from "../src/pool-indexer";

const blockHash = `0x${"ab".repeat(32)}` as const;

class MemoryStore implements PoolIndexerStore {
  snapshots = new Map<string, PoolSnapshot>();
  reconciliations: Reconciliation[] = [];
  checkpoint = 0;

  async saveSnapshotAndCheckpoint(snapshot: PoolSnapshot) {
    const key = `${snapshot.chainId}:${snapshot.poolAddress}:${snapshot.blockNumber}`;
    if (!this.snapshots.has(key)) this.snapshots.set(key, snapshot);
    this.checkpoint = Math.max(this.checkpoint, snapshot.blockNumber);
  }

  async getSnapshot(input: {
    chainId: number;
    poolAddress: string;
    blockNumber: number;
  }) {
    return (
      this.snapshots.get(
        `${input.chainId}:${input.poolAddress}:${input.blockNumber}`,
      ) ?? null
    );
  }

  async saveReconciliation(value: Reconciliation) {
    this.reconciliations.push(value);
  }
}

function fakeClient(seenBlocks: Array<bigint | undefined>): IndexerChainClient {
  return {
    async getBlock() {
      return { number: 500n, hash: blockHash };
    },
    async getBalance() {
      return 0n;
    },
    async simulateContract() {
      return { result: [0n, 0n] };
    },
    async readContract(parameters) {
      seenBlocks.push(parameters.blockNumber);
      if (parameters.functionName === "slot0") {
        return [1n << 96n, 0, 0, 0, 0, 0, true];
      }
      if (parameters.functionName === "liquidity") return 123n;
      if (parameters.functionName === "token0") return ALPHA_POOL.token0.address;
      if (parameters.functionName === "token1") return ALPHA_POOL.token1.address;
      if (parameters.functionName === "fee") return ALPHA_POOL.fee;
      if (parameters.functionName === "tickSpacing") return ALPHA_POOL.tickSpacing;
      throw new Error(`Unexpected call ${parameters.functionName}`);
    },
  };
}

describe("pool indexer", () => {
  it("indexes an Arc v4 native-USDC pool from its PoolManager event", async () => {
    const token = getAddress("0x2222222222222222222222222222222222222222");
    const key = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { writes.push({ sql, values }); return {}; },
      };
    } } as unknown as D1Database;
    const client = {
      async getBlock() { return { number: 1_948_060n, hash: blockHash }; },
      async getLogs() { return [{ args: { id: v4PoolId(key), ...key } }]; },
      async readContract(call: { functionName: string }) {
        if (call.functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
        if (call.functionName === "getLiquidity") return 100n;
        if (call.functionName === "decimals") return 18;
        if (call.functionName === "symbol") return "MEME";
        throw new Error(`Unexpected read ${call.functionName}`);
      },
    };
    await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
    const poolWrite = writes.find(({ sql }) => sql.includes("INSERT INTO v4_pool_directory"));
    expect(poolWrite?.values.slice(0, 9)).toEqual([
      v4PoolId(key), zeroAddress, token, 3000, 60, zeroAddress, token, "MEME", 18,
    ]);
    expect(writes.some(({ sql }) => sql.includes("chain_indexer_checkpoints"))).toBe(true);
  });

  it("keeps v4 pools and advances only through completed log chunks when RPC limits a scan", async () => {
    const token = getAddress("0x2222222222222222222222222222222222222222");
    const key = { currency0: zeroAddress, currency1: token, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { return null; }, async all() { return { results: [] }; },
      async run() { writes.push({ sql, values }); return {}; },
    }; } } as unknown as D1Database;
    let scans = 0;
    const client = {
      async getBlock() { return { number: 1_951_000n, hash: blockHash }; },
      async getLogs() {
        scans += 1;
        if (scans === 3) throw new Error("rate limit exceeded");
        return scans === 1 ? [{ args: { id: v4PoolId(key), ...key } }] : [];
      },
      async readContract(call: { functionName: string }) {
        if (call.functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
        if (call.functionName === "getLiquidity") return 100n;
        if (call.functionName === "decimals") return 18;
        if (call.functionName === "symbol") return "MEME";
        throw new Error(`Unexpected read ${call.functionName}`);
      },
    };
    await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
    expect(writes.some(({ sql }) => sql.includes("INSERT INTO v4_pool_directory"))).toBe(true);
    const checkpoint = writes.find(({ sql }) => sql.includes("chain_indexer_checkpoints"));
    expect(checkpoint?.values[2]).toBe(1_949_001);
  });

  describe("v4 pool state refresh", () => {
    const token = getAddress("0x2222222222222222222222222222222222222222");
    const key = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const safeBlock = 1_950_000n;

    function setup(stateLogs: (call: number) => Array<{ args: { id: `0x${string}` } }>) {
      const writes: Array<{ sql: string; values: unknown[] }> = [];
      const reads: string[] = [];
      const db = { prepare(sql: string) { let values: unknown[] = []; return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() {
          if (values[0] === "v4_pool_directory") return { block_number: 1_948_056 };
          if (values[0] === "v4_pool_state") return { block_number: 1_948_000 };
          return null;
        },
        async all() { return { results: [{ currency0: zeroAddress, currency1: token, fee: 3000,
          tick_spacing: 60, hooks: zeroAddress, token_symbol: "MEME", token_decimals: 18 }] }; },
        async run() { writes.push({ sql, values }); return {}; },
      }; } } as unknown as D1Database;
      let stateCalls = 0;
      const client = {
        async getBlock(input: { blockNumber?: bigint }) {
          return { number: input.blockNumber ?? safeBlock, hash: blockHash };
        },
        async getLogs(input: { events?: unknown }) {
          if (!input.events) return [];
          stateCalls += 1;
          return stateLogs(stateCalls);
        },
        async readContract(call: { functionName: string }) {
          reads.push(call.functionName);
          if (call.functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
          if (call.functionName === "getLiquidity") return 100n;
          throw new Error(`Unexpected read ${call.functionName}`);
        },
      };
      const stateCheckpoint = () => writes.find(({ values }) => values[0] === "v4_pool_state");
      return { db, client, writes, reads, stateCheckpoint };
    }

    it("does not re-read a stored pool without Swap or ModifyLiquidity logs", async () => {
      const { db, client, writes, reads, stateCheckpoint } = setup(() => []);
      await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
      expect(reads).toEqual([]);
      expect(writes.some(({ sql }) => sql.includes("INSERT INTO v4_pool_directory"))).toBe(false);
      expect(stateCheckpoint()?.values[2]).toBe(Number(safeBlock));
    });

    it("re-reads a touched stored pool without reading token metadata", async () => {
      const { db, client, writes, reads } = setup((call) => call === 1 ? [{ args: { id: v4PoolId(key) } }] : []);
      await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
      expect(reads.sort()).toEqual(["getLiquidity", "getSlot0"]);
      const poolWrite = writes.find(({ sql }) => sql.includes("INSERT INTO v4_pool_directory"));
      expect(poolWrite?.values.slice(7, 9)).toEqual(["MEME", 18]);
    });

    it("advances the state checkpoint only through completed log chunks", async () => {
      const { db, client, stateCheckpoint } = setup((call) => {
        if (call === 2) throw new Error("rate limit exceeded");
        return [];
      });
      await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
      expect(stateCheckpoint()?.values[2]).toBe(1_949_000);
    });
  });

  it("idempotently snapshots and reconciles one safe Arc block", async () => {
    const store = new MemoryStore();
    const seenBlocks: Array<bigint | undefined> = [];
    const client = fakeClient(seenBlocks);

    const first = await indexAlphaPool({ client, store, now: () => 1_000 });
    const second = await indexAlphaPool({ client, store, now: () => 2_000 });

    expect(first.status).toBe("matched");
    expect(second.status).toBe("matched");
    expect(store.snapshots.size).toBe(1);
    expect(store.checkpoint).toBe(500);
    expect(store.reconciliations).toHaveLength(2);
    expect(seenBlocks).toEqual(Array(12).fill(500n));
  });

  it("reports the exact immutable snapshot fields that disagree", () => {
    const direct = {
      chainId: 5_042,
      poolAddress: ALPHA_POOL.address,
      blockNumber: 500,
      blockHash,
      sqrtPriceX96: "1",
      tick: 2,
      liquidity: "3",
      token1PerToken0: "4",
      token0PerToken1: "5",
      observedAt: 1_000,
    } satisfies PoolSnapshot;

    const result = reconcilePoolSnapshot(
      { ...direct, tick: 9, liquidity: "10" },
      direct,
      2_000,
    );

    expect(result.status).toBe("mismatch");
    expect(result.mismatchFields).toEqual(["tick", "liquidity"]);
  });

  it("fails closed when an existing snapshot conflicts", async () => {
    const store = new MemoryStore();
    const client = fakeClient([]);
    await indexAlphaPool({ client, store, now: () => 1_000 });
    const stored = [...store.snapshots.values()][0];
    store.snapshots.set(
      `${stored.chainId}:${stored.poolAddress}:${stored.blockNumber}`,
      { ...stored, liquidity: "corrupt" },
    );

    await expect(
      indexAlphaPool({ client, store, now: () => 2_000 }),
    ).rejects.toThrow("Arc pool reconciliation mismatch: liquidity");
    expect(store.reconciliations.at(-1)?.status).toBe("mismatch");
  });
});

it.skipIf(process.env.LIVE_ARC_RPC !== "true")(
  "indexes and reconciles a live Arc safe block in memory",
  async () => {
    const client = createPublicClient({
      chain: arc,
      transport: http(arc.rpcUrls.default.http[0]),
    }) as unknown as IndexerChainClient;
    const store = new MemoryStore();

    const result = await indexAlphaPool({ client, store });

    expect(result.status).toBe("matched");
    expect(store.snapshots.size).toBe(1);
    expect(store.checkpoint).toBeGreaterThan(0);
  },
  30_000,
);
