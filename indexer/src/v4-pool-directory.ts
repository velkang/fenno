import { ARC_TOKENS, UNISWAP_V4_ARC, v4PoolId, type ArcV4PoolKey,
  type ChainReadClient } from "@stillwater/chain";
import { decodeEventLog, getAddress, parseAbi, toEventSelector, toFunctionSelector, zeroAddress,
  type Address, type Hex } from "viem";
import {
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
  type RpcLog,
  type Seen,
} from "./directory-scan";

// The v4 directory lists USDC pools with Initialize, Swap or ModifyLiquidity
// events since the indexer started; there is no crawl of historical pools.
const initializeEvent = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
])[0];
const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const INITIALIZE = toEventSelector(initializeEvent);
const ACTIVITY_TOPICS = [[
  INITIALIZE,
  toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  toEventSelector("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
]];
const GET_SLOT0 = toFunctionSelector("getSlot0(bytes32)");
const GET_LIQUIDITY = toFunctionSelector("getLiquidity(bytes32)");
const POOL_KEYS = toFunctionSelector("poolKeys(bytes25)");
// Last block whose pool events were applied (name kept from the earlier state scan).
const CHECKPOINT = "v4_pool_state";
// The PoolManager emits ~3-4k events (~2-4 MB of JSON) per 1k blocks; parsing
// more per run risks the 10 ms CPU limit, and one chunk still outpaces the chain
// (~670 blocks per 5-minute run).
const MAX_LOG_CHUNKS = 1;
// Per-run caps keep each run within the free plan's CPU and subrequest limits
// and the RPC's ~20 calls per second.
const REFRESH_LIMIT = 60; // touched known pools re-read, least recently updated first (2 raw calls each)
const CLASSIFY_LIMIT = 40; // unknown pool ids resolved (1 raw call each)
// ~13 USDC pools are created per 1k blocks at the chain head (~9 per run).
const NEW_POOL_LIMIT = 20; // new USDC pools added (viem token metadata reads)
const USDC_CURRENCIES: Address[] = [zeroAddress, ARC_TOKENS.USDC.address];

const COLUMNS = ["pool_id", "currency0", "currency1", "fee", "tick_spacing", "hooks", "token_address",
  "token_symbol", "token_decimals", "sqrt_price_x96", "tick", "liquidity", "lp_fee", "block_number",
  "updated_at"];
const STATE_COLUMNS = ["sqrt_price_x96", "tick", "liquidity", "lp_fee", "block_number", "updated_at"];

type DirectoryRow = {
  pool_id: Hex; currency0: Address; currency1: Address; fee: number; tick_spacing: number;
  hooks: Address; token_address: Address; token_symbol: string; token_decimals: number;
  sqrt_price_x96: string; tick: number; liquidity: string; lp_fee: number;
  block_number: number; updated_at: number;
};
type PoolState = Pick<DirectoryRow, "sqrt_price_x96" | "tick" | "liquidity" | "lp_fee">;

type Client = Pick<ChainReadClient, "readContract"> & RawRpcClient & {
  getBlock(input: { blockTag: "safe" } | { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null }>;
};

export async function indexV4PoolDirectory(input: { db: D1Database; client: Client; now?: () => number }) {
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

  const { logs, scannedTo } = await scanLogs(client,
    { address: UNISWAP_V4_ARC.poolManager, topics: ACTIVITY_TOPICS },
    checkpoint + 1n, safe.number, MAX_LOG_CHUNKS);
  const seen = firstSeen(logs, (log) => log.topics[1]?.toLowerCase() ?? null);
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
  const [refreshed, resolved] = await Promise.all([
    Promise.all(refresh.map(async ({ key }) => {
      const row = known.get(key)!;
      const state = await readState(client, row.pool_id, block);
      if (!state || (state.sqrt_price_x96 === row.sqrt_price_x96 && state.tick === row.tick &&
          state.liquidity === row.liquidity && state.lp_fee === row.lp_fee)) return null;
      return { ...row, ...state, block_number: Number(block), updated_at: updatedAt };
    })),
    Promise.all(classify.taken.map(async (item) => ({ ...item,
      poolKey: initializedKey(item.log) ?? await registeredKey(client, item.key, block) }))),
  ]);

  const skips: string[] = [];
  const usdcPools: Array<Seen & { poolKey: ArcV4PoolKey; token: Address }> = [];
  for (const item of resolved) {
    const token = item.poolKey && pairedToken(item.poolKey);
    if (item.poolKey && token) usdcPools.push({ ...item, poolKey: item.poolKey, token });
    else skips.push(item.key);
  }
  const added = takeByBlock(usdcPools, NEW_POOL_LIMIT);
  const newRows = await Promise.all(added.taken.map(async ({ key, poolKey, token }) => {
    const [state, metadata] = await Promise.all([
      readState(client, key as Hex, block),
      readMetadata(client, token, block),
    ]);
    if (!metadata) { skips.push(key); return null; }
    if (!state) return null;
    return { pool_id: key as Hex, currency0: poolKey.currency0, currency1: poolKey.currency1,
      fee: poolKey.fee, tick_spacing: poolKey.tickSpacing, hooks: poolKey.hooks,
      token_address: token, token_symbol: metadata.symbol, token_decimals: metadata.decimals,
      ...state, block_number: Number(block), updated_at: updatedAt };
  }));

  const rows = [...refreshed, ...newRows].filter((row): row is DirectoryRow => row !== null);
  await upsertRows(db, "v4_pool_directory", "pool_id", COLUMNS, STATE_COLUMNS, rows);
  await saveSkips(db, "uniswap-v4", skips, updatedAt);

  const handledTo = [scannedTo, classify.handledTo, added.handledTo]
    .filter((value): value is bigint => value !== null)
    .reduce((low, value) => value < low ? value : low);
  const hash = handledTo === safe.number ? safe.hash
    : (await client.getBlock({ blockNumber: handledTo })).hash;
  await saveCheckpoint(db, CHECKPOINT, handledTo, hash, updatedAt);
}

async function readKnown(db: D1Database, keys: string[]): Promise<Map<string, DirectoryRow>> {
  if (keys.length === 0) return new Map();
  const rows = await db.prepare(
    "SELECT * FROM v4_pool_directory WHERE pool_id IN (SELECT value FROM json_each(?1))",
  ).bind(JSON.stringify(keys)).all<DirectoryRow>();
  return new Map(rows.results.map((row) => [row.pool_id.toLowerCase(), row]));
}

async function readState(client: RawRpcClient, id: Hex, block: bigint): Promise<PoolState | null> {
  const [slot0, liquidity] = await Promise.all([
    rawCall(client, UNISWAP_V4_ARC.stateView, `${GET_SLOT0}${id.slice(2)}` as Hex, block),
    rawCall(client, UNISWAP_V4_ARC.stateView, `${GET_LIQUIDITY}${id.slice(2)}` as Hex, block),
  ]);
  const sqrtPrice = slot0 && word(slot0, 0);
  const tick = slot0 && word(slot0, 1);
  const lpFee = slot0 && word(slot0, 3);
  const liquidityValue = liquidity && word(liquidity, 0);
  if (!sqrtPrice || tick === null || lpFee === null || liquidityValue === null) return null;
  return { sqrt_price_x96: sqrtPrice.toString(), tick: Number(BigInt.asIntN(24, tick)),
    liquidity: liquidityValue.toString(), lp_fee: Number(lpFee) };
}

/** Pool key from an Initialize log in the scanned range. */
function initializedKey(log: RpcLog): ArcV4PoolKey | null {
  if (log.topics[0] !== INITIALIZE) return null;
  try {
    const { args } = decodeEventLog({ abi: [initializeEvent], data: log.data,
      topics: log.topics as [Hex, ...Hex[]] });
    return verifiedKey(args.id, { currency0: args.currency0, currency1: args.currency1,
      fee: args.fee, tickSpacing: args.tickSpacing, hooks: args.hooks });
  } catch {
    return null;
  }
}

/** Pool key registered with the PositionManager, for pools created before the scan. */
async function registeredKey(client: RawRpcClient, id: string, block: bigint): Promise<ArcV4PoolKey | null> {
  const result = await rawCall(client, UNISWAP_V4_ARC.positionManager,
    `${POOL_KEYS}${id.slice(2, 52).padEnd(64, "0")}` as Hex, block);
  if (!result) return null;
  const currency0 = wordAddress(result, 0);
  const currency1 = wordAddress(result, 1);
  const fee = word(result, 2);
  const tickSpacing = word(result, 3);
  const hooks = wordAddress(result, 4);
  if (!currency0 || !currency1 || fee === null || tickSpacing === null || !hooks) return null;
  return verifiedKey(id, { currency0, currency1, fee: Number(fee),
    tickSpacing: Number(BigInt.asIntN(24, tickSpacing)), hooks });
}

/** The key only if it hashes to the pool id; a zero (unregistered) key never does. */
function verifiedKey(id: string, key: ArcV4PoolKey): ArcV4PoolKey | null {
  try {
    const checked = { currency0: getAddress(key.currency0), currency1: getAddress(key.currency1),
      fee: key.fee, tickSpacing: key.tickSpacing, hooks: getAddress(key.hooks) };
    return v4PoolId(checked).toLowerCase() === id.toLowerCase() ? checked : null;
  } catch {
    return null;
  }
}

/** The non-USDC currency of a USDC-paired key, or null. */
function pairedToken(key: ArcV4PoolKey): Address | null {
  const token = USDC_CURRENCIES.includes(key.currency0) ? key.currency1
    : USDC_CURRENCIES.includes(key.currency1) ? key.currency0 : null;
  return token && !USDC_CURRENCIES.includes(token) ? token : null;
}

async function readMetadata(client: Client, token: Address, block: bigint):
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
