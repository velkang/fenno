import { ALPHA_POOL, ARC_TOKENS, SUPPORTED_UNISWAP_FEES, UNISWAP_V3_ARC } from "@stillwater/chain";
import { decodeEventLog, getAddress, pad, parseAbi, toEventSelector, toFunctionSelector, zeroAddress,
  type Address, type Hex } from "viem";
import { encodeAddressArg, rawCall, word, wordAddress, type RawRpcClient, type RpcLog } from "./directory-scan";
import { readMetadata, type CreatedPool, type DirectoryClient, type DirectoryRow,
  type ProtocolDirectory } from "./pool-discovery";

// Uniswap v3: the factory's PoolCreated event is the canonical record of every
// pool, so a pool it announces needs no further factory check.
const poolCreatedEvent = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
])[0];
const POOL_CREATED = toEventSelector(poolCreatedEvent);
const SLOT0 = toFunctionSelector("slot0()");
const LIQUIDITY = toFunctionSelector("liquidity()");
const TICK_SPACING = toFunctionSelector("tickSpacing()");
const BALANCE_OF = toFunctionSelector("balanceOf(address)");
const GET_POOL = toFunctionSelector("getPool(address,address,uint24)");
const USDC = ARC_TOKENS.USDC.address;
const FACTORY = UNISWAP_V3_ARC.factory.address;
const topic = (address: Address) => pad(address.toLowerCase() as Hex);

type V3Pool = { pool: Address; token0: Address; token1: Address; fee: number; tickSpacing: number | null };

async function readState(client: RawRpcClient, pool: Address, block: bigint) {
  const [slot0, liquidity, balance] = await Promise.all([
    rawCall(client, pool, SLOT0, block),
    rawCall(client, pool, LIQUIDITY, block),
    rawCall(client, USDC, `${BALANCE_OF}${encodeAddressArg(pool)}` as Hex, block),
  ]);
  const sqrtPrice = slot0 && word(slot0, 0);
  const tick = slot0 && word(slot0, 1);
  const liquidityValue = liquidity && word(liquidity, 0);
  const reserve = balance && word(balance, 0);
  if (sqrtPrice === null || tick === null || liquidityValue === null || reserve === null) return null;
  return { sqrt_price_x96: sqrtPrice.toString(), tick: Number(BigInt.asIntN(24, tick)),
    liquidity: liquidityValue.toString(), usdc_reserve: reserve.toString() };
}

function created(pool: V3Pool, createdBlock: bigint | null): CreatedPool | null {
  const token = pool.token0 === USDC ? pool.token1 : pool.token1 === USDC ? pool.token0 : null;
  if (!token || token === USDC || !(SUPPORTED_UNISWAP_FEES as readonly number[]).includes(pool.fee)) return null;
  const key = pool.pool.toLowerCase();
  return { key, block: createdBlock ?? 0n, token,
    build: (client, block, updatedAt) => buildRow(client, pool, token, createdBlock, block, updatedAt) };
}

function decode(log: RpcLog): CreatedPool | null {
  if (log.topics[0] !== POOL_CREATED || log.address.toLowerCase() !== FACTORY.toLowerCase()) return null;
  try {
    const { args } = decodeEventLog({ abi: [poolCreatedEvent], data: log.data,
      topics: log.topics as [Hex, ...Hex[]] });
    return created({ pool: getAddress(args.pool), token0: getAddress(args.token0), token1: getAddress(args.token1),
      fee: args.fee, tickSpacing: args.tickSpacing }, BigInt(log.blockNumber));
  } catch {
    return null;
  }
}

async function buildRow(client: DirectoryClient, pool: V3Pool, token: Address, createdBlock: bigint | null,
  block: bigint, updatedAt: number): Promise<DirectoryRow | null> {
  const [state, metadata, spacing] = await Promise.all([
    readState(client, pool.pool, block),
    readMetadata(client, token, block),
    pool.tickSpacing === null ? rawCall(client, pool.pool, TICK_SPACING, block) : Promise.resolve(null),
  ]);
  const spacingWord = spacing && word(spacing, 0);
  const tickSpacing = pool.tickSpacing ?? (spacingWord === null ? null : Number(BigInt.asIntN(24, spacingWord)));
  if (!state || !metadata || tickSpacing === null) return null;
  return { pool_address: pool.pool, token_address: token, token_symbol: metadata.symbol,
    token_decimals: metadata.decimals, token0_address: pool.token0, token1_address: pool.token1,
    fee: pool.fee, tick_spacing: tickSpacing, ...state, block_number: Number(block), updated_at: updatedAt,
    created_block: createdBlock === null ? null : Number(createdBlock) };
}

/** The factory's canonical USDC pools of a token, at any age. */
async function lookupToken(client: DirectoryClient, token: Address, block: bigint): Promise<CreatedPool[]> {
  const [token0, token1] = token.toLowerCase() < USDC.toLowerCase() ? [token, USDC] : [USDC, token];
  const found = await Promise.all(SUPPORTED_UNISWAP_FEES.map(async (fee) => {
    const result = await rawCall(client, FACTORY,
      `${GET_POOL}${encodeAddressArg(token0)}${encodeAddressArg(token1)}${fee.toString(16).padStart(64, "0")}` as Hex, block);
    const pool = result && wordAddress(result, 0);
    return pool && pool !== zeroAddress
      ? created({ pool: getAddress(pool), token0, token1, fee, tickSpacing: null }, null) : null;
  }));
  return found.filter((pool): pool is CreatedPool => pool !== null);
}

export const v3Directory: ProtocolDirectory = {
  name: "v3",
  protocol: "uniswap-v3",
  table: "pool_directory",
  keyColumn: "pool_address",
  columns: ["pool_address", "token_address", "token_symbol", "token_decimals", "token0_address",
    "token1_address", "fee", "tick_spacing", "sqrt_price_x96", "tick", "liquidity", "usdc_reserve",
    "block_number", "updated_at", "created_block"],
  stateColumns: ["sqrt_price_x96", "tick", "liquidity", "usdc_reserve", "block_number", "updated_at"],
  usedBy: [{ table: "mint_intents", column: "pool_address" }, { table: "approval_intents", column: "pool_address" },
    { table: "swap_intents", column: "pool_address" }],
  // The cirBTC pool's older intents carry no pool address, so it is kept by name.
  pinned: [ALPHA_POOL.address],
  emitter: FACTORY,
  creationTopics: (token) => token
    ? [[POOL_CREATED, topic(token), topic(USDC)], [POOL_CREATED, topic(USDC), topic(token)]]
    : [[POOL_CREATED, topic(USDC)], [POOL_CREATED, null, topic(USDC)]],
  decode,
  lookupToken,
  readState: (client, row, block) => readState(client, getAddress(row.pool_address as string), block),
};
