import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { ARC_TOKENS, UNISWAP_V3_ARC } from "./arc";
import type { ChainReadClient } from "./reads";

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const SUPPORTED_UNISWAP_FEES = [100, 500, 3_000, 10_000] as const;
const TICK_SPACING_BY_FEE: Record<number, number> = {
  100: 1,
  500: 10,
  3_000: 60,
  10_000: 200,
};

export type DiscoveredToken = {
  address: Address;
  symbol: string;
  decimals: number;
  balance?: string;
  allowance?: string;
};

export type DiscoveredPool = {
  address: Address;
  token0: DiscoveredToken;
  token1: DiscoveredToken;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
};

export type PoolDiscoveryClient = ChainReadClient & {
  getCode(parameters: { address: Address; blockNumber?: bigint }): Promise<`0x${string}` | undefined>;
};

const isContract = (code: `0x${string}` | undefined) =>
  code !== undefined && code !== "0x";

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") throw new Error(`Invalid ${label}`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`Invalid ${label}`);
  return value;
}

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return getAddress(value);
}

function asTuple(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

async function readToken(
  client: ChainReadClient,
  address: Address,
  owner?: Address,
  blockNumber?: bigint,
): Promise<DiscoveredToken> {
  const [decimalsValue, symbolValue, balanceValue, allowanceValue] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber }).catch(() => "TOKEN"),
    owner === undefined
      ? Promise.resolve(undefined)
      : client.readContract({
          address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
          blockNumber,
        }),
    owner === undefined
      ? Promise.resolve(undefined)
      : client.readContract({
          address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [owner, UNISWAP_V3_ARC.nonfungiblePositionManager.address],
          blockNumber,
        }),
  ]);
  const decimals = asNumber(decimalsValue, "token decimals");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Token decimals are outside the supported range");
  }
  const symbol = typeof symbolValue === "string" && symbolValue.length > 0
    ? symbolValue.slice(0, 32)
    : "TOKEN";
  return {
    address,
    symbol,
    decimals,
    ...(balanceValue === undefined ? {} : { balance: asBigInt(balanceValue, "token balance").toString() }),
    ...(allowanceValue === undefined ? {} : { allowance: asBigInt(allowanceValue, "token allowance").toString() }),
  };
}

async function readPool(
  client: PoolDiscoveryClient,
  poolAddress: Address,
  token: DiscoveredToken,
  usdc: DiscoveredToken,
  fee: number,
  blockNumber?: bigint,
): Promise<DiscoveredPool | null> {
  if (!isContract(await client.getCode({ address: poolAddress, blockNumber }))) return null;
  const call = (functionName: string) => client.readContract({
    address: poolAddress,
    abi: poolAbi,
    functionName,
    blockNumber,
  });
  const [slot0Value, liquidityValue, token0Value, token1Value, feeValue, spacingValue] =
    await Promise.all([call("slot0"), call("liquidity"), call("token0"), call("token1"), call("fee"), call("tickSpacing")]);
  const slot0 = asTuple(slot0Value, "pool slot0");
  const token0 = asAddress(token0Value, "pool token0");
  const token1 = asAddress(token1Value, "pool token1");
  if (!((token0 === token.address && token1 === usdc.address) ||
    (token0 === usdc.address && token1 === token.address))) return null;
  const actualFee = asNumber(feeValue, "pool fee");
  if (actualFee !== fee) return null;
  const tickSpacing = asNumber(spacingValue, "pool tick spacing");
  if (tickSpacing !== TICK_SPACING_BY_FEE[fee]) return null;
  const sqrtPriceX96 = asBigInt(slot0[0], "pool sqrt price");
  if (sqrtPriceX96 === 0n) return null;
  return {
    address: poolAddress,
    token0: token0 === token.address ? token : usdc,
    token1: token1 === token.address ? token : usdc,
    fee: actualFee,
    tickSpacing,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: asNumber(slot0[1], "pool tick"),
    liquidity: asBigInt(liquidityValue, "pool liquidity").toString(),
  };
}

export async function discoverArcTokenPools(input: {
  client: PoolDiscoveryClient;
  tokenAddress: Address;
  owner?: Address;
  blockNumber?: bigint;
}): Promise<{ token: DiscoveredToken; usdc: DiscoveredToken; pools: DiscoveredPool[] }> {
  const tokenAddress = getAddress(input.tokenAddress);
  if (tokenAddress === ARC_TOKENS.USDC.address) throw new Error("USDC cannot be used as the supplied token");
  if (!isContract(await input.client.getCode({ address: tokenAddress, blockNumber: input.blockNumber }))) {
    throw new Error("Token address has no contract bytecode");
  }
  const [token, usdc] = await Promise.all([
    readToken(input.client, tokenAddress, input.owner, input.blockNumber),
    readToken(input.client, ARC_TOKENS.USDC.address, input.owner, input.blockNumber),
  ]);
  if (!isContract(await input.client.getCode({ address: UNISWAP_V3_ARC.factory.address, blockNumber: input.blockNumber }))) {
    throw new Error("Uniswap factory is unavailable");
  }
  const pools = (await Promise.all(SUPPORTED_UNISWAP_FEES.map(async (fee) => {
    const value = await input.client.readContract({
      address: UNISWAP_V3_ARC.factory.address,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token.address, usdc.address, fee],
      blockNumber: input.blockNumber,
    });
    const poolAddress = asAddress(value, "factory pool");
    if (poolAddress === zeroAddress) return null;
    try {
      return await readPool(input.client, poolAddress, token, usdc, fee, input.blockNumber);
    } catch {
      return null;
    }
  }))).filter((pool): pool is DiscoveredPool => pool !== null);
  return { token, usdc, pools };
}

export async function verifyArcSelectedPool(input: {
  client: PoolDiscoveryClient;
  token: DiscoveredToken;
  pool: Pick<DiscoveredPool, "address" | "fee" | "tickSpacing" | "token0" | "token1">;
  blockNumber?: bigint;
}): Promise<DiscoveredPool> {
  const discovered = await discoverArcTokenPools({
    client: input.client,
    tokenAddress: input.token.address,
    blockNumber: input.blockNumber,
  });
  const selected = discovered.pools.find((pool) => pool.address === getAddress(input.pool.address));
  if (!selected || selected.fee !== input.pool.fee || selected.tickSpacing !== input.pool.tickSpacing ||
    selected.token0.address !== input.pool.token0.address || selected.token1.address !== input.pool.token1.address) {
    throw new Error("Selected pool is not canonical or initialized");
  }
  return selected;
}

export async function verifyArcPoolAddress(input: {
  client: PoolDiscoveryClient;
  tokenAddress: Address;
  poolAddress: Address;
  blockNumber?: bigint;
}): Promise<DiscoveredPool> {
  const discovered = await discoverArcTokenPools({
    client: input.client,
    tokenAddress: input.tokenAddress,
    blockNumber: input.blockNumber,
  });
  const selected = discovered.pools.find((pool) => pool.address === getAddress(input.poolAddress));
  if (!selected) throw new Error("Selected pool is not canonical or initialized");
  return selected;
}
