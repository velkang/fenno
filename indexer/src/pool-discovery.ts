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

// The directory is a rolling list of recent USDC pools, kept only because the chain cannot
// answer "list the newest pools" or "find by symbol". D1 bills every row read and written,
// so nothing here runs on work the chain can answer directly:
// - live: new pools from their creation events, every ~10 s (PoolDiscovery Durable Object);
// - refresh: walks the list in slices, recording only when a pool's liquidity appears or
//   disappears (prices are read live when listed) and expiring pools older than RETENTION_MS;
// - token lookup: a pasted contract address is looked up on chain and listed again.
// Older pools are not backfilled: they are reached by contract address.

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
  /** Tables (with their pool column) whose rows mean a user acted on a pool: such pools never expire. */
  usedBy: Array<{ table: string; column: string }>;
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
const TOKEN_LOOKUP_CAP = 50;
// The live position lives in memory between ticks and is saved to the database only this
// often: pools appear on most ticks, so saving with each one would cost a write per tick.
const POSITION_SAVE_MS = 60_000;
/** How long a pool stays listed after it was added or its liquidity last appeared or disappeared. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

// "refresh" stores a rowid, not a block: where the next directory refresh slice starts.
const checkpointName = (dir: ProtocolDirectory, pass: "created" | "refresh") =>
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

/** Where the live pass has read up to, and when that was last saved to the database. */
export type LivePosition = { block: bigint; savedAt: number };

/**
 * New pools from the live position up to the latest block. The caller keeps the returned
 * position in memory; it is written to the database once POSITION_SAVE_MS has passed.
 * After a restart the saved position is read back, and re-seeing up to a minute of blocks
 * is harmless: pools already listed are skipped.
 */
export async function runLivePass(input: { db: D1Database; dir: ProtocolDirectory; client: DirectoryClient;
  position?: LivePosition | null; now?: () => number }): Promise<LivePosition> {
  const { db, dir, client } = input;
  const now = input.now ?? Date.now;
  const name = checkpointName(dir, "created");
  const latest = await latestBlock(client);
  let position = input.position ?? null;
  if (!position) {
    const saved = await readCheckpoint(db, name);
    if (saved === null) {
      // First run: start at the chain head. Earlier pools are reached by contract address.
      await saveCheckpoint(db, name, latest.number, latest.hash, now());
      return { block: latest.number, savedAt: now() };
    }
    position = { block: saved, savedAt: 0 };
  }
  if (position.block >= latest.number) return position;
  const to = position.block + LIVE_WINDOW < latest.number ? position.block + LIVE_WINDOW : latest.number;
  const pools = await fetchCreated(dir, client, position.block + 1n, to);
  const { next } = await storeCreated(db, dir, client, pools, LIVE_CAP, latest.number, now());
  const handledTo = next === null ? to : next - 1n;
  if (now() - position.savedAt < POSITION_SAVE_MS) return { block: handledTo, savedAt: position.savedAt };
  await saveCheckpoint(db, name, handledTo, handledTo === latest.number ? latest.hash : null, now());
  return { block: handledTo, savedAt: now() };
}

/**
 * Walks one slice of the directory, in rowid order from a saved position so a run reads only
 * its slice. In that slice it:
 * - expires pools last touched more than RETENTION_MS ago, unless a user has acted on them
 *   (their row holds the pool key every later action needs), at most `expireLimit` per run
 *   so a backlog clears gradually;
 * - records when a remaining pool's liquidity appeared or disappeared. Prices and ticks are
 *   not written: listings read them live from the chain.
 */
export async function refreshDirectory(input: { db: D1Database; dir: ProtocolDirectory; client: DirectoryClient;
  limit: number; expireLimit: number; now?: () => number }): Promise<void> {
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
  const updatedAt = now();
  const expired = await expirePools(db, dir, rows, updatedAt - RETENTION_MS, input.expireLimit);
  const kept = rows.filter((row) => !expired.has(String(row[dir.keyColumn]).toLowerCase()));
  const latest = await latestBlock(client);
  const states = await Promise.all(kept.map((row) => dir.readState(client, row, latest.number)));
  const hasLiquidity = (value: unknown) => String(value ?? "0") !== "0";
  const changed = kept.flatMap((row, index) => {
    const state = states[index] as DirectoryRow | null;
    if (!state || hasLiquidity(state.liquidity) === hasLiquidity(row.liquidity)) return [];
    return [{ ...row, ...state, block_number: Number(latest.number), updated_at: updatedAt }];
  });
  if (changed.length > 0) {
    await upsertRows(db, dir.table, dir.keyColumn, dir.columns, dir.stateColumns, changed);
  }
  // A short slice means the end of the table was reached: the next run starts from the top.
  const last = rows[rows.length - 1].refresh_rowid;
  await saveCheckpoint(db, cursorName, rows.length < input.limit ? 0n : BigInt(last ?? 0), null, updatedAt);
}

/** Deletes up to `limit` of the rows older than `cutoff` that no user has acted on; returns their keys, lowercased. */
async function expirePools(db: D1Database, dir: ProtocolDirectory, rows: DirectoryRow[], cutoff: number,
  limit: number): Promise<Set<string>> {
  const old = rows.filter((row) => Number(row.updated_at) < cutoff).map((row) => String(row[dir.keyColumn]));
  if (old.length === 0 || limit <= 0) return new Set();
  // NOCASE matches each intent table's pool-column index, so this reads only matching rows.
  const used = await db.prepare(
    dir.usedBy.map(({ table, column }) =>
      `SELECT ${column} AS pool_key FROM ${table} WHERE ${column} COLLATE NOCASE IN (SELECT value FROM json_each(?1))`)
      .join(" UNION "),
  ).bind(JSON.stringify(old)).all<{ pool_key: string }>();
  const usedKeys = new Set(used.results.map((row) => row.pool_key.toLowerCase()));
  const expire = old.filter((key) => !usedKeys.has(key.toLowerCase())).slice(0, limit);
  if (expire.length === 0) return new Set();
  await db.prepare(
    `DELETE FROM ${dir.table} WHERE ${dir.keyColumn} IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(expire)).run();
  return new Set(expire.map((key) => key.toLowerCase()));
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
