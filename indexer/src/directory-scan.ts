import { ARC_CHAIN_ID } from "@stillwater/chain";
import { toHex, type Address, type Hex } from "viem";

// Helpers shared by the v3 and v4 pool directories. Both run within Cloudflare's
// free plan: 50 subrequests (HTTP + D1 statements) and 10 ms CPU per invocation.
// Calls issued together are sent as one JSON-RPC batch by the transport, and pool
// state is read with raw eth_calls because decoding through viem costs far more CPU.

export type RawRpcClient = {
  request(args: { method: string; params: unknown[] }): Promise<unknown>;
};

export type RpcLog = { address: Address; blockNumber: Hex; topics: Hex[]; data: Hex };

export type Seen = { key: string; block: bigint; log: RpcLog };

const LOG_CHUNK = 1_000n;

/** Fetches logs for [first, last], at most `maxChunks` 1k-block chunks, in one batch. */
export async function scanLogs(client: RawRpcClient, filter: { address?: Address; topics: unknown[] },
  first: bigint, safe: bigint, maxChunks: number): Promise<{ logs: RpcLog[]; scannedTo: bigint }> {
  const last = first + LOG_CHUNK * BigInt(maxChunks) - 1n < safe
    ? first + LOG_CHUNK * BigInt(maxChunks) - 1n : safe;
  const ranges: Array<[bigint, bigint]> = [];
  for (let from = first; from <= last; from += LOG_CHUNK) {
    ranges.push([from, from + LOG_CHUNK - 1n < last ? from + LOG_CHUNK - 1n : last]);
  }
  const chunks = await Promise.all(ranges.map(([fromBlock, toBlock]) => client.request({
    method: "eth_getLogs",
    params: [{ ...filter, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }],
  }) as Promise<RpcLog[]>));
  return { logs: chunks.flat(), scannedTo: last };
}

/** First log per key, in block order (logs arrive in block order). */
export function firstSeen(logs: RpcLog[], keyOf: (log: RpcLog) => string | null): Seen[] {
  const seen = new Map<string, Seen>();
  for (const log of logs) {
    const key = keyOf(log);
    if (key !== null && !seen.has(key)) seen.set(key, { key, block: BigInt(log.blockNumber), log });
  }
  return [...seen.values()];
}

/**
 * Takes items in block order up to `limit`, finishing the block of the last one
 * taken. `handledTo` is the last block whose items were all taken, or null if
 * everything was taken; the caller checkpoints there so the rest carries over.
 */
export function takeByBlock<T extends { block: bigint }>(items: T[], limit: number):
  { taken: T[]; handledTo: bigint | null } {
  if (items.length <= limit) return { taken: items, handledTo: null };
  let end = Math.max(limit, 1);
  while (end < items.length && items[end].block === items[end - 1].block) end += 1;
  if (end === items.length) return { taken: items, handledTo: null };
  return { taken: items.slice(0, end), handledTo: items[end].block - 1n };
}

/** True for transport-level failures (rate limits, timeouts), as opposed to reverts. */
export function isRpcFailure(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return ["rate limit", "exceeds defined limit", "http request failed", "timed out", "took too long",
    "fetch failed", "too many requests"].some((text) => message.includes(text));
}

/**
 * eth_call returning the raw result, or null if the call reverted or returned
 * nothing. Transport failures are rethrown so a flaky RPC never gets a pool
 * skipped; the run is retried with its checkpoint unchanged.
 */
export async function rawCall(client: RawRpcClient, to: Address, data: Hex, block: bigint): Promise<Hex | null> {
  try {
    const result = await client.request({ method: "eth_call", params: [{ to, data }, toHex(block)] });
    return typeof result === "string" && result.length > 2 ? result as Hex : null;
  } catch (error) {
    if (isRpcFailure(error)) throw error;
    return null;
  }
}

/** 32-byte word `index` of an ABI-encoded result as an unsigned integer. */
export function word(result: Hex, index: number): bigint | null {
  const hex = result.slice(2 + index * 64, 66 + index * 64);
  return hex.length === 64 ? BigInt(`0x${hex}`) : null;
}

export function wordAddress(result: Hex, index: number): Address | null {
  const value = word(result, index);
  return value === null ? null : `0x${value.toString(16).padStart(40, "0")}` as Address;
}

export function encodeAddressArg(address: Address): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

export async function readCheckpoint(db: D1Database, name: string): Promise<bigint | null> {
  const row = await db.prepare("SELECT block_number FROM chain_indexer_checkpoints WHERE name = ?1")
    .bind(name).first<{ block_number: number }>();
  return row ? BigInt(row.block_number) : null;
}

export async function saveCheckpoint(db: D1Database, name: string, block: bigint, hash: Hex | null,
  updatedAt: number): Promise<void> {
  await db.prepare(
    `INSERT INTO chain_indexer_checkpoints (name, chain_id, block_number, block_hash, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(name) DO UPDATE SET block_number=excluded.block_number,
      block_hash=excluded.block_hash, updated_at=excluded.updated_at`,
  ).bind(name, ARC_CHAIN_ID, Number(block), hash ?? "0x", updatedAt).run();
}

export async function readSkips(db: D1Database, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.prepare(
    "SELECT pool_key FROM pool_directory_skips WHERE pool_key IN (SELECT value FROM json_each(?1))",
  ).bind(JSON.stringify(keys)).all<{ pool_key: string }>();
  return new Set(rows.results.map((row) => row.pool_key.toLowerCase()));
}

export async function saveSkips(db: D1Database, protocol: "uniswap-v3" | "uniswap-v4", keys: string[],
  createdAt: number): Promise<void> {
  if (keys.length === 0) return;
  await db.prepare(
    `INSERT OR IGNORE INTO pool_directory_skips (pool_key, protocol, created_at)
     SELECT value, ?2, ?3 FROM json_each(?1)`,
  ).bind(JSON.stringify(keys), protocol, createdAt).run();
}

/** Upserts rows through one statement per chunk; `columns` are the JSON field names. */
export async function upsertRows(db: D1Database, table: string, keyColumn: string, columns: string[],
  updateColumns: string[], rows: Array<Record<string, string | number>>): Promise<void> {
  const select = columns.map((column) => `value ->> '$.${column}'`).join(", ");
  const update = updateColumns.map((column) => `${column}=excluded.${column}`).join(", ");
  for (let start = 0; start < rows.length; start += 200) {
    await db.prepare(
      // "WHERE true" lets SQLite parse the ON CONFLICT clause after a SELECT.
      `INSERT INTO ${table} (${columns.join(", ")})
       SELECT ${select} FROM json_each(?1) WHERE true
       ON CONFLICT(${keyColumn}) DO UPDATE SET ${update}`,
    ).bind(JSON.stringify(rows.slice(start, start + 200))).run();
  }
}
