import {
  formatUnits,
  getAddress,
  parseAbi,
  type Abi,
  type Address,
} from "viem";
import {
  ALPHA_POOL,
  ARC_TOKENS,
  UNISWAP_SHARED_ARC,
  UNISWAP_V3_ARC,
} from "./arc";

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

export type AlphaPoolState = {
  address: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  token1PerToken0: string;
  token0PerToken1: string;
};

export type TokenAmount = {
  raw: string;
  formatted: string;
};

export type AlphaPosition = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  recordedOwed0: TokenAmount;
  recordedOwed1: TokenAmount;
  claimable0: TokenAmount;
  claimable1: TokenAmount;
};

export type AlphaWalletSummary = {
  owner: Address;
  pool: AlphaPoolState;
  balances: {
    nativeUsdc: TokenAmount;
    usdc: TokenAmount;
    cirBtc: TokenAmount;
  };
  allowances: {
    positionManager: { usdc: TokenAmount; cirBtc: TokenAmount };
    permit2: { usdc: TokenAmount; cirBtc: TokenAmount };
  };
  positions: AlphaPosition[];
};

const MAX_UINT128 = (1n << 128n) - 1n;
const Q192 = 1n << 192n;
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

function decimalRatio(
  numerator: bigint,
  denominator: bigint,
  precision = 18,
): string {
  if (denominator === 0n) throw new Error("Cannot format a zero denominator");
  const integer = numerator / denominator;
  const fraction = ((numerator % denominator) * 10n ** BigInt(precision)) /
    denominator;
  const trimmed = fraction.toString().padStart(precision, "0").replace(/0+$/, "");
  return trimmed ? `${integer}.${trimmed}` : integer.toString();
}

export async function readAlphaPoolState(
  client: ChainReadClient,
  options: { blockNumber?: bigint } = {},
): Promise<AlphaPoolState> {
  const call = (functionName: string) =>
    client.readContract({
      address: ALPHA_POOL.address,
      abi: poolAbi,
      functionName,
      blockNumber: options.blockNumber,
    });
  const [slot0Value, liquidityValue, token0Value, token1Value, feeValue, spacingValue] =
    await Promise.all([
      call("slot0"),
      call("liquidity"),
      call("token0"),
      call("token1"),
      call("fee"),
      call("tickSpacing"),
    ]);

  const slot0 = tuple(slot0Value, "pool slot0");
  const sqrtPriceX96 = bigint(slot0[0], "pool sqrt price");
  const tick = number(slot0[1], "pool tick");
  const token0 = address(token0Value, "pool token0");
  const token1 = address(token1Value, "pool token1");
  const fee = number(feeValue, "pool fee");
  const tickSpacing = number(spacingValue, "pool tick spacing");

  if (
    token0 !== ALPHA_POOL.token0.address ||
    token1 !== ALPHA_POOL.token1.address ||
    fee !== ALPHA_POOL.fee ||
    tickSpacing !== ALPHA_POOL.tickSpacing
  ) {
    throw new Error("Arc alpha pool configuration mismatch");
  }

  const squaredPrice = sqrtPriceX96 * sqrtPriceX96;
  const token1PerToken0Numerator =
    squaredPrice * 10n ** BigInt(ALPHA_POOL.token0.decimals);
  const token1PerToken0Denominator =
    Q192 * 10n ** BigInt(ALPHA_POOL.token1.decimals);

  return {
    address: ALPHA_POOL.address,
    token0,
    token1,
    fee,
    tickSpacing,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    liquidity: bigint(liquidityValue, "pool liquidity").toString(),
    token1PerToken0: decimalRatio(
      token1PerToken0Numerator,
      token1PerToken0Denominator,
    ),
    token0PerToken1: decimalRatio(
      token1PerToken0Denominator,
      token1PerToken0Numerator,
    ),
  };
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

async function readAllowance(
  client: ChainReadClient,
  token: Address,
  owner: Address,
  spender: Address,
  decimals: number,
  blockNumber?: bigint,
): Promise<TokenAmount> {
  return amount(
    bigint(
      await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, spender],
        blockNumber,
      }),
      "token allowance",
    ),
    decimals,
  );
}

export async function readAlphaPositions(
  client: ChainReadClient,
  ownerInput: Address,
  options: { blockNumber?: bigint } = {},
): Promise<AlphaPosition[]> {
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
  const alphaPositions = allPositions.filter(({ position }) =>
    address(position[2], "position token0") === ALPHA_POOL.token0.address &&
    address(position[3], "position token1") === ALPHA_POOL.token1.address &&
    number(position[4], "position fee") === ALPHA_POOL.fee);

  return Promise.all(alphaPositions.map(async ({ tokenId, position }): Promise<AlphaPosition> => {
    const simulation = await client.simulateContract({
      account: owner,
      address: manager,
      abi: positionManagerAbi,
      functionName: "collect",
      args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
      blockNumber: options.blockNumber,
    });
    const claimable = tuple(simulation.result, "collect simulation");

    return {
      tokenId: tokenId.toString(),
      tickLower: number(position[5], "position lower tick"),
      tickUpper: number(position[6], "position upper tick"),
      liquidity: bigint(position[7], "position liquidity").toString(),
      recordedOwed0: amount(
        bigint(position[10], "position recorded token0 fees"),
        ALPHA_POOL.token0.decimals,
      ),
      recordedOwed1: amount(
        bigint(position[11], "position recorded token1 fees"),
        ALPHA_POOL.token1.decimals,
      ),
      claimable0: amount(
        bigint(claimable[0], "claimable token0 fees"),
        ALPHA_POOL.token0.decimals,
      ),
      claimable1: amount(
        bigint(claimable[1], "claimable token1 fees"),
        ALPHA_POOL.token1.decimals,
      ),
    };
  }));
}

export async function readAlphaWalletSummary(
  client: ChainReadClient,
  ownerInput: Address,
  options: { blockNumber?: bigint } = {},
): Promise<AlphaWalletSummary> {
  const owner = getAddress(ownerInput);
  const positionManager = UNISWAP_V3_ARC.nonfungiblePositionManager.address;
  const permit2 = UNISWAP_SHARED_ARC.permit2.address;
  const [
    pool,
    nativeBalance,
    usdc,
    cirBtc,
    managerUsdc,
    managerCirBtc,
    permit2Usdc,
    permit2CirBtc,
    positions,
  ] = await Promise.all([
    readAlphaPoolState(client, options),
    client.getBalance({ address: owner, blockNumber: options.blockNumber }),
    readTokenAmount(client, ARC_TOKENS.USDC.address, owner, ARC_TOKENS.USDC.decimals, options.blockNumber),
    readTokenAmount(client, ARC_TOKENS.cirBTC.address, owner, ARC_TOKENS.cirBTC.decimals, options.blockNumber),
    readAllowance(client, ARC_TOKENS.USDC.address, owner, positionManager, ARC_TOKENS.USDC.decimals, options.blockNumber),
    readAllowance(client, ARC_TOKENS.cirBTC.address, owner, positionManager, ARC_TOKENS.cirBTC.decimals, options.blockNumber),
    readAllowance(client, ARC_TOKENS.USDC.address, owner, permit2, ARC_TOKENS.USDC.decimals, options.blockNumber),
    readAllowance(client, ARC_TOKENS.cirBTC.address, owner, permit2, ARC_TOKENS.cirBTC.decimals, options.blockNumber),
    readAlphaPositions(client, owner, options),
  ]);

  return {
    owner,
    pool,
    balances: {
      nativeUsdc: amount(nativeBalance, 18),
      usdc,
      cirBtc,
    },
    allowances: {
      positionManager: { usdc: managerUsdc, cirBtc: managerCirBtc },
      permit2: { usdc: permit2Usdc, cirBtc: permit2CirBtc },
    },
    positions,
  };
}
