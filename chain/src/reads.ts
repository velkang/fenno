import {
  formatUnits,
  getAddress,
  parseAbi,
  type Abi,
  type Address,
} from "viem";
import { ARC_TOKENS, UNISWAP_V3_ARC } from "./arc";
import { readToken, SUPPORTED_UNISWAP_FEES, TICK_SPACING_BY_FEE, type DiscoveredToken } from "./pool-discovery";

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
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const positionManagerAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
]);

type ContractCall = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
};

export type ChainReadClient = {
  getBalance(parameters: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  readContract(parameters: ContractCall): Promise<unknown>;
  simulateContract(
    parameters: ContractCall & { account: Address },
  ): Promise<{ result: unknown }>;
};

export type TokenAmount = {
  raw: string;
  formatted: string;
};

export type V3Position = {
  tokenId: string;
  /** The USDC pool the position is in. `token` is the other token, with the owner's balance. */
  pool: {
    address: Address;
    token: DiscoveredToken;
    token0: Address;
    token1: Address;
    fee: number;
    tickSpacing: number;
    sqrtPriceX96: string;
    tick: number;
  };
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  recordedOwed0: TokenAmount;
  recordedOwed1: TokenAmount;
  claimable0: TokenAmount;
  claimable1: TokenAmount;
};

/** The wallet's USDC and its v3 positions. Other tokens are listed by /v1/wallets/assets. */
export type WalletSummary = {
  owner: Address;
  balances: {
    nativeUsdc: TokenAmount;
    usdc: TokenAmount;
  };
  positions: V3Position[];
};

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_POSITION_ENUMERATION = 100n;

function tuple(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${name} response`);
  return value;
}

function bigint(value: unknown, name: string): bigint {
  if (typeof value !== "bigint") throw new Error(`Invalid ${name} response`);
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number") throw new Error(`Invalid ${name} response`);
  return value;
}

function address(value: unknown, name: string): Address {
  if (typeof value !== "string") throw new Error(`Invalid ${name} response`);
  return getAddress(value);
}

function amount(value: bigint, decimals: number): TokenAmount {
  return { raw: value.toString(), formatted: formatUnits(value, decimals) };
}

async function readTokenAmount(
  client: ChainReadClient,
  token: Address,
  owner: Address,
  decimals: number,
  blockNumber?: bigint,
): Promise<TokenAmount> {
  return amount(
    bigint(
      await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
        blockNumber,
      }),
      "token balance",
    ),
    decimals,
  );
}

export type V3PoolKey = { token0: Address; token1: Address; fee: number };

const poolKey = (token0: Address, token1: Address, fee: number) => `${token0}:${token1}:${fee}`;

/** The v3 pool for a pair and fee tier, from the factory. */
export async function readV3PoolAddress(
  client: Pick<ChainReadClient, "readContract">,
  key: V3PoolKey,
  blockNumber?: bigint,
): Promise<Address> {
  return address(await client.readContract({
    address: UNISWAP_V3_ARC.factory.address,
    abi: factoryAbi,
    functionName: "getPool",
    args: [key.token0, key.token1, key.fee],
    blockNumber,
  }), "factory pool");
}

/**
 * The v3 positions the owner holds in supported USDC pools. With `pools`, only positions
 * in those pools: anyone can send a position to a wallet, so callers showing a user their
 * own positions pass the pools that user opened.
 */
export async function readV3Positions(
  client: ChainReadClient,
  ownerInput: Address,
  options: { blockNumber?: bigint; pools?: readonly V3PoolKey[] } = {},
): Promise<V3Position[]> {
  if (options.pools?.length === 0) return [];
  const listed = options.pools && new Set(options.pools.map((pool) =>
    poolKey(getAddress(pool.token0), getAddress(pool.token1), pool.fee)));
  const owner = getAddress(ownerInput);
  const manager = UNISWAP_V3_ARC.nonfungiblePositionManager.address;
  const positionCount = bigint(
    await client.readContract({
      address: manager,
      abi: positionManagerAbi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber: options.blockNumber,
    }),
    "position count",
  );
  if (positionCount > MAX_POSITION_ENUMERATION) {
    throw new Error("Position enumeration limit exceeded");
  }

  // Each phase issues its calls concurrently so the transport can batch them
  // into a few HTTP requests instead of one per position.
  const indexes = Array.from({ length: Number(positionCount) }, (_, index) => BigInt(index));
  const tokenIds = await Promise.all(indexes.map(async (index) => bigint(
    await client.readContract({
      address: manager,
      abi: positionManagerAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, index],
      blockNumber: options.blockNumber,
    }),
    "position token ID",
  )));
  const allPositions = await Promise.all(tokenIds.map(async (tokenId) => ({
    tokenId,
    position: tuple(
      await client.readContract({
        address: manager,
        abi: positionManagerAbi,
        functionName: "positions",
        args: [tokenId],
        blockNumber: options.blockNumber,
      }),
      "position",
    ),
  })));
  const usdc = ARC_TOKENS.USDC;
  // Several positions often share a pool, so each pool is read once.
  const pools = new Map<string, Promise<V3Position["pool"]>>();
  const readPool = (token0: Address, token1: Address, fee: number) => {
    const key = poolKey(token0, token1, fee);
    const known = pools.get(key);
    if (known) return known;
    const pool = (async () => {
      const [token, poolAddress] = await Promise.all([
        readToken(client, token0 === usdc.address ? token1 : token0, owner, options.blockNumber),
        readV3PoolAddress(client, { token0, token1, fee }, options.blockNumber),
      ]);
      const slot0 = tuple(
        await client.readContract({
          address: poolAddress,
          abi: poolAbi,
          functionName: "slot0",
          blockNumber: options.blockNumber,
        }),
        "pool slot0",
      );
      return {
        address: poolAddress,
        token,
        token0,
        token1,
        fee,
        tickSpacing: TICK_SPACING_BY_FEE[fee]!,
        sqrtPriceX96: bigint(slot0[0], "pool sqrt price").toString(),
        tick: number(slot0[1], "pool tick"),
      };
    })();
    pools.set(key, pool);
    return pool;
  };

  const positions = await Promise.all(allPositions.map(async ({ tokenId, position }): Promise<V3Position | null> => {
    const token0 = address(position[2], "position token0");
    const token1 = address(position[3], "position token1");
    const fee = number(position[4], "position fee");
    if (
      (token0 !== usdc.address && token1 !== usdc.address) ||
      !(SUPPORTED_UNISWAP_FEES as readonly number[]).includes(fee) ||
      (listed && !listed.has(poolKey(token0, token1, fee)))
    ) return null;
    let pool;
    try {
      pool = await readPool(token0, token1, fee);
    } catch {
      return null; // A token that cannot be read is left out; the other positions still show.
    }
    const decimals0 = token0 === usdc.address ? usdc.decimals : pool.token.decimals;
    const decimals1 = token1 === usdc.address ? usdc.decimals : pool.token.decimals;
    // These fees are shown, not acted on. A token that refuses the transfer must not take
    // the wallet summary down with it, so fall back to the fees recorded on the position.
    const claimable = await client.simulateContract({
      account: owner,
      address: manager,
      abi: positionManagerAbi,
      functionName: "collect",
      args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
      blockNumber: options.blockNumber,
    }).then(
      (simulation) => tuple(simulation.result, "collect simulation"),
      () => [position[10], position[11]],
    );

    return {
      tokenId: tokenId.toString(),
      pool,
      tickLower: number(position[5], "position lower tick"),
      tickUpper: number(position[6], "position upper tick"),
      liquidity: bigint(position[7], "position liquidity").toString(),
      recordedOwed0: amount(bigint(position[10], "position recorded token0 fees"), decimals0),
      recordedOwed1: amount(bigint(position[11], "position recorded token1 fees"), decimals1),
      claimable0: amount(bigint(claimable[0], "claimable token0 fees"), decimals0),
      claimable1: amount(bigint(claimable[1], "claimable token1 fees"), decimals1),
    };
  }));
  return positions.filter((position): position is V3Position => position !== null);
}

export async function readWalletSummary(
  client: ChainReadClient,
  ownerInput: Address,
  options: { blockNumber?: bigint; pools?: readonly V3PoolKey[] } = {},
): Promise<WalletSummary> {
  const owner = getAddress(ownerInput);
  const [nativeBalance, usdc, positions] = await Promise.all([
    client.getBalance({ address: owner, blockNumber: options.blockNumber }),
    readTokenAmount(client, ARC_TOKENS.USDC.address, owner, ARC_TOKENS.USDC.decimals, options.blockNumber),
    readV3Positions(client, owner, options),
  ]);
  return {
    owner,
    balances: { nativeUsdc: amount(nativeBalance, 18), usdc },
    positions,
  };
}
