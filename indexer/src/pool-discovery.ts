import type { ChainReadClient } from "@stillwater/chain";
import { parseAbi, type Address, type Hex } from "viem";
import {
  fetchLogs,
  isRpcFailure,
  readCheckpoint,
  readSkips,
  saveCheckpoint,
  saveSkips,
  takeByBlock,
  upsertRows,
  type RawRpcClient,
  type RpcLog,
} from "./directory-scan";

// Pools are discovered from their creation events, filtered to USDC pairs: about
// two a minute on Arc, versus thousands of trade events. Three passes per protocol:
// - live: checkpoint -> latest block, run every ~10 s by the PoolDiscovery Durable Object;
// - backfill: walks backwards from where live started, through the primary RPC's
//   retained history in wide windows, then the archive RPC in 10k-block windows,
//   down to the contract's deploy block;
// - refresh: re-reads stored pool state, oldest first, for listing and filtering.

export type DirectoryRow = Record<string, string | number | null>;

export type DirectoryClient = Pick<ChainReadClient, "readContract"> & RawRpcClient & {
  getBlock(input: { blockTag: "safe" } | { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null }>;
  getCode(input: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
};

export type CreatedPool = {
  key: string;
  block: bigint;
  token: Address;
  /** The directory row, or null when the pool or its token is unusable (it is then skipped). */
  build(client: DirectoryClient, block: bigint, updatedAt: number): Promise<DirectoryRow | null>;
};

export type ProtocolDirectory = {
  name: "v3" | "v4";
  protocol: "uniswap-v3" | "uniswap-v4";
  table: "pool_directory" | "v4_pool_directory";
  keyColumn: "pool_address" | "pool_id";
  columns: string[];
  stateColumns: string[];
  emitter: Address;
  /** eth_getLogs topic filters for USDC pool creations, optionally of one token. */
  creationTopics(token?: Address): unknown[][];
  decode(log: RpcLog): CreatedPool | null;
  /** Direct lookup of a token's pools, when the protocol has one (v3 factory getPool). */
  lookupToken?(client: DirectoryClient, token: Address, block: bigint): Promise<CreatedPool[]>;
  readState(client: RawRpcClient, row: DirectoryRow, block: bigint): Promise<DirectoryRow | null>;
};

const LIVE_WINDOW = 10_000n; // blocks per live tick, enough to catch up after an outage
const LIVE_CAP = 100; // new pools per live tick (~2 are created per 10 s)
const RECENT_RETENTION = 380_000n; // history the primary RPC keeps (Blockdaemon keeps ~400k blocks)
const RECENT_WINDOW = 100_000n; // Blockdaemon's max eth_getLogs range
const HISTORY_WINDOW = 10_000n; // QuickNode's max eth_getLogs range
// Keyless archive RPCs allow only a few eth_getLogs per second, so a run scans windows
// one at a time and stops at the first rate limit, keeping what it collected.
const HISTORY_WINDOWS_PER_RUN = 150;
const BACKFILL_CAP = 100; // new pools per backfill run
const TOKEN_LOOKUP_CAP = 50;

// "refresh" stores a rowid, not a block: where the next directory refresh slice starts.
const checkpointName = (dir: ProtocolDirectory, pass: "created" | "backfill" | "origin" | "refresh") =>
  `${dir.name}_pools_${pass}`;

const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export async function readMetadata(client: DirectoryClient, token: Address, block: bigint):
  Promise<{ symbol: string; decimals: number } | null> {
  try {
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: tokenAbi, functionName: "decimals", blockNumber: block }),
      client.readContract({ address: token, abi: tokenAbi, functionName: "symbol", blockNumber: block })
        .catch(() => "TOKEN"),
    ]);
    if (typeof decimals !== "number" || decimals < 0 || decimals > 18) return null;
    return { decimals, symbol: typeof symbol === "string" && symbol.length > 0 ? symbol.slice(0, 32) : "TOKEN" };
  } catch (error) {
    if (isRpcFailure(error)) throw error;
    return null;
  }
}

async function latestBlock(client: DirectoryClient) {
  const safe = await client.getBlock({ blockTag: "safe" });
  if (safe.number === null) throw new Error("Arc safe block unavailable");
  return { number: safe.number, hash: safe.hash };
}

/** USDC pool creations in [from, to], one per pool, oldest first. */
async function fetchCreated(dir: ProtocolDirectory, client: RawRpcClient, from: bigint, to: bigint,
  token?: Address): Promise<CreatedPool[]> {
  const logs = await fetchLogs(client, dir.emitter, dir.creationTopics(token), from, to);
  const pools = new Map<string, CreatedPool>();
  for (const log of logs) {
    const pool = dir.decode(log);
    if (pool && (!token || pool.token.toLowerCase() === token.toLowerCase()) && !pools.has(pool.key)) {
      pools.set(pool.key, pool);
    }
  }
  return [...pools.values()].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
}

/**
 * Adds the pools not yet listed or skipped, up to `cap`, in the given order. Known
 * pools get their creation block filled in. `next` is the block of the first pool left
 * over for the next run, or null when all were handled.
 */
async function storeCreated(db: D1Database, dir: ProtocolDirectory, client: DirectoryClient,
  pools: CreatedPool[], cap: number, block: bigint, updatedAt: number): Promise<{ next: bigint | null; added: number }> {
  if (pools.length === 0) return { next: null, added: 0 };
  const keys = pools.map(({ key }) => key);
  const [known, skipped] = await Promise.all([readKnown(db, dir, keys), readSkips(db, keys)]);
  await fillCreatedBlocks(db, dir, pools.filter(({ key }) => known.has(key)));
  const fresh = takeByBlock(pools.filter(({ key }) => !known.has(key) && !skipped.has(key)), cap);
  const built = await Promise.all(fresh.taken.map(async (pool) => ({ pool,
    row: await pool.build(client, block, updatedAt) })));
  await upsertRows(db, dir.table, dir.keyColumn, dir.columns, dir.stateColumns,
    built.flatMap(({ row }) => (row ? [row] : [])));
  await saveSkips(db, dir.protocol, built.filter(({ row }) => !row).map(({ pool }) => pool.key), updatedAt);
  return { next: fresh.handledTo === null ? null : fresh.handledTo + 1n, added: fresh.taken.length };
}

async function readKnown(db: D1Database, dir: ProtocolDirectory, keys: string[]): Promise<Set<string>> {
  const rows = await db.prepare(
    `SELECT ${dir.keyColumn} AS pool_key FROM ${dir.table}
     WHERE ${dir.keyColumn} IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(keys)).all<{ pool_key: string }>();
  return new Set(rows.results.map((row) => row.pool_key.toLowerCase()));
}

async function fillCreatedBlocks(db: D1Database, dir: ProtocolDirectory, pools: CreatedPool[]) {
  const entries = pools.filter(({ block }) => block > 0n).map(({ key, block }) => ({ k: key, b: Number(block) }));
  if (entries.length === 0) return;
  await db.prepare(
    `UPDATE ${dir.table} SET created_block = json_extract(entry.value, '$.b')
     FROM json_each(?1) AS entry
     WHERE ${dir.keyColumn} = json_extract(entry.value, '$.k') AND created_block IS NULL`,
  ).bind(JSON.stringify(entries)).run();
}

/** New pools from the live checkpoint up to the latest block. */
export async function runLivePass(input: { db: D1Database; dir: ProtocolDirectory; client: DirectoryClient;
  now?: () => number }): Promise<void> {
  const { db, dir, client } = input;
  const now = input.now ?? Date.now;
  const latest = await latestBlock(client);
  const checkpoint = await readCheckpoint(db, checkpointName(dir, "created"));
  if (checkpoint === null) {
    // Start at the chain head; the backfill covers everything before it.
    await saveCheckpoint(db, checkpointName(dir, "backfill"), latest.number, latest.hash, now());
    await saveCheckpoint(db, checkpointName(dir, "created"), latest.number, latest.hash, now());
    return;
  }
  if (checkpoint >= latest.number) return;
  const to = checkpoint + LIVE_WINDOW < latest.number ? checkpoint + LIVE_WINDOW : latest.number;
  const pools = await fetchCreated(dir, client, checkpoint + 1n, to);
  const { next } = await storeCreated(db, dir, client, pools, LIVE_CAP, latest.number, now());
  const handledTo = next === null ? to : next - 1n;
  await saveCheckpoint(db, checkpointName(dir, "created"), handledTo,
    handledTo === latest.number ? latest.hash : null, now());
}

/**
 * Walks the backfill cursor down one run's worth: recent history first, then the
 * archive. Pools are collected across windows and stored once per run, so the
 * database work stays the same however many windows a run scans.
 */
export async function runBackfillPass(input: { db: D1Database; dir: ProtocolDirectory; client: DirectoryClient;
  archive: DirectoryClient; now?: () => number }): Promise<void> {
  const { db, dir, client, archive } = input;
  const now = input.now ?? Date.now;
  const start = await readCheckpoint(db, checkpointName(dir, "backfill"));
  if (start === null) return;
  let origin = await readCheckpoint(db, checkpointName(dir, "origin"));
  if (origin === null) {
    origin = await deployBlock(archive, dir.emitter, start);
    await saveCheckpoint(db, checkpointName(dir, "origin"), origin, null, now());
  }
  if (start < origin) return;
  const latest = await latestBlock(client);
  const recentFloor = latest.number > RECENT_RETENTION ? latest.number - RECENT_RETENTION : 0n;
  const pools: CreatedPool[] = []; // newest first
  let cursor = start; // highest block not scanned yet
  let historyWindows = HISTORY_WINDOWS_PER_RUN;
  let primaryUsable = true;
  while (cursor >= origin && pools.length < BACKFILL_CAP && historyWindows > 0) {
    // Recent history comes from the primary RPC in wide windows (~1.5k pools per 100k
    // blocks); older history from the archive RPC.
    const recent = primaryUsable && cursor >= recentFloor;
    const size = recent ? RECENT_WINDOW : HISTORY_WINDOW;
    const floor = recent ? (recentFloor > origin ? recentFloor : origin) : origin;
    const from: bigint = cursor - size + 1n > floor ? cursor - size + 1n : floor;
    try {
      pools.push(...(await fetchCreated(dir, recent ? client : archive, from, cursor)).reverse());
    } catch (error) {
      // Rate limited: keep what this run collected and continue from here next run.
      if (isRpcFailure(error)) break;
      // A primary RPC that no longer keeps this range (or rejects its width) hands over to the archive.
      if (!recent) throw error;
      primaryUsable = false;
      continue;
    }
    if (!recent) historyWindows -= 1;
    cursor = from - 1n;
  }
  const { next } = await storeCreated(db, dir, client, pools, BACKFILL_CAP, latest.number, now());
  // Pools past this run's cap are rescanned next run, from the first one left over.
  await saveCheckpoint(db, checkpointName(dir, "backfill"), next ?? cursor, null, now());
}

/** First block at which `address` has code, by binary search on the archive RPC. */
async function deployBlock(archive: DirectoryClient, address: Address, below: bigint): Promise<bigint> {
  let low = 0n;
  let high = below;
  while (low < high) {
    const middle = (low + high) / 2n;
    const code = await archive.getCode({ address, blockNumber: middle });
    if (code && code !== "0x") high = middle; else low = middle + 1n;
  }
  return low;
}

/**
 * Re-reads a slice of the directory so listings and liquidity filters stay current. It walks the
 * table in rowid order from a saved position, so each run reads only its slice (an ORDER BY on an
 * unindexed column read the whole table), and it writes back only pools whose state changed:
 * D1 bills every row read and written.
 */
export async function refreshDirectory(input: { db: D1Database; dir: ProtocolDirectory; client: DirectoryClient;
  limit: number; now?: () => number }): Promise<void> {
  const { db, dir, client } = input;
  const now = input.now ?? Date.now;
  const cursorName = checkpointName(dir, "refresh");
  const slice = (after: bigint) => db.prepare(
    `SELECT rowid AS refresh_rowid, * FROM ${dir.table} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`)
    .bind(Number(after), input.limit).all<DirectoryRow>();
  const after = await readCheckpoint(db, cursorName) ?? 0n;
  let rows = (await slice(after)).results;
  if (rows.length === 0 && after > 0n) rows = (await slice(0n)).results; // past the end: start over
  if (rows.length === 0) return;
  const latest = await latestBlock(client);
  const updatedAt = now();
  const states = await Promise.all(rows.map((row) => dir.readState(client, row, latest.number)));
  const tracked = dir.stateColumns.filter((column) => column !== "block_number" && column !== "updated_at");
  const changed = rows.flatMap((row, index) => {
    const state = states[index] as DirectoryRow | null;
    if (!state || tracked.every((column) => String(state[column] ?? "") === String(row[column] ?? ""))) return [];
    return [{ ...row, ...state, block_number: Number(latest.number), updated_at: updatedAt }];
  });
  if (changed.length > 0) {
    await upsertRows(db, dir.table, dir.keyColumn, dir.columns, dir.stateColumns, changed);
  }
  // A short slice means the end of the table was reached: the next run starts from the top.
  const last = rows[rows.length - 1].refresh_rowid;
  await saveCheckpoint(db, cursorName, rows.length < input.limit ? 0n : BigInt(last ?? 0), null, updatedAt);
}

/** Finds and stores a token's USDC pools right away, for a pasted contract address. */
export async function discoverToken(input: { db: D1Database; dirs: ProtocolDirectory[]; client: DirectoryClient;
  token: Address; now?: () => number }): Promise<number> {
  const { db, dirs, client, token } = input;
  const now = input.now ?? Date.now;
  const code = await client.getCode({ address: token });
  if (!code || code === "0x") return 0;
  const latest = await latestBlock(client);
  const recentFloor = latest.number > RECENT_RETENTION ? latest.number - RECENT_RETENTION : 0n;
  const found = await Promise.all(dirs.map(async (dir) => {
    let pools: CreatedPool[];
    if (dir.lookupToken) {
      pools = await dir.lookupToken(client, token, latest.number);
    } else {
      const windows: Array<[bigint, bigint]> = [];
      for (let to = latest.number; to > recentFloor; to -= RECENT_WINDOW) {
        windows.push([to - RECENT_WINDOW + 1n > recentFloor ? to - RECENT_WINDOW + 1n : recentFloor + 1n, to]);
      }
      pools = (await Promise.all(windows.map(([from, to]) => fetchCreated(dir, client, from, to, token)))).flat();
    }
    await storeCreated(db, dir, client, pools, TOKEN_LOOKUP_CAP, latest.number, now());
    return pools.length;
  }));
  return found.reduce((sum, count) => sum + count, 0);
}
