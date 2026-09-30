import { ARC_TOKENS, UNISWAP_V4_ARC, v4PoolId, type ArcV4PoolKey } from "@stillwater/chain";
import { decodeEventLog, getAddress, pad, parseAbi, toEventSelector, toFunctionSelector, zeroAddress,
  type Address, type Hex } from "viem";
import { rawCall, word, type RawRpcClient, type RpcLog } from "./directory-scan";
import { readMetadata, type CreatedPool, type DirectoryClient, type DirectoryRow,
  type ProtocolDirectory } from "./pool-discovery";

// Uniswap v4: every pool is created by one Initialize event on the PoolManager,
// which carries the full pool key. Only USDC pairs (native or ERC-20) are listed.
const initializeEvent = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
])[0];
const INITIALIZE = toEventSelector(initializeEvent);
const GET_SLOT0 = toFunctionSelector("getSlot0(bytes32)");
const GET_LIQUIDITY = toFunctionSelector("getLiquidity(bytes32)");
const USDC = ARC_TOKENS.USDC.address;
const USDC_CURRENCIES: Address[] = [zeroAddress, USDC];
const topic = (address: Address) => pad(address.toLowerCase() as Hex);

type PoolState = { sqrt_price_x96: string; tick: number; liquidity: string; lp_fee: number };

async function readState(client: RawRpcClient, id: Hex, block: bigint): Promise<PoolState | null> {
  const [slot0, liquidity] = await Promise.all([
    rawCall(client, UNISWAP_V4_ARC.stateView, `${GET_SLOT0}${id.slice(2)}` as Hex, block),
    rawCall(client, UNISWAP_V4_ARC.stateView, `${GET_LIQUIDITY}${id.slice(2)}` as Hex, block),
  ]);
  const sqrtPrice = slot0 && word(slot0, 0);
  const tick = slot0 && word(slot0, 1);
  const lpFee = slot0 && word(slot0, 3);
  const liquidityValue = liquidity && word(liquidity, 0);
  if (sqrtPrice === null || tick === null || lpFee === null || liquidityValue === null) return null;
  return { sqrt_price_x96: sqrtPrice.toString(), tick: Number(BigInt.asIntN(24, tick)),
    liquidity: liquidityValue.toString(), lp_fee: Number(lpFee) };
}

/** The key only if it hashes to the pool id. */
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

function decode(log: RpcLog): CreatedPool | null {
  if (log.topics[0] !== INITIALIZE || log.address.toLowerCase() !== UNISWAP_V4_ARC.poolManager.toLowerCase()) {
    return null;
  }
  try {
    const { args } = decodeEventLog({ abi: [initializeEvent], data: log.data,
      topics: log.topics as [Hex, ...Hex[]] });
    const key = verifiedKey(args.id, { currency0: args.currency0, currency1: args.currency1,
      fee: args.fee, tickSpacing: args.tickSpacing, hooks: args.hooks });
    const token = key && pairedToken(key);
    if (!key || !token) return null;
    const id = args.id.toLowerCase() as Hex;
    return { key: id, block: BigInt(log.blockNumber), token,
      build: (client, block, updatedAt) => buildRow(client, id, key, token, BigInt(log.blockNumber), block, updatedAt) };
  } catch {
    return null;
  }
}

async function buildRow(client: DirectoryClient, id: Hex, key: ArcV4PoolKey, token: Address,
  createdBlock: bigint, block: bigint, updatedAt: number): Promise<DirectoryRow | null> {
  const [state, metadata] = await Promise.all([readState(client, id, block), readMetadata(client, token, block)]);
  if (!state || !metadata) return null;
  return { pool_id: id, currency0: key.currency0, currency1: key.currency1, fee: key.fee,
    tick_spacing: key.tickSpacing, hooks: key.hooks, token_address: token,
    token_symbol: metadata.symbol, token_decimals: metadata.decimals, ...state,
    block_number: Number(block), updated_at: updatedAt, created_block: Number(createdBlock) };
}

export const v4Directory: ProtocolDirectory = {
  name: "v4",
  protocol: "uniswap-v4",
  table: "v4_pool_directory",
  keyColumn: "pool_id",
  columns: ["pool_id", "currency0", "currency1", "fee", "tick_spacing", "hooks", "token_address",
    "token_symbol", "token_decimals", "sqrt_price_x96", "tick", "liquidity", "lp_fee", "block_number",
    "updated_at", "created_block"],
  stateColumns: ["sqrt_price_x96", "tick", "liquidity", "lp_fee", "block_number", "updated_at"],
  emitter: UNISWAP_V4_ARC.poolManager,
  // USDC sorts first as native (0x0) and usually as the ERC-20, so both positions are filtered.
  creationTopics: (token) => token
    ? [[INITIALIZE, null, [topic(zeroAddress), topic(USDC)], topic(token)], [INITIALIZE, null, topic(token), topic(USDC)]]
    : [[INITIALIZE, null, [topic(zeroAddress), topic(USDC)]], [INITIALIZE, null, null, topic(USDC)]],
  decode,
  readState: (client, row, block) => readState(client, row.pool_id as Hex, block),
};
