import { Pool, Position, V4PositionManager } from "@uniswap/v4-sdk";
import { NativeCurrency, Percent, Token, type Currency } from "@uniswap/sdk-core";
import {
  decodeEventLog, encodeFunctionData, getAddress, isAddressEqual, keccak256, encodeAbiParameters,
  maxUint256, parseAbi, zeroAddress,
  type Address, type Hex,
} from "viem";
import { ARC_CHAIN_ID, ARC_TOKENS, UNISWAP_SHARED_ARC, UNISWAP_V4_ARC } from "./arc";
import type { ChainReadClient } from "./reads";

export type ArcV4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type ArcV4Pool = ArcV4PoolKey & {
  id: Hex;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  lpFee: number;
};

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const approvalAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

export const v4PositionManagerReadAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);

// The position NFTs a transaction minted to the owner, read from its receipt logs.
export function v4MintedTokenIds(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  owner: Address,
): bigint[] {
  const ids: bigint[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, UNISWAP_V4_ARC.positionManager)) continue;
    try {
      const event = decodeEventLog({ abi: v4PositionManagerReadAbi, eventName: "Transfer",
        data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
      if (event.args.from === zeroAddress && isAddressEqual(event.args.to, owner)) ids.push(event.args.tokenId);
    } catch { /* PositionManager emits other events in the same receipt. */ }
  }
  return ids;
}

export async function readArcV4Position(input: {
  client: Pick<ChainReadClient, "readContract">;
  tokenId: bigint;
  owner: Address;
  blockNumber?: bigint;
}) {
  const address = UNISWAP_V4_ARC.positionManager;
  const [owner, info, liquidity] = await Promise.all([
    input.client.readContract({ address, abi: v4PositionManagerReadAbi,
      functionName: "ownerOf", args: [input.tokenId], blockNumber: input.blockNumber }),
    input.client.readContract({ address, abi: v4PositionManagerReadAbi,
      functionName: "getPoolAndPositionInfo", args: [input.tokenId], blockNumber: input.blockNumber }),
    input.client.readContract({ address, abi: v4PositionManagerReadAbi,
      functionName: "getPositionLiquidity", args: [input.tokenId], blockNumber: input.blockNumber }),
  ]);
  if (typeof owner !== "string" || !isAddressEqual(owner as Address, input.owner) ||
      !Array.isArray(info) || typeof info[1] !== "bigint" || typeof liquidity !== "bigint") {
    throw new Error("V4 position is not owned by wallet");
  }
  const key = info[0] as ArcV4PoolKey;
  const signedTick = (value: bigint) => value >= 1n << 23n ? Number(value - (1n << 24n)) : Number(value);
  const tickLower = signedTick((info[1] >> 8n) & 0xffffffn);
  const tickUpper = signedTick((info[1] >> 32n) & 0xffffffn);
  return { tokenId: input.tokenId, poolId: v4PoolId(key), poolKey: key,
    tickLower, tickUpper, liquidity };
}

export type ArcV4Approval = {
  chainId: typeof ARC_CHAIN_ID;
  poolId: Hex;
  token: Address;
  stage: "erc20" | "permit2";
  amount: bigint;
  expiration: bigint;
  spender: Address;
  to: Address;
  data: Hex;
  value: 0n;
};

export function buildArcV4Approval(input: {
  poolId: Hex; token: Address; stage: "erc20" | "permit2";
  amount: bigint; expiration?: bigint; spender?: Address;
}): ArcV4Approval {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.poolId) || input.amount <= 0n ||
      input.amount > (input.stage === "permit2" ? (1n << 160n) - 1n : maxUint256)) {
    throw new Error("Invalid v4 approval amount or pool");
  }
  const token = getAddress(input.token);
  if (token === zeroAddress) throw new Error("Native USDC needs no approval");
  const expiration = input.stage === "permit2" ? input.expiration ?? 0n : 0n;
  const spender = input.spender ?? UNISWAP_V4_ARC.positionManager;
  if (spender !== UNISWAP_V4_ARC.positionManager &&
      spender !== UNISWAP_SHARED_ARC.universalRouter.address) throw new Error("Invalid v4 spender");
  if (input.stage === "permit2" && (expiration <= 0n || expiration > (1n << 48n) - 1n)) {
    throw new Error("Invalid Permit2 expiration");
  }
  const to = input.stage === "erc20" ? token : UNISWAP_SHARED_ARC.permit2.address;
  const data = input.stage === "erc20"
    ? encodeFunctionData({ abi: approvalAbi, functionName: "approve",
      args: [UNISWAP_SHARED_ARC.permit2.address, input.amount] })
    : encodeFunctionData({ abi: permit2Abi, functionName: "approve",
      args: [token, spender, input.amount, Number(expiration)] });
  return { chainId: ARC_CHAIN_ID, poolId: input.poolId, token, stage: input.stage,
    amount: input.amount, expiration, spender, to, data, value: 0n };
}

export function arcV4ApprovalPayloadHash(approval: ArcV4Approval): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "address" },
      { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    [BigInt(approval.chainId), approval.poolId, approval.token,
      approval.spender, approval.stage === "erc20" ? 0 : 1, approval.amount, approval.expiration, approval.data],
  ));
}

export async function readArcV4Allowances(input: {
  client: Pick<ChainReadClient, "readContract">;
  owner: Address;
  token: Address;
  blockNumber?: bigint;
  spender?: Address;
}): Promise<{ erc20: bigint; permit2: bigint; expiration: bigint }> {
  const owner = getAddress(input.owner);
  const token = getAddress(input.token);
  const spender = input.spender ?? UNISWAP_V4_ARC.positionManager;
  const [erc20, permit2] = await Promise.all([
    input.client.readContract({ address: token, abi: approvalAbi,
      functionName: "allowance", args: [owner, UNISWAP_SHARED_ARC.permit2.address],
      blockNumber: input.blockNumber }),
    input.client.readContract({ address: UNISWAP_SHARED_ARC.permit2.address, abi: permit2Abi,
      functionName: "allowance", args: [owner, token, spender],
      blockNumber: input.blockNumber }),
  ]);
  if (typeof erc20 !== "bigint" || !Array.isArray(permit2) ||
      typeof permit2[0] !== "bigint" || typeof permit2[1] !== "number") {
    throw new Error("V4 allowance read failed");
  }
  return { erc20, permit2: permit2[0], expiration: BigInt(permit2[1]) };
}

class ArcNativeUsdc extends NativeCurrency {
  constructor() { super(ARC_CHAIN_ID, 18, "USDC", "Arc USDC"); }
  get wrapped() { return new Token(ARC_CHAIN_ID, ARC_TOKENS.USDC.address, 6, "USDC"); }
  equals(other: Currency) { return other.isNative && other.chainId === ARC_CHAIN_ID; }
}

const arcNativeUsdc = new ArcNativeUsdc();

function currency(address: Address, decimals: number): Currency {
  return address === zeroAddress ? arcNativeUsdc : new Token(ARC_CHAIN_ID, address, decimals);
}

export function v4PoolId(key: ArcV4PoolKey): Hex {
  const currency0 = getAddress(key.currency0);
  const currency1 = getAddress(key.currency1);
  if (currency0.toLowerCase() >= currency1.toLowerCase()) throw new Error("V4 currencies are not sorted");
  if (!Number.isInteger(key.fee) || key.fee < 0 ||
      (key.fee >= 1_000_000 && key.fee !== 0x800000) ||
      !Number.isInteger(key.tickSpacing) || key.tickSpacing <= 0 || key.tickSpacing > 32767) {
    throw new Error("Invalid v4 pool fee or tick spacing");
  }
  const hooks = getAddress(key.hooks);
  if (key.fee === 0x800000 && hooks === zeroAddress) throw new Error("Dynamic fee requires a hook");
  // The SDK owns PoolKey hashing; use the Arc native currency for the zero-address side.
  return Pool.getPoolId(
    currency(currency0, currency0 === ARC_TOKENS.USDC.address ? 6 : 18),
    currency(currency1, currency1 === ARC_TOKENS.USDC.address ? 6 : 18),
    key.fee, key.tickSpacing, hooks,
  ) as Hex;
}

export type ArcV4Mint = {
  chainId: typeof ARC_CHAIN_ID;
  to: Address;
  data: Hex;
  value: bigint;
  poolId: Hex;
  recipient: Address;
  tickLower: number;
  tickUpper: number;
  amount0Max: bigint;
  amount1Max: bigint;
  deadline: bigint;
};

export function buildArcV4Mint(input: {
  pool: ArcV4Pool;
  tokenDecimals: number;
  recipient: Address;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  slippageBps: number;
  deadline: bigint;
}): ArcV4Mint {
  const { pool } = input;
  if (v4PoolId(pool) !== pool.id || BigInt(pool.liquidity) <= 0n) throw new Error("V4 pool is invalid");
  if (!Number.isInteger(input.tokenDecimals) || input.tokenDecimals < 0 || input.tokenDecimals > 18 ||
      !Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 500 ||
      !Number.isInteger(input.tickLower) || !Number.isInteger(input.tickUpper) ||
      input.tickLower >= input.tickUpper || input.tickLower % pool.tickSpacing !== 0 ||
      input.tickUpper % pool.tickSpacing !== 0 ||
      input.amount0Desired <= 0n || input.amount1Desired <= 0n || input.deadline <= 0n) {
    throw new Error("Invalid v4 mint limits");
  }
  const decimals0 = pool.currency0 === zeroAddress ? 18 : pool.currency0 === ARC_TOKENS.USDC.address ? 6 : input.tokenDecimals;
  const decimals1 = pool.currency1 === ARC_TOKENS.USDC.address ? 6 : input.tokenDecimals;
  const sdkPool = new Pool(
    currency(pool.currency0, decimals0), currency(pool.currency1, decimals1), pool.fee,
    pool.tickSpacing, pool.hooks, pool.sqrtPriceX96, pool.liquidity, pool.tick,
  );
  const position = Position.fromAmounts({ pool: sdkPool, tickLower: input.tickLower,
    tickUpper: input.tickUpper, amount0: input.amount0Desired.toString(),
    amount1: input.amount1Desired.toString(), useFullPrecision: true });
  const slippageTolerance = new Percent(input.slippageBps, 10_000);
  const amounts = position.mintAmountsWithSlippage(slippageTolerance);
  const recipient = getAddress(input.recipient);
  const encoded = V4PositionManager.addCallParameters(position, {
    recipient, slippageTolerance, deadline: input.deadline.toString(),
    hookData: "0x", ...(pool.currency0 === zeroAddress ? { useNative: arcNativeUsdc } : {}),
  });
  return { chainId: ARC_CHAIN_ID, to: UNISWAP_V4_ARC.positionManager,
    data: encoded.calldata as Hex, value: BigInt(encoded.value), poolId: pool.id,
    recipient, tickLower: input.tickLower, tickUpper: input.tickUpper,
    amount0Max: BigInt(amounts.amount0.toString()), amount1Max: BigInt(amounts.amount1.toString()),
    deadline: input.deadline };
}

export function arcV4MintPayloadHash(mint: ArcV4Mint): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "bytes32" },
      { type: "address" }, { type: "uint256" }, { type: "bytes" }],
    [BigInt(mint.chainId), mint.to, mint.poolId, mint.recipient, mint.value, mint.data],
  ));
}

export type ArcV4PositionAction = {
  chainId: typeof ARC_CHAIN_ID;
  kind: "collect" | "withdraw";
  poolId: Hex;
  tokenId: bigint;
  recipient: Address;
  liquidity: bigint;
  deadline: bigint;
  slippageBps: number;
  to: Address;
  data: Hex;
  value: 0n;
};

export function buildArcV4PositionAction(input: {
  kind: "collect" | "withdraw";
  pool: ArcV4Pool;
  tokenDecimals: number;
  tokenId: bigint;
  recipient: Address;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  slippageBps: number;
  deadline: bigint;
}): ArcV4PositionAction {
  const { pool } = input;
  if (v4PoolId(pool) !== pool.id || input.tokenId < 0n || input.liquidity <= 0n ||
      !Number.isInteger(input.tokenDecimals) || input.tokenDecimals < 0 || input.tokenDecimals > 18 ||
      !Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 500 ||
      input.tickLower >= input.tickUpper || input.tickLower % pool.tickSpacing !== 0 ||
      input.tickUpper % pool.tickSpacing !== 0 || input.deadline <= 0n) {
    throw new Error("Invalid v4 position action");
  }
  const decimals0 = pool.currency0 === zeroAddress ? 18 : pool.currency0 === ARC_TOKENS.USDC.address ? 6 : input.tokenDecimals;
  const decimals1 = pool.currency1 === ARC_TOKENS.USDC.address ? 6 : input.tokenDecimals;
  const sdkPool = new Pool(currency(pool.currency0, decimals0), currency(pool.currency1, decimals1),
    pool.fee, pool.tickSpacing, pool.hooks, pool.sqrtPriceX96, pool.liquidity, pool.tick);
  const position = new Position({ pool: sdkPool, liquidity: input.liquidity.toString(),
    tickLower: input.tickLower, tickUpper: input.tickUpper });
  const recipient = getAddress(input.recipient);
  const common = { tokenId: input.tokenId.toString(), deadline: input.deadline.toString(),
    slippageTolerance: new Percent(input.slippageBps, 10_000), hookData: "0x" };
  const encoded = input.kind === "collect"
    ? V4PositionManager.collectCallParameters(position, { ...common, recipient })
    : V4PositionManager.removeCallParameters(position, { ...common,
      liquidityPercentage: new Percent(1, 1), burnToken: true });
  return { chainId: ARC_CHAIN_ID, kind: input.kind, poolId: pool.id,
    tokenId: input.tokenId, recipient, liquidity: input.liquidity,
    deadline: input.deadline, slippageBps: input.slippageBps,
    to: UNISWAP_V4_ARC.positionManager, data: encoded.calldata as Hex, value: 0n };
}

export function arcV4PositionActionPayloadHash(action: ArcV4PositionAction): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint256" },
      { type: "address" }, { type: "uint256" }, { type: "bytes" }],
    [BigInt(action.chainId), action.kind === "collect" ? 0 : 1, action.poolId,
      action.tokenId, action.recipient, action.liquidity, action.data],
  ));
}

export async function readArcV4Pool(input: {
  client: Pick<ChainReadClient, "readContract">;
  key: ArcV4PoolKey;
  blockNumber?: bigint;
}): Promise<ArcV4Pool | null> {
  const id = v4PoolId(input.key);
  const [slot, liquidity] = await Promise.all([
    input.client.readContract({ address: UNISWAP_V4_ARC.stateView, abi: stateViewAbi,
      functionName: "getSlot0", args: [id], blockNumber: input.blockNumber }),
    input.client.readContract({ address: UNISWAP_V4_ARC.stateView, abi: stateViewAbi,
      functionName: "getLiquidity", args: [id], blockNumber: input.blockNumber }),
  ]);
  if (!Array.isArray(slot) || typeof slot[0] !== "bigint" || slot[0] === 0n ||
      typeof slot[1] !== "number" || typeof slot[3] !== "number" || typeof liquidity !== "bigint") return null;
  const hasUsdc = [zeroAddress, ARC_TOKENS.USDC.address].some((address) =>
    isAddressEqual(input.key.currency0, address) || isAddressEqual(input.key.currency1, address));
  if (!hasUsdc) return null;
  return { ...input.key, id, sqrtPriceX96: slot[0].toString(), tick: slot[1],
    lpFee: slot[3], liquidity: liquidity.toString() };
}

const Q128 = 1n << 128n;
const U256 = 1n << 256n;

/**
 * Fees a PositionManager position has earned but not collected, in each
 * currency's smallest unit: liquidity × fee growth inside the range since the
 * position last settled. Growth counters wrap, so the difference is taken mod 2²⁵⁶.
 */
export async function readArcV4PositionFees(input: {
  client: Pick<ChainReadClient, "readContract">;
  poolId: Hex;
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  blockNumber?: bigint;
}): Promise<{ amount0: bigint; amount1: bigint }> {
  const salt = `0x${input.tokenId.toString(16).padStart(64, "0")}` as Hex;
  const [inside, info] = await Promise.all([
    input.client.readContract({ address: UNISWAP_V4_ARC.stateView, abi: stateViewAbi,
      functionName: "getFeeGrowthInside", args: [input.poolId, input.tickLower, input.tickUpper],
      blockNumber: input.blockNumber }),
    input.client.readContract({ address: UNISWAP_V4_ARC.stateView, abi: stateViewAbi,
      functionName: "getPositionInfo", args: [input.poolId, UNISWAP_V4_ARC.positionManager, input.tickLower,
        input.tickUpper, salt], blockNumber: input.blockNumber }),
  ]);
  const [growth0, growth1] = Array.isArray(inside) ? inside : [];
  const [liquidity, last0, last1] = Array.isArray(info) ? info : [];
  if (![growth0, growth1, liquidity, last0, last1].every((value) => typeof value === "bigint")) {
    throw new Error("V4 fee growth unavailable");
  }
  const owed = (growth: bigint, last: bigint) =>
    (((growth - last) % U256 + U256) % U256) * (liquidity as bigint) / Q128;
  return { amount0: owed(growth0 as bigint, last0 as bigint), amount1: owed(growth1 as bigint, last1 as bigint) };
}

export async function quoteArcV4Swap(input: {
  client: Pick<ChainReadClient, "simulateContract">;
  pool: ArcV4Pool;
  account: Address;
  tokenIn: Address;
  amountIn: bigint;
  blockNumber?: bigint;
}): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  // V4Quoter casts exactAmount through int128 for exact-input swaps.
  if (BigInt(input.pool.liquidity) <= 0n || input.amountIn <= 0n || input.amountIn > (1n << 127n) - 1n) {
    throw new Error("V4 pool or input amount is not executable");
  }
  const tokenIn = getAddress(input.tokenIn);
  if (tokenIn !== input.pool.currency0 && tokenIn !== input.pool.currency1) throw new Error("Input currency is not in pool");
  const result = await input.client.simulateContract({
    account: getAddress(input.account), address: UNISWAP_V4_ARC.quoter, abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: { currency0: input.pool.currency0, currency1: input.pool.currency1,
      fee: input.pool.fee, tickSpacing: input.pool.tickSpacing, hooks: input.pool.hooks },
      zeroForOne: tokenIn === input.pool.currency0, exactAmount: input.amountIn, hookData: "0x" }],
    blockNumber: input.blockNumber,
  });
  if (!Array.isArray(result.result) || typeof result.result[0] !== "bigint" || result.result[0] <= 0n ||
      typeof result.result[1] !== "bigint") throw new Error("V4 pool did not return an executable quote");
  return { amountOut: result.result[0], gasEstimate: result.result[1] };
}

const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const poolKeyType = { type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] } as const;

export type ArcV4Swap = {
  chainId: typeof ARC_CHAIN_ID;
  poolId: Hex;
  to: Address;
  data: Hex;
  value: bigint;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
};

export function buildArcV4Swap(input: {
  pool: ArcV4Pool; tokenIn: Address; amountIn: bigint;
  amountOutMinimum: bigint; deadline: bigint;
}): ArcV4Swap {
  const { pool } = input;
  if (v4PoolId(pool) !== pool.id || input.amountIn <= 0n ||
      input.amountIn > (1n << 127n) - 1n || input.amountOutMinimum <= 0n ||
      input.amountOutMinimum > (1n << 128n) - 1n || input.deadline <= 0n) {
    throw new Error("Invalid v4 swap limits");
  }
  const tokenIn = getAddress(input.tokenIn);
  if (tokenIn !== pool.currency0 && tokenIn !== pool.currency1) throw new Error("Input currency is not in pool");
  const tokenOut = tokenIn === pool.currency0 ? pool.currency1 : pool.currency0;
  const swap = encodeAbiParameters([{ type: "tuple", components: [
    { ...poolKeyType, name: "poolKey" }, { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" },
    { name: "minHopPriceX36", type: "uint256" },
    { name: "hookData", type: "bytes" },
  ] }], [{ poolKey: { currency0: pool.currency0, currency1: pool.currency1,
    fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks },
    zeroForOne: tokenIn === pool.currency0, amountIn: input.amountIn,
    amountOutMinimum: input.amountOutMinimum, minHopPriceX36: 0n, hookData: "0x" }]);
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }],
    [tokenIn, input.amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }],
    [tokenOut, input.amountOutMinimum]);
  const actions = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }],
    ["0x060c0f", [swap, settle, take]]);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute",
    args: ["0x10", [actions], input.deadline] });
  return { chainId: ARC_CHAIN_ID, poolId: pool.id, to: UNISWAP_SHARED_ARC.universalRouter.address,
    data, value: tokenIn === zeroAddress ? input.amountIn : 0n,
    tokenIn, tokenOut, amountIn: input.amountIn,
    amountOutMinimum: input.amountOutMinimum, deadline: input.deadline };
}

export function arcV4SwapPayloadHash(swap: ArcV4Swap): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "address" },
      { type: "uint256" }, { type: "bytes" }],
    [BigInt(swap.chainId), swap.poolId, swap.to, swap.value, swap.data],
  ));
}
