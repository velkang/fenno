import {
  ARC_TOKENS,
  discoverArcTokenPools,
  type PoolDiscoveryClient,
} from "@stillwater/chain";
import { getAddress, toEventSelector, toFunctionSelector, type Address, type Hex } from "viem";
import {
  encodeAddressArg,
  firstSeen,
  isRpcFailure,
  rawCall,
  readCheckpoint,
  readSkips,
  saveCheckpoint,
  saveSkips,
  scanLogs,
  takeByBlock,
  upsertRows,
  word,
  wordAddress,
  type RawRpcClient,
  type Seen,
} from "./directory-scan";

// The v3 directory lists USDC pools with trades or liquidity changes since the
// indexer started; there is no crawl of historical PoolCreated events.
const CHECKPOINT = "pool_directory_state";
const MAX_LOG_CHUNKS = 5;
// Per-run caps keep each run within the free plan's CPU and subrequest limits
// and the RPC's ~20 calls per second.
const REFRESH_LIMIT = 40; // touched known pools re-read, least recently updated first (3 raw calls each)
const CLASSIFY_LIMIT = 30; // unknown log emitters checked (2 raw calls each)
const DISCOVER_LIMIT = 3; // new USDC tokens run through full discovery (viem reads)
const ACTIVITY_TOPICS = [[
  toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  toEventSelector("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  toEventSelector("Burn(address,int24,int24,uint128,uint256,uint256)"),
]];
const SLOT0 = toFunctionSelector("slot0()");
const LIQUIDITY = toFunctionSelector("liquidity()");
const TOKEN0 = toFunctionSelector("token0()");
const TOKEN1 = toFunctionSelector("token1()");
const BALANCE_OF = toFunctionSelector("balanceOf(address)");
const USDC = ARC_TOKENS.USDC.address;

const COLUMNS = ["pool_address", "token_address", "token_symbol", "token_decimals", "token0_address",
  "token1_address", "fee", "tick_spacing", "sqrt_price_x96", "tick", "liquidity", "usdc_reserve",
  "block_number", "updated_at"];
const STATE_COLUMNS = ["token_symbol", "token_decimals", "sqrt_price_x96", "tick", "liquidity",
  "usdc_reserve", "block_number", "updated_at"];

type DirectoryRow = {
  pool_address: Address; token_address: Address; token_symbol: string; token_decimals: number;
  token0_address: Address; token1_address: Address; fee: number; tick_spacing: number;
  sqrt_price_x96: string; tick: number; liquidity: string; usdc_reserve: string;
  block_number: number; updated_at: number;
};

type DirectoryClient = PoolDiscoveryClient & RawRpcClient & {
  getBlock(parameters: { blockTag: "safe" } | { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null }>;
};

export async function indexPoolDirectory(input: {
  db: D1Database;
  client: DirectoryClient;
  now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const { client, db } = input;
  const safe = await client.getBlock({ blockTag: "safe" });
  if (safe.number === null) throw new Error("Arc safe block unavailable");
  const checkpoint = await readCheckpoint(db, CHECKPOINT);
  if (checkpoint === null) {
    // The directory lists pools active from here on.
    await saveCheckpoint(db, CHECKPOINT, safe.number, safe.hash, now());
    return;
  }
  if (checkpoint >= safe.number) return;

  const { logs, scannedTo } = await scanLogs(client, { topics: ACTIVITY_TOPICS },
    checkpoint + 1n, safe.number, MAX_LOG_CHUNKS);
  const seen = firstSeen(logs, (log) => log.address.toLowerCase());
  const keys = seen.map(({ key }) => key);
  const [known, skipped] = await Promise.all([readKnown(db, keys), readSkips(db, keys)]);
  // Refresh is best effort: busy pools are touched again soon, and cutting the
  // checkpoint for them would let the scan fall behind the chain.
  const refresh = seen.filter(({ key }) => known.has(key))
    .sort((a, b) => known.get(a.key)!.updated_at - known.get(b.key)!.updated_at)
    .slice(0, REFRESH_LIMIT);
  const classify = takeByBlock(seen.filter(({ key }) => !known.has(key) && !skipped.has(key)),
    CLASSIFY_LIMIT);

  const block = safe.number;
  const updatedAt = now();
  const [refreshed, classified] = await Promise.all([
    Promise.all(refresh.map(({ key }) => readState(client, known.get(key)!, block, updatedAt))),
    Promise.all(classify.taken.map(async (item) => ({ ...item,
      token: await usdcPairedToken(client, getAddress(item.key), block) }))),
  ]);

  // One discovery per new token, in the order its first pool appeared.
  const candidates: Array<Seen & { token: Address }> = [];
  for (const item of classified) {
    if (item.token && !candidates.some(({ token }) => token === item.token)) {
      candidates.push({ ...item, token: item.token });
    }
  }
  const discover = takeByBlock(candidates, DISCOVER_LIMIT);
  const discovered = new Map(await Promise.all(discover.taken.map(async ({ token }) =>
    [token, await discoverRows(client, token, block, updatedAt)] as const)));

  const skips: string[] = [];
  for (const item of classified) {
    if (!item.token) { skips.push(item.key); continue; }
    const rows = discovered.get(item.token);
    // Not discovered yet (over this run's cap) carries over; otherwise skip
    // emitters that are not a canonical pool of that token.
    if (rows !== undefined && !rows.some((row) => row.pool_address.toLowerCase() === item.key)) {
      skips.push(item.key);
    }
  }

  const rows = [
    ...refreshed.filter((row): row is DirectoryRow => row !== null),
    ...[...discovered.values()].flat(),
  ];
  await upsertRows(db, "pool_directory", "pool_address", COLUMNS, STATE_COLUMNS, rows);
  await saveSkips(db, "uniswap-v3", skips, updatedAt);

  const handledTo = [scannedTo, classify.handledTo, discover.handledTo]
    .filter((value): value is bigint => value !== null)
    .reduce((low, value) => value < low ? value : low);
  const hash = handledTo === safe.number ? safe.hash
    : (await client.getBlock({ blockNumber: handledTo })).hash;
  await saveCheckpoint(db, CHECKPOINT, handledTo, hash, updatedAt);
}

async function readKnown(db: D1Database, keys: string[]): Promise<Map<string, DirectoryRow>> {
  if (keys.length === 0) return new Map();
  const rows = await db.prepare(
    "SELECT * FROM pool_directory WHERE pool_address IN (SELECT value FROM json_each(?1))",
  ).bind(JSON.stringify(keys)).all<DirectoryRow>();
  return new Map(rows.results.map((row) => [row.pool_address.toLowerCase(), row]));
}

/** Current state of a stored pool, or null when unchanged or unreadable. */
async function readState(client: RawRpcClient, row: DirectoryRow, block: bigint,
  updatedAt: number): Promise<DirectoryRow | null> {
  const pool = getAddress(row.pool_address);
  const [slot0, liquidity, balance] = await Promise.all([
    rawCall(client, pool, SLOT0, block),
    rawCall(client, pool, LIQUIDITY, block),
    rawCall(client, USDC, `${BALANCE_OF}${encodeAddressArg(pool)}` as Hex, block),
  ]);
  const sqrtPrice = slot0 && word(slot0, 0);
  const tickWord = slot0 && word(slot0, 1);
  const liquidityValue = liquidity && word(liquidity, 0);
  const reserve = balance && word(balance, 0);
  if (!sqrtPrice || tickWord === null || liquidityValue === null || reserve === null) return null;
  const next = { ...row, sqrt_price_x96: sqrtPrice.toString(), tick: Number(BigInt.asIntN(24, tickWord)),
    liquidity: liquidityValue.toString(), usdc_reserve: reserve.toString() };
  if (next.sqrt_price_x96 === row.sqrt_price_x96 && next.tick === row.tick &&
      next.liquidity === row.liquidity && next.usdc_reserve === row.usdc_reserve) return null;
  return { ...next, block_number: Number(block), updated_at: updatedAt };
}

/** The non-USDC token of a pool-like contract paired with USDC, or null. */
async function usdcPairedToken(client: RawRpcClient, address: Address, block: bigint): Promise<Address | null> {
  const [token0, token1] = await Promise.all([
    rawCall(client, address, TOKEN0, block),
    rawCall(client, address, TOKEN1, block),
  ]);
  const first = token0 && wordAddress(token0, 0);
  const second = token1 && wordAddress(token1, 0);
  if (!first || !second) return null;
  const [a, b] = [getAddress(first), getAddress(second)];
  if (a === USDC && b !== USDC) return b;
  if (b === USDC && a !== USDC) return a;
  return null;
}

/** Canonical USDC pools of a token as directory rows; [] when the token is unusable. */
async function discoverRows(client: DirectoryClient, tokenAddress: Address, block: bigint,
  updatedAt: number): Promise<DirectoryRow[]> {
  let discovered;
  try {
    discovered = await discoverArcTokenPools({ client, tokenAddress, blockNumber: block });
  } catch (error) {
    // An RPC failure aborts the run so nothing is skipped by mistake; anything
    // else means the token itself is unusable.
    if (isRpcFailure(error)) throw error;
    return [];
  }
  const rows = await Promise.all(discovered.pools.map(async (pool): Promise<DirectoryRow | null> => {
    const balance = await rawCall(client, USDC, `${BALANCE_OF}${encodeAddressArg(pool.address)}` as Hex, block);
    const reserve = balance && word(balance, 0);
    if (reserve === null) return null;
    return {
      pool_address: pool.address, token_address: discovered.token.address,
      token_symbol: discovered.token.symbol, token_decimals: discovered.token.decimals,
      token0_address: pool.token0.address, token1_address: pool.token1.address,
      fee: pool.fee, tick_spacing: pool.tickSpacing, sqrt_price_x96: pool.sqrtPriceX96,
      tick: pool.tick, liquidity: pool.liquidity, usdc_reserve: reserve.toString(),
      block_number: Number(block), updated_at: updatedAt,
    };
  }));
  return rows.filter((row): row is DirectoryRow => row !== null);
}
