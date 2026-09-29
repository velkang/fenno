import { ARC_CHAIN_ID, ARC_TOKENS, UNISWAP_V4_ARC, readArcV4Pool, v4PoolId,
  type ArcV4PoolKey, type ChainReadClient } from "@stillwater/chain";
import { getAddress, parseAbi, zeroAddress, type Address, type Hex } from "viem";

const initializeEvent = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
])[0];
const stateEvents = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
// PoolManager creation transaction in Uniswap's Arc deployment manifest.
const DEPLOYMENT_BLOCK = 1_948_056n;
const BLOCKS_PER_RUN = 20_000n;
const LOG_CHUNK = 1_000n;
// Pools read concurrently; multicall batching folds each group into a few eth_calls.
const REFRESH_GROUP = 20;
const CHECKPOINT = "v4_pool_directory";
// Last block whose Swap/ModifyLiquidity logs were applied; only touched pools are re-read.
const STATE_CHECKPOINT = "v4_pool_state";

type Client = Pick<ChainReadClient, "readContract"> & {
  getBlock(input: { blockTag: "safe" } | { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null }>;
  getLogs(input: { address: Address; fromBlock: bigint; toBlock: bigint } &
    ({ event: typeof initializeEvent } | { events: typeof stateEvents })): Promise<Array<{
    args: { id?: Hex; currency0?: Address; currency1?: Address; fee?: number;
      tickSpacing?: number; hooks?: Address };
  }>>;
};

export async function indexV4PoolDirectory(input: { db: D1Database; client: Client; now?: () => number }) {
  const now = input.now ?? Date.now;
  const safe = await input.client.getBlock({ blockTag: "safe" });
  if (safe.number === null) throw new Error("Arc safe block unavailable");
  const checkpoint = await input.db.prepare(
    "SELECT block_number FROM chain_indexer_checkpoints WHERE name = ?1",
  ).bind(CHECKPOINT).first<{ block_number: number }>();
  const historicalLast = checkpoint ? BigInt(checkpoint.block_number) - 1n : safe.number;
  const historicalFirst = historicalLast >= DEPLOYMENT_BLOCK
    ? historicalLast - BLOCKS_PER_RUN + 1n > DEPLOYMENT_BLOCK
      ? historicalLast - BLOCKS_PER_RUN + 1n : DEPLOYMENT_BLOCK
    : DEPLOYMENT_BLOCK;
  const recentFirst = safe.number - LOG_CHUNK + 1n > DEPLOYMENT_BLOCK
    ? safe.number - LOG_CHUNK + 1n : DEPLOYMENT_BLOCK;
  const keys = new Map<Hex, ArcV4PoolKey>();
  const collect = (logs: Awaited<ReturnType<Client["getLogs"]>>) => {
    for (const log of logs) {
      const { id, currency0, currency1, fee, tickSpacing, hooks } = log.args;
      if (!id || !currency0 || !currency1 || fee === undefined || tickSpacing === undefined || !hooks) continue;
      try {
        const key = { currency0: getAddress(currency0), currency1: getAddress(currency1),
          fee, tickSpacing, hooks: getAddress(hooks) };
        if (v4PoolId(key).toLowerCase() !== id.toLowerCase()) continue;
        if (![zeroAddress, ARC_TOKENS.USDC.address].includes(key.currency0) &&
            ![zeroAddress, ARC_TOKENS.USDC.address].includes(key.currency1)) continue;
        keys.set(id, key);
      } catch {
        // A malformed pool key must not stop indexing unrelated pools.
      }
    }
  };
  let oldestScanned: bigint | null = null;
  for (let toBlock = historicalLast; toBlock >= historicalFirst;) {
    const fromBlock = toBlock - LOG_CHUNK + 1n > historicalFirst
      ? toBlock - LOG_CHUNK + 1n : historicalFirst;
    try {
      collect(await input.client.getLogs({ address: UNISWAP_V4_ARC.poolManager,
        event: initializeEvent, fromBlock, toBlock }));
      oldestScanned = fromBlock;
      toBlock = fromBlock - 1n;
    } catch (error) {
      console.warn("V4 historical scan will resume next run", error);
      break;
    }
  }
  if (historicalLast < recentFirst) {
    try {
      collect(await input.client.getLogs({ address: UNISWAP_V4_ARC.poolManager,
        event: initializeEvent, fromBlock: recentFirst, toBlock: safe.number }));
    } catch (error) {
      console.warn("V4 recent scan will resume next run", error);
    }
  }
  const stored = await input.db.prepare(
    `SELECT currency0, currency1, fee, tick_spacing, hooks, token_symbol, token_decimals
     FROM v4_pool_directory`,
  ).all<{ currency0: Address; currency1: Address; fee: number; tick_spacing: number;
    hooks: Address; token_symbol: string; token_decimals: number }>();
  const touched = await scanTouchedPools(input.db, input.client, safe.number);
  const storedIds = new Set<string>();
  const refreshes: Array<{ id: Hex; key: ArcV4PoolKey; metadata?: { symbol: string; decimals: number } }> = [];
  for (const row of stored.results) {
    const key = { currency0: getAddress(row.currency0), currency1: getAddress(row.currency1),
      fee: row.fee, tickSpacing: row.tick_spacing, hooks: getAddress(row.hooks) };
    const id = v4PoolId(key);
    storedIds.add(id.toLowerCase());
    if (!touched.ids || touched.ids.has(id.toLowerCase())) {
      refreshes.push({ id, key, metadata: { symbol: row.token_symbol, decimals: row.token_decimals } });
    }
  }
  for (const [id, key] of keys) {
    if (!storedIds.has(id.toLowerCase())) refreshes.push({ id, key });
  }
  // Stop at the first RPC limit so the rest of the run doesn't keep hammering the endpoint;
  // unread pools are retried next run because neither checkpoint advances.
  let readLimited = false;
  const blockNumber = safe.number;
  for (let start = 0; start < refreshes.length && !readLimited; start += REFRESH_GROUP) {
    await Promise.all(refreshes.slice(start, start + REFRESH_GROUP).map(async ({ id, key, metadata }) => {
      try {
        const token = key.currency0 === zeroAddress || key.currency0 === ARC_TOKENS.USDC.address
          ? key.currency1 : key.currency0;
        if (token === zeroAddress || token === ARC_TOKENS.USDC.address) return;
        const [pool, decimals, symbol] = await Promise.all([
          readArcV4Pool({ client: input.client, key, blockNumber }),
          metadata?.decimals ?? input.client.readContract({ address: token, abi: tokenAbi, functionName: "decimals", blockNumber }),
          metadata?.symbol ?? input.client.readContract({ address: token, abi: tokenAbi, functionName: "symbol", blockNumber }).catch(() => "TOKEN"),
        ]);
        if (!pool || typeof decimals !== "number" || decimals > 18 || decimals < 0) return;
        await input.db.prepare(
          `INSERT INTO v4_pool_directory (pool_id, currency0, currency1, fee, tick_spacing, hooks,
            token_address, token_symbol, token_decimals, sqrt_price_x96, tick, liquidity, lp_fee,
            block_number, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
           ON CONFLICT(pool_id) DO UPDATE SET sqrt_price_x96=excluded.sqrt_price_x96,
            tick=excluded.tick, liquidity=excluded.liquidity, lp_fee=excluded.lp_fee,
            block_number=excluded.block_number, updated_at=excluded.updated_at`,
        ).bind(id, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks, token,
          typeof symbol === "string" ? symbol.slice(0, 32) : "TOKEN", decimals,
          pool.sqrtPriceX96, pool.tick, pool.liquidity, pool.lpFee, Number(blockNumber), now()).run();
      } catch (error) {
        console.warn("V4 pool directory skipped pool", id, error);
        if (isRpcLimit(error)) readLimited = true;
      }
    }));
  }
  if (oldestScanned !== null && !readLimited) {
    const finalBlock = await input.client.getBlock({ blockNumber: oldestScanned });
    await input.db.prepare(
      `INSERT INTO chain_indexer_checkpoints (name, chain_id, block_number, block_hash, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(name) DO UPDATE SET block_number=excluded.block_number,
        block_hash=excluded.block_hash, updated_at=excluded.updated_at`,
    ).bind(CHECKPOINT, ARC_CHAIN_ID, Number(oldestScanned), finalBlock.hash ?? "0x", now()).run();
  }
  if (touched.scannedTo !== null && !readLimited) {
    const stateBlock = touched.scannedTo === safe.number
      ? safe : await input.client.getBlock({ blockNumber: touched.scannedTo });
    await input.db.prepare(
      `INSERT INTO chain_indexer_checkpoints (name, chain_id, block_number, block_hash, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(name) DO UPDATE SET block_number=excluded.block_number,
        block_hash=excluded.block_hash, updated_at=excluded.updated_at`,
    ).bind(STATE_CHECKPOINT, ARC_CHAIN_ID, Number(touched.scannedTo), stateBlock.hash ?? "0x", now()).run();
  }
}

// Returns the pool IDs touched since the state checkpoint, or null IDs (refresh everything)
// on the first run. scannedTo is the last fully scanned block, or null if nothing advanced.
async function scanTouchedPools(db: D1Database, client: Client, safeBlock: bigint) {
  const checkpoint = await db.prepare(
    "SELECT block_number FROM chain_indexer_checkpoints WHERE name = ?1",
  ).bind(STATE_CHECKPOINT).first<{ block_number: number }>();
  if (!checkpoint) return { ids: null, scannedTo: safeBlock };
  const ids = new Set<string>();
  let scannedTo: bigint | null = null;
  const first = BigInt(checkpoint.block_number) + 1n;
  const last = first + BLOCKS_PER_RUN - 1n < safeBlock ? first + BLOCKS_PER_RUN - 1n : safeBlock;
  for (let fromBlock = first; fromBlock <= last; fromBlock += LOG_CHUNK) {
    const toBlock = fromBlock + LOG_CHUNK - 1n < last ? fromBlock + LOG_CHUNK - 1n : last;
    try {
      const logs = await client.getLogs({ address: UNISWAP_V4_ARC.poolManager, events: stateEvents,
        fromBlock, toBlock });
      for (const log of logs) if (log.args.id) ids.add(log.args.id.toLowerCase());
      scannedTo = toBlock;
    } catch (error) {
      console.warn("V4 pool state scan will resume next run", error);
      break;
    }
  }
  return { ids, scannedTo };
}

function isRpcLimit(error: unknown) {
  const message = String(error).toLowerCase();
  return message.includes("rate limit") || message.includes("exceeds defined limit");
}
