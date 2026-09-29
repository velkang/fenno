import { createPublicClient, encodeAbiParameters, getAddress, http, slice, toEventSelector,
  toFunctionSelector, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ALPHA_POOL, ARC_TOKENS, UNISWAP_V3_ARC, UNISWAP_V4_ARC, arc, v4PoolId } from "@stillwater/chain";
import { indexPoolDirectory } from "../src/pool-directory";
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

// Directory fakes: a D1 that records statements, and an RPC that answers raw
// eth_getLogs / eth_call requests the way a JSON-RPC endpoint would.
type Statement = { sql: string; values: unknown[] };
const uint = (value: bigint | number) =>
  encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]).slice(2);
const int24 = (value: number) => encodeAbiParameters([{ type: "int24" }], [value]).slice(2);
const address = (value: Address) => encodeAbiParameters([{ type: "address" }], [value]).slice(2);
const hex = (...words: string[]) => `0x${words.join("")}` as Hex;
const safeBlock = 2_000_000n;

function fakeDb(input: { checkpoints: Record<string, number>; known?: unknown[]; skipped?: string[] }) {
  const statements: Statement[] = [];
  const db = { prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() {
        statements.push({ sql, values });
        const block = input.checkpoints[values[0] as string];
        return block === undefined ? null : { block_number: block };
      },
      async all() {
        statements.push({ sql, values });
        if (sql.includes("pool_directory_skips")) {
          return { results: (input.skipped ?? []).map((pool_key) => ({ pool_key })) };
        }
        return { results: input.known ?? [] };
      },
      async run() { statements.push({ sql, values }); return {}; },
    };
  } } as unknown as D1Database;
  const upserts = (table: string) => statements
    .filter(({ sql }) => sql.startsWith(`INSERT INTO ${table} `))
    .flatMap(({ values }) => JSON.parse(values[0] as string) as Array<Record<string, unknown>>);
  const skips = () => statements.filter(({ sql }) => sql.includes("INSERT OR IGNORE INTO pool_directory_skips"))
    .flatMap(({ values }) => JSON.parse(values[0] as string) as string[]);
  const checkpoint = (name: string) => statements.filter(({ values }) => values[0] === name && values.length === 5)
    .at(-1)?.values[2];
  return { db, statements, upserts, skips, checkpoint };
}

function fakeRpc(input: {
  logs: Array<{ address: Address; block: bigint; topics: Hex[]; data?: Hex }>;
  calls: Record<string, Hex>;
  readContract?: (call: { address: Address; functionName: string; args?: readonly unknown[] }) => unknown;
  getCode?: (address: Address) => Hex;
}) {
  const calls: string[] = [];
  const client = {
    async getBlock(parameters: { blockNumber?: bigint }) {
      return { number: parameters.blockNumber ?? safeBlock, hash: `0x${"ab".repeat(32)}` as Hex };
    },
    async getCode({ address: target }: { address: Address }) { return input.getCode?.(target) ?? "0x60"; },
    async readContract(call: { address: Address; functionName: string; args?: readonly unknown[] }) {
      calls.push(`read:${call.functionName}`);
      if (!input.readContract) throw new Error(`Unexpected read ${call.functionName}`);
      return input.readContract(call);
    },
    async request({ method, params }: { method: string; params: unknown[] }) {
      if (method === "eth_getLogs") {
        const filter = params[0] as { fromBlock: Hex; toBlock: Hex };
        return input.logs
          .filter(({ block }) => block >= BigInt(filter.fromBlock) && block <= BigInt(filter.toBlock))
          .map(({ address: emitter, block, topics, data }) => ({ address: emitter.toLowerCase(),
            blockNumber: `0x${block.toString(16)}`, topics, data: data ?? "0x" }));
      }
      const { to, data } = params[0] as { to: Address; data: Hex };
      calls.push(`call:${to.toLowerCase()}:${data.slice(0, 10)}`);
      const result = input.calls[`${to.toLowerCase()}:${data}`] ?? input.calls[`${to.toLowerCase()}:${data.slice(0, 10)}`];
      if (result === undefined) throw new Error("execution reverted");
      return result;
    },
  };
  return { client, calls };
}

describe("v4 pool directory (active pools only)", () => {
  const token = getAddress("0x2222222222222222222222222222222222222222");
  const key = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const id = v4PoolId(key);
  const SWAP = toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
  const stateView = UNISWAP_V4_ARC.stateView.toLowerCase();
  const positionManager = UNISWAP_V4_ARC.positionManager.toLowerCase();
  const slot0 = hex(uint(2n ** 96n), int24(-5), uint(0), uint(3000));
  const swapLog = (poolId: Hex, block: bigint) => ({ address: UNISWAP_V4_ARC.poolManager, block,
    topics: [SWAP, poolId, `0x${"00".repeat(32)}`] as Hex[] });
  const storedRow = { pool_id: id, currency0: zeroAddress, currency1: token, fee: 3000, tick_spacing: 60,
    hooks: zeroAddress, token_address: token, token_symbol: "MEME", token_decimals: 18,
    sqrt_price_x96: "1", tick: 0, liquidity: "1", lp_fee: 3000, block_number: 1, updated_at: 1 };

  it("starts at the current block on its first run without scanning history", async () => {
    const { db, checkpoint } = fakeDb({ checkpoints: {} });
    const { client, calls } = fakeRpc({ logs: [], calls: {} });
    await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
    expect(checkpoint("v4_pool_state")).toBe(Number(safeBlock));
    expect(calls).toEqual([]);
  });

  it("refreshes only touched known pools, in one bulk upsert", async () => {
    const { db, upserts, checkpoint } = fakeDb({ checkpoints: { v4_pool_state: 1_999_500 }, known: [storedRow] });
    const { client, calls } = fakeRpc({ logs: [swapLog(id, 1_999_700n)], calls: {
      [`${stateView}:${toFunctionSelector("getSlot0(bytes32)")}`]: slot0,
      [`${stateView}:${toFunctionSelector("getLiquidity(bytes32)")}`]: hex(uint(500)),
    } });
    await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
    expect(calls.every((call) => call.startsWith(`call:${stateView}`))).toBe(true);
    expect(upserts("v4_pool_directory")).toEqual([expect.objectContaining({ pool_id: id,
      token_symbol: "MEME", sqrt_price_x96: (2n ** 96n).toString(), tick: -5, liquidity: "500" })]);
    expect(checkpoint("v4_pool_state")).toBe(Number(safeBlock));
  });

  it("adds an older USDC pool through its registered key and skips unregistered ids", async () => {
    const unregistered = `0x${"99".repeat(32)}` as Hex;
    const registered = hex(address(key.currency0), address(key.currency1), uint(key.fee),
      int24(key.tickSpacing), address(key.hooks));
    const poolKeysCall = (poolId: Hex) =>
      `${positionManager}:${toFunctionSelector("poolKeys(bytes25)")}${slice(poolId, 0, 25).slice(2).padEnd(64, "0")}`;
    const { db, upserts, skips } = fakeDb({ checkpoints: { v4_pool_state: 1_999_500 } });
    const { client } = fakeRpc({
      logs: [swapLog(id, 1_999_600n), swapLog(unregistered, 1_999_700n)],
      calls: {
        [poolKeysCall(id)]: registered,
        [poolKeysCall(unregistered)]: hex(uint(0), uint(0), uint(0), uint(0), uint(0)),
        [`${stateView}:${toFunctionSelector("getSlot0(bytes32)")}`]: slot0,
        [`${stateView}:${toFunctionSelector("getLiquidity(bytes32)")}`]: hex(uint(500)),
      },
      readContract: ({ functionName }) => functionName === "decimals" ? 18 : "MEME",
    });
    await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
    expect(upserts("v4_pool_directory")).toEqual([expect.objectContaining({ pool_id: id.toLowerCase(),
      currency1: token, token_symbol: "MEME", token_decimals: 18 })]);
    expect(skips()).toEqual([unregistered]);
  });

  it("carries pools beyond the per-run cap over to the next run", async () => {
    const poolIds = Array.from({ length: 22 }, (_, index) =>
      v4PoolId({ ...key, fee: 100 + index }));
    const { db, upserts, checkpoint } = fakeDb({ checkpoints: { v4_pool_state: 1_999_000 } });
    const { client } = fakeRpc({
      logs: poolIds.map((poolId, index) => swapLog(poolId, 1_999_100n + BigInt(index))),
      calls: Object.fromEntries([
        ...poolIds.map((poolId, index) => [
          `${positionManager}:${toFunctionSelector("poolKeys(bytes25)")}${slice(poolId, 0, 25).slice(2).padEnd(64, "0")}`,
          hex(address(zeroAddress), address(token), uint(100 + index), int24(60), address(zeroAddress))]),
        [`${stateView}:${toFunctionSelector("getSlot0(bytes32)")}`, slot0],
        [`${stateView}:${toFunctionSelector("getLiquidity(bytes32)")}`, hex(uint(500))],
      ]),
      readContract: ({ functionName }) => functionName === "decimals" ? 18 : "MEME",
    });
    await indexV4PoolDirectory({ db, client: client as never, now: () => 123 });
    expect(upserts("v4_pool_directory")).toHaveLength(20);
    // The 21st pool appeared at block 1_999_120, so the next run resumes there.
    expect(checkpoint("v4_pool_state")).toBe(1_999_119);
  });
});

describe("v3 pool directory (active pools only)", () => {
  const token = getAddress("0x2222222222222222222222222222222222222222");
  const usdc = ARC_TOKENS.USDC.address;
  const pool = getAddress("0x4444444444444444444444444444444444444444");
  const other = getAddress("0x5555555555555555555555555555555555555555");
  const SWAP = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
  const swapLog = (emitter: Address, block: bigint) => ({ address: emitter, block, topics: [SWAP] as Hex[] });
  const [token0, token1] = token.toLowerCase() < usdc.toLowerCase() ? [token, usdc] : [usdc, token];
  const storedRow = { pool_address: pool, token_address: token, token_symbol: "MEME", token_decimals: 18,
    token0_address: token0, token1_address: token1, fee: 3000, tick_spacing: 60, sqrt_price_x96: "1",
    tick: 0, liquidity: "1", usdc_reserve: "1", block_number: 1, updated_at: 1 };
  const stateCalls = {
    [`${pool.toLowerCase()}:${toFunctionSelector("slot0()")}`]: hex(uint(2n ** 96n), int24(7), uint(0),
      uint(0), uint(0), uint(0), uint(1)),
    [`${pool.toLowerCase()}:${toFunctionSelector("liquidity()")}`]: hex(uint(900)),
    [`${usdc.toLowerCase()}:${toFunctionSelector("balanceOf(address)")}`]: hex(uint(42)),
  };

  it("re-reads only touched known pools, without rediscovering their token", async () => {
    const { db, upserts } = fakeDb({ checkpoints: { pool_directory_state: 1_999_500 }, known: [storedRow] });
    const { client, calls } = fakeRpc({ logs: [swapLog(pool, 1_999_600n)], calls: stateCalls });
    await indexPoolDirectory({ db, client: client as never, now: () => 123 });
    expect(calls.some((call) => call.startsWith("read:"))).toBe(false);
    expect(upserts("pool_directory")).toEqual([expect.objectContaining({ pool_address: pool,
      sqrt_price_x96: (2n ** 96n).toString(), tick: 7, liquidity: "900", usdc_reserve: "42" })]);
  });

  it("adds a new USDC pool only after the factory confirms it, and skips other emitters", async () => {
    const { db, upserts, skips } = fakeDb({ checkpoints: { pool_directory_state: 1_999_500 } });
    const { client } = fakeRpc({
      logs: [swapLog(pool, 1_999_600n), swapLog(other, 1_999_601n)],
      calls: {
        ...stateCalls,
        [`${pool.toLowerCase()}:${toFunctionSelector("token0()")}`]: hex(address(token0)),
        [`${pool.toLowerCase()}:${toFunctionSelector("token1()")}`]: hex(address(token1)),
        [`${other.toLowerCase()}:${toFunctionSelector("token0()")}`]: hex(address(token)),
        [`${other.toLowerCase()}:${toFunctionSelector("token1()")}`]: hex(address(other)),
      },
      readContract: ({ address: target, functionName, args }) => {
        if (functionName === "decimals") return target === usdc ? 6 : 18;
        if (functionName === "symbol") return target === usdc ? "USDC" : "MEME";
        if (functionName === "getPool") return target === UNISWAP_V3_ARC.factory.address && args?.[2] === 3000
          ? pool : zeroAddress;
        if (functionName === "slot0") return [2n ** 96n, 7, 0, 0, 0, 0, true];
        if (functionName === "liquidity") return 900n;
        if (functionName === "token0") return token0;
        if (functionName === "token1") return token1;
        if (functionName === "fee") return 3000;
        if (functionName === "tickSpacing") return 60;
        throw new Error(`Unexpected read ${functionName}`);
      },
    });
    await indexPoolDirectory({ db, client: client as never, now: () => 123 });
    expect(upserts("pool_directory")).toEqual([expect.objectContaining({ pool_address: pool,
      token_address: token, token_symbol: "MEME", usdc_reserve: "42" })]);
    expect(skips()).toEqual([other.toLowerCase()]);
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
