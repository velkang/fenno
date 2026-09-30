import { createPublicClient, encodeAbiParameters, getAddress, http, pad, toEventSelector,
  toFunctionSelector, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ALPHA_POOL, ARC_TOKENS, UNISWAP_V3_ARC, UNISWAP_V4_ARC, arc, v4PoolId } from "@stillwater/chain";
import { v3Directory } from "../src/pool-directory";
import { v4Directory } from "../src/v4-pool-directory";
import { discoverToken, refreshDirectory, runBackfillPass, runLivePass } from "../src/pool-discovery";
import { PoolDiscovery } from "../src/pool-discovery-object";
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

// Directory fakes: a D1 that keeps checkpoints and records statements, and an RPC
// that answers eth_getLogs (matching topic filters like a node) and raw eth_calls.
type Statement = { sql: string; values: unknown[] };
type FakeLog = { address: Address; block: bigint; topics: Hex[]; data?: Hex };
const uint = (value: bigint | number) =>
  encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]).slice(2);
const int24 = (value: number) => encodeAbiParameters([{ type: "int24" }], [value]).slice(2);
const address = (value: Address) => encodeAbiParameters([{ type: "address" }], [value]).slice(2);
const hex = (...words: string[]) => `0x${words.join("")}` as Hex;
const safeBlock = 2_000_000n;

function fakeDb(input: { checkpoints?: Record<string, number>; known?: Record<string, string[]>;
  skipped?: string[]; rows?: Record<string, unknown[]> } = {}) {
  const statements: Statement[] = [];
  const checkpoints = new Map(Object.entries(input.checkpoints ?? {}));
  const db = { prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() {
        statements.push({ sql, values });
        const block = checkpoints.get(values[0] as string);
        return block === undefined ? null : { block_number: block };
      },
      async all() {
        statements.push({ sql, values });
        if (sql.includes("pool_directory_skips")) {
          return { results: (input.skipped ?? []).map((pool_key) => ({ pool_key })) };
        }
        const table = sql.includes("v4_pool_directory") ? "v4_pool_directory" : "pool_directory";
        if (sql.includes("AS pool_key")) {
          return { results: (input.known?.[table] ?? []).map((pool_key) => ({ pool_key })) };
        }
        return { results: input.rows?.[table] ?? [] };
      },
      async run() {
        statements.push({ sql, values });
        if (sql.includes("INTO chain_indexer_checkpoints")) checkpoints.set(values[0] as string, values[2] as number);
        return {};
      },
    };
  } } as unknown as D1Database;
  const upserts = (table: string) => statements
    .filter(({ sql }) => sql.startsWith(`INSERT INTO ${table} `))
    .flatMap(({ values }) => JSON.parse(values[0] as string) as Array<Record<string, unknown>>);
  const skips = () => statements.filter(({ sql }) => sql.includes("INSERT OR IGNORE INTO pool_directory_skips"))
    .flatMap(({ values }) => JSON.parse(values[0] as string) as string[]);
  const createdUpdates = () => statements.filter(({ sql }) => sql.startsWith("UPDATE "))
    .flatMap(({ values }) => JSON.parse(values[0] as string) as Array<{ k: string; b: number }>);
  return { db, statements, upserts, skips, createdUpdates, checkpoint: (name: string) => checkpoints.get(name) };
}

function topicMatches(filter: unknown, value: Hex | undefined) {
  if (filter === null || filter === undefined) return true;
  const options = Array.isArray(filter) ? filter : [filter];
  return options.some((option) => typeof option === "string" && option.toLowerCase() === value?.toLowerCase());
}

function fakeRpc(input: {
  logs?: FakeLog[];
  calls?: Record<string, Hex>;
  readContract?: (call: { address: Address; functionName: string; args?: readonly unknown[] }) => unknown;
  getCode?: (address: Address, blockNumber?: bigint) => Hex;
  failLogs?: (filter: { fromBlock: bigint; toBlock: bigint }) => Error | null;
}) {
  const ranges: Array<[bigint, bigint]> = [];
  const client = {
    async getBlock(parameters: { blockNumber?: bigint }) {
      return { number: parameters.blockNumber ?? safeBlock, hash: `0x${"ab".repeat(32)}` as Hex };
    },
    async getCode({ address: target, blockNumber }: { address: Address; blockNumber?: bigint }) {
      return input.getCode?.(target, blockNumber) ?? "0x60";
    },
    async readContract(call: { address: Address; functionName: string; args?: readonly unknown[] }) {
      if (!input.readContract) throw new Error(`Unexpected read ${call.functionName}`);
      return input.readContract(call);
    },
    async request({ method, params }: { method: string; params: unknown[] }) {
      if (method === "eth_getLogs") {
        const filter = params[0] as { address: Address; topics: unknown[]; fromBlock: Hex; toBlock: Hex };
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        ranges.push([from, to]);
        const failure = input.failLogs?.({ fromBlock: from, toBlock: to });
        if (failure) throw failure;
        return (input.logs ?? [])
          .filter((log) => log.block >= from && log.block <= to &&
            log.address.toLowerCase() === filter.address.toLowerCase() &&
            filter.topics.every((topic, index) => topicMatches(topic, log.topics[index])))
          .map(({ address: emitter, block, topics, data }) => ({ address: emitter.toLowerCase(),
            blockNumber: `0x${block.toString(16)}`, topics, data: data ?? "0x" }));
      }
      const { to, data } = params[0] as { to: Address; data: Hex };
      const calls = input.calls ?? {};
      const result = calls[`${to.toLowerCase()}:${data}`] ?? calls[`${to.toLowerCase()}:${data.slice(0, 10)}`];
      if (result === undefined) throw new Error("execution reverted");
      return result;
    },
  };
  return { client: client as never, ranges };
}

const token = getAddress("0x2222222222222222222222222222222222222222");
const otherToken = getAddress("0x7777777777777777777777777777777777777777");
const usdc = ARC_TOKENS.USDC.address;
const metadata = ({ functionName }: { functionName: string }) => functionName === "decimals" ? 18 : "MEME";
const topicOf = (value: Address) => pad(value.toLowerCase() as Hex);

describe("v4 pool discovery from Initialize events", () => {
  const INITIALIZE = toEventSelector("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
  const stateView = UNISWAP_V4_ARC.stateView.toLowerCase();
  const stateCalls = {
    [`${stateView}:${toFunctionSelector("getSlot0(bytes32)")}`]: hex(uint(2n ** 96n), int24(-5), uint(0), uint(3000)),
    [`${stateView}:${toFunctionSelector("getLiquidity(bytes32)")}`]: hex(uint(500)),
  };
  // Native USDC (0x0) always sorts first in a v4 key.
  const keyFor = (fee: number) => ({ currency0: zeroAddress, currency1: token, fee, tickSpacing: 60,
    hooks: zeroAddress });
  const initLog = (key: ReturnType<typeof keyFor>, block: bigint): FakeLog => ({
    address: UNISWAP_V4_ARC.poolManager, block,
    topics: [INITIALIZE, v4PoolId(key), topicOf(key.currency0), topicOf(key.currency1)],
    data: encodeAbiParameters(
      [{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }],
      [key.fee, key.tickSpacing, key.hooks, 2n ** 96n, 0]),
  });

  it("starts at the chain head and seeds the backfill cursor there", async () => {
    const { db, checkpoint } = fakeDb();
    const { client, ranges } = fakeRpc({});
    await runLivePass({ db, dir: v4Directory, client, now: () => 123 });
    expect(checkpoint("v4_pools_created")).toBe(Number(safeBlock));
    expect(checkpoint("v4_pools_backfill")).toBe(Number(safeBlock));
    expect(ranges).toEqual([]);
  });

  it("adds new USDC pools with their creation block and leaves known or skipped ones alone", async () => {
    const fresh = keyFor(3000);
    const known = keyFor(500);
    const skipped = keyFor(100);
    const unpaired = { currency0: token, currency1: otherToken, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const { db, upserts, createdUpdates, checkpoint } = fakeDb({
      checkpoints: { v4_pools_created: 1_999_000 },
      known: { v4_pool_directory: [v4PoolId(known).toLowerCase()] },
      skipped: [v4PoolId(skipped).toLowerCase()],
    });
    const { client } = fakeRpc({ calls: stateCalls, readContract: metadata,
      logs: [initLog(fresh, 1_999_100n), initLog(known, 1_999_200n), initLog(skipped, 1_999_300n),
        initLog(unpaired as never, 1_999_400n)] });
    await runLivePass({ db, dir: v4Directory, client, now: () => 123 });
    expect(upserts("v4_pool_directory")).toEqual([expect.objectContaining({
      pool_id: v4PoolId(fresh).toLowerCase(), currency1: token, token_symbol: "MEME", token_decimals: 18,
      liquidity: "500", tick: -5, created_block: 1_999_100 })]);
    expect(createdUpdates()).toEqual([{ k: v4PoolId(known).toLowerCase(), b: 1_999_200 }]);
    expect(checkpoint("v4_pools_created")).toBe(Number(safeBlock));
  });

  it("carries pools beyond the per-tick cap over to the next tick", async () => {
    const keys = Array.from({ length: 102 }, (_, index) => keyFor(100 + index));
    const { db, upserts, checkpoint } = fakeDb({ checkpoints: { v4_pools_created: 1_999_000 } });
    const { client } = fakeRpc({ calls: stateCalls, readContract: metadata,
      logs: keys.map((key, index) => initLog(key, 1_999_100n + BigInt(index))) });
    await runLivePass({ db, dir: v4Directory, client, now: () => 123 });
    expect(upserts("v4_pool_directory")).toHaveLength(100);
    // The 101st pool appeared at block 1_999_200, so the next tick resumes there.
    expect(checkpoint("v4_pools_created")).toBe(1_999_199);
  });

  it("backfills recent history, then the archive down to the deploy block", async () => {
    const recent = keyFor(3000);
    const old = keyFor(500);
    const deploy = 1_600_000n;
    const { db, statements, upserts, checkpoint } = fakeDb({ checkpoints: { v4_pools_backfill: Number(safeBlock) } });
    const primary = fakeRpc({ calls: stateCalls, readContract: metadata, logs: [initLog(recent, 1_900_000n)] });
    const archive = fakeRpc({ logs: [initLog(old, 1_610_000n)],
      getCode: (_target, blockNumber) => (blockNumber ?? safeBlock) >= deploy ? "0x60" : "0x" });
    await runBackfillPass({ db, dir: v4Directory, client: primary.client, archive: archive.client, now: () => 123 });
    expect(upserts("v4_pool_directory").map((row) => row.created_block)).toEqual([1_900_000, 1_610_000]);
    expect(checkpoint("v4_pools_origin")).toBe(Number(deploy));
    expect(checkpoint("v4_pools_backfill")).toBe(Number(deploy) - 1);
    // The primary RPC only serves its retained ~380k blocks; the archive gets 10k-block windows.
    expect(primary.ranges.every(([from]) => from >= safeBlock - 380_000n)).toBe(true);
    expect(archive.ranges.every(([from, to]) => to - from < 10_000n)).toBe(true);
    // 4 recent and 2 archive windows, yet one store: the database work does not grow with the windows.
    expect(archive.ranges).toHaveLength(4);
    expect(statements.filter(({ sql }) => sql.startsWith("INSERT INTO v4_pool_directory"))).toHaveLength(1);
    expect(statements.length).toBeLessThanOrEqual(8);
  });

  it("stops at an archive rate limit and keeps what the run collected", async () => {
    const key = keyFor(3000);
    const { db, upserts, checkpoint } = fakeDb({ checkpoints: { v4_pools_backfill: 1_500_000, v4_pools_origin: 1_000_000 } });
    const primary = fakeRpc({ calls: stateCalls, readContract: metadata });
    const archive = fakeRpc({ logs: [initLog(key, 1_495_000n)],
      failLogs: ({ toBlock }) => toBlock < 1_490_001n ? new Error("rate limit exceeded") : null });
    await runBackfillPass({ db, dir: v4Directory, client: primary.client, archive: archive.client, now: () => 123 });
    expect(upserts("v4_pool_directory")).toEqual([expect.objectContaining({ created_block: 1_495_000 })]);
    // The first window (1_490_001-1_500_000) completed; the next run resumes below it.
    expect(checkpoint("v4_pools_backfill")).toBe(1_490_000);
  });

  it("hands a recent window the primary RPC no longer keeps to the archive", async () => {
    const key = keyFor(3000);
    const { db, upserts } = fakeDb({ checkpoints: { v4_pools_backfill: Number(safeBlock), v4_pools_origin: 1_999_000 } });
    const primary = fakeRpc({ calls: stateCalls, readContract: metadata,
      failLogs: () => new Error("pruned history unavailable") });
    const archive = fakeRpc({ logs: [initLog(key, 1_999_500n)] });
    await runBackfillPass({ db, dir: v4Directory, client: primary.client, archive: archive.client, now: () => 123 });
    expect(upserts("v4_pool_directory")).toEqual([expect.objectContaining({ created_block: 1_999_500 })]);
  });

  it("refreshes the oldest rows and moves every one read to the back of the queue", async () => {
    const stored = { pool_id: v4PoolId(keyFor(3000)), currency0: zeroAddress, currency1: token, fee: 3000,
      tick_spacing: 60, hooks: zeroAddress, token_address: token, token_symbol: "MEME", token_decimals: 18,
      sqrt_price_x96: "1", tick: 0, liquidity: "1", lp_fee: 3000, block_number: 1, updated_at: 1, created_block: 5 };
    const { db, upserts } = fakeDb({ rows: { v4_pool_directory: [stored] } });
    const { client } = fakeRpc({ calls: stateCalls });
    await refreshDirectory({ db, dir: v4Directory, client, limit: 10, now: () => 999 });
    expect(upserts("v4_pool_directory")).toEqual([expect.objectContaining({ pool_id: stored.pool_id,
      liquidity: "500", tick: -5, updated_at: 999, block_number: Number(safeBlock) })]);
  });
});

describe("v3 pool discovery from PoolCreated events", () => {
  const POOL_CREATED = toEventSelector("PoolCreated(address,address,uint24,int24,address)");
  const factory = UNISWAP_V3_ARC.factory.address;
  const pool = getAddress("0x4444444444444444444444444444444444444444");
  const [token0, token1] = token.toLowerCase() < usdc.toLowerCase() ? [token, usdc] : [usdc, token];
  const stateCalls = {
    [`${pool.toLowerCase()}:${toFunctionSelector("slot0()")}`]: hex(uint(2n ** 96n), int24(7), uint(0),
      uint(0), uint(0), uint(0), uint(1)),
    [`${pool.toLowerCase()}:${toFunctionSelector("liquidity()")}`]: hex(uint(900)),
    [`${usdc.toLowerCase()}:${toFunctionSelector("balanceOf(address)")}`]: hex(uint(42)),
    [`${pool.toLowerCase()}:${toFunctionSelector("tickSpacing()")}`]: hex(int24(10)),
  };
  const createdLog = (emitted: Address, fee: number, block: bigint): FakeLog => ({
    address: factory, block,
    topics: [POOL_CREATED, topicOf(token0), topicOf(token1), pad(`0x${fee.toString(16)}`)],
    data: encodeAbiParameters([{ type: "int24" }, { type: "address" }], [10, emitted]),
  });

  it("adds USDC pools the factory announces, at supported fee tiers only", async () => {
    const unsupported = getAddress("0x5555555555555555555555555555555555555555");
    const { db, upserts } = fakeDb({ checkpoints: { v3_pools_created: 1_999_000 } });
    const { client } = fakeRpc({ calls: stateCalls, readContract: metadata,
      logs: [createdLog(pool, 500, 1_999_100n), createdLog(unsupported, 2_500, 1_999_200n)] });
    await runLivePass({ db, dir: v3Directory, client, now: () => 123 });
    expect(upserts("pool_directory")).toEqual([expect.objectContaining({ pool_address: pool,
      token_address: token, token_symbol: "MEME", fee: 500, tick_spacing: 10, liquidity: "900",
      usdc_reserve: "42", tick: 7, created_block: 1_999_100 })]);
  });

  it("finds a pasted token's pools at once: v4 by token topic, v3 through the factory", async () => {
    const v4Key = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const otherKey = { currency0: zeroAddress, currency1: otherToken, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const INITIALIZE = toEventSelector("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
    const init = (key: typeof v4Key, block: bigint): FakeLog => ({ address: UNISWAP_V4_ARC.poolManager, block,
      topics: [INITIALIZE, v4PoolId(key), topicOf(key.currency0), topicOf(key.currency1)],
      data: encodeAbiParameters(
        [{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }],
        [key.fee, key.tickSpacing, key.hooks, 2n ** 96n, 0]) });
    const stateView = UNISWAP_V4_ARC.stateView.toLowerCase();
    const getPool = (fee: number) => `${factory.toLowerCase()}:${toFunctionSelector("getPool(address,address,uint24)")}${
      address(token0)}${address(token1)}${uint(fee)}`;
    const { db, upserts } = fakeDb();
    const { client } = fakeRpc({ readContract: metadata,
      logs: [init(v4Key, 1_900_000n), init(otherKey, 1_900_001n)],
      calls: { ...stateCalls,
        [`${stateView}:${toFunctionSelector("getSlot0(bytes32)")}`]: hex(uint(2n ** 96n), int24(0), uint(0), uint(3000)),
        [`${stateView}:${toFunctionSelector("getLiquidity(bytes32)")}`]: hex(uint(5)),
        [getPool(100)]: hex(address(zeroAddress)), [getPool(500)]: hex(address(pool)),
        [getPool(3000)]: hex(address(zeroAddress)), [getPool(10_000)]: hex(address(zeroAddress)) } });
    const found = await discoverToken({ db, dirs: [v4Directory, v3Directory], client, token, now: () => 123 });
    expect(found).toBe(2);
    expect(upserts("v4_pool_directory")).toEqual([expect.objectContaining({ pool_id: v4PoolId(v4Key).toLowerCase(),
      created_block: 1_900_000 })]);
    expect(upserts("pool_directory")).toEqual([expect.objectContaining({ pool_address: pool, tick_spacing: 10,
      created_block: null })]);
  });

  it("does not look up an address without contract code", async () => {
    const { db, statements } = fakeDb();
    const { client, ranges } = fakeRpc({ getCode: () => "0x" });
    expect(await discoverToken({ db, dirs: [v4Directory, v3Directory], client, token })).toBe(0);
    expect(ranges).toEqual([]);
    expect(statements).toEqual([]);
  });
});

describe("PoolDiscovery Durable Object", () => {
  function storage(initial: number | null) {
    let alarm = initial;
    return { get alarm() { return alarm; },
      ctx: { storage: { getAlarm: async () => alarm, setAlarm: async (time: number) => { alarm = time; } } } };
  }

  it("starts the alarm loop only when none is scheduled", async () => {
    const idle = storage(null);
    await new PoolDiscovery(idle.ctx as never, {} as never).fetch(new Request("https://pool-discovery/ensure"));
    expect(idle.alarm).not.toBeNull();
    const running = storage(42);
    await new PoolDiscovery(running.ctx as never, {} as never).fetch(new Request("https://pool-discovery/ensure"));
    expect(running.alarm).toBe(42);
  });

  it("reschedules the next tick even when the RPC is down", async () => {
    const state = storage(null);
    const env = { DB: fakeDb().db, ARC_RPC_URL: "http://127.0.0.1:9" };
    const before = Date.now();
    await new PoolDiscovery(state.ctx as never, env as never).alarm();
    expect(state.alarm).toBeGreaterThanOrEqual(before + 10_000);
  }, 20_000);
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
