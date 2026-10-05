import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { ARC_CHAIN_ID, ARC_TOKENS, UNISWAP_V3_ARC } from "./arc";
import { SUPPORTED_UNISWAP_FEES, type DiscoveredPool } from "./pool-discovery";
import type { ApprovalSimulationClient } from "./approvals";
import type { ChainReadClient } from "./reads";

export const positionManagerAbi = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const MAX_SLIPPAGE_BPS = 500;

export type MintPool = Pick<DiscoveredPool, "address" | "token0" | "token1" | "fee" | "tickSpacing">;

export type Mint = {
  chainId: typeof ARC_CHAIN_ID;
  to: Address;
  data: Hex;
  value: 0n;
  recipient: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  slippageBps: number;
  deadline: bigint;
};

export function buildMint(input: {
  pool: MintPool;
  recipient: Address;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  slippageBps: number;
  deadline: bigint;
  amount0Min?: bigint;
  amount1Min?: bigint;
}): Mint {
  if (!Number.isInteger(input.pool.tickSpacing) || input.pool.tickSpacing <= 0) {
    throw new Error("Invalid pool tick spacing");
  }
  if (
    !Number.isInteger(input.tickLower) ||
    !Number.isInteger(input.tickUpper) ||
    input.tickLower < MIN_TICK ||
    input.tickUpper > MAX_TICK ||
    input.tickLower >= input.tickUpper ||
    input.tickLower % input.pool.tickSpacing !== 0 ||
    input.tickUpper % input.pool.tickSpacing !== 0
  ) throw new Error("Invalid position tick range");
  if (input.amount0Desired <= 0n || input.amount1Desired <= 0n) {
    throw new Error("Both position amounts must be positive");
  }
  if (
    !Number.isInteger(input.slippageBps) ||
    input.slippageBps < 0 ||
    input.slippageBps > MAX_SLIPPAGE_BPS
  ) throw new Error("Position slippage exceeds policy");
  if (input.deadline <= 0n) throw new Error("Invalid position deadline");
  const amount0Min = input.amount0Min ??
    (input.amount0Desired * BigInt(10_000 - input.slippageBps)) / 10_000n;
  const amount1Min = input.amount1Min ??
    (input.amount1Desired * BigInt(10_000 - input.slippageBps)) / 10_000n;
  if (
    amount0Min < 0n || amount1Min < 0n ||
    amount0Min > input.amount0Desired || amount1Min > input.amount1Desired
  ) throw new Error("Position min amounts are invalid");
  const recipient = getAddress(input.recipient);
  const parameters = {
    token0: input.pool.token0.address,
    token1: input.pool.token1.address,
    fee: input.pool.fee,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    amount0Desired: input.amount0Desired,
    amount1Desired: input.amount1Desired,
    amount0Min,
    amount1Min,
    recipient,
    deadline: input.deadline,
  };
  return {
    chainId: ARC_CHAIN_ID,
    to: UNISWAP_V3_ARC.nonfungiblePositionManager.address,
    data: encodeFunctionData({ abi: positionManagerAbi, functionName: "mint", args: [parameters] }),
    value: 0n,
    recipient,
    token0: input.pool.token0.address,
    token1: input.pool.token1.address,
    fee: input.pool.fee,
    tickSpacing: input.pool.tickSpacing,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    amount0Desired: input.amount0Desired,
    amount1Desired: input.amount1Desired,
    amount0Min,
    amount1Min,
    slippageBps: input.slippageBps,
    deadline: input.deadline,
  };
}

export function mintPayloadHash(mint: Pick<Mint, "chainId" | "to" | "recipient" | "data">): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes" },
      ],
      [BigInt(mint.chainId), mint.to, mint.recipient, mint.data],
    ),
  );
}

export async function simulateMint(input: {
  client: ApprovalSimulationClient;
  owner: Address;
  mint: Mint;
  blockNumber: bigint;
}) {
  const simulation = await input.client.simulateContract({
    account: input.owner,
    address: input.mint.to,
    abi: positionManagerAbi,
    functionName: "mint",
    args: [{
      token0: input.mint.token0,
      token1: input.mint.token1,
      fee: input.mint.fee,
      tickLower: input.mint.tickLower,
      tickUpper: input.mint.tickUpper,
      amount0Desired: input.mint.amount0Desired,
      amount1Desired: input.mint.amount1Desired,
      amount0Min: input.mint.amount0Min,
      amount1Min: input.mint.amount1Min,
      recipient: input.mint.recipient,
      deadline: input.mint.deadline,
    }],
    blockNumber: input.blockNumber,
  });
  if (!Array.isArray(simulation.result) || simulation.result.length !== 4) {
    throw new Error("Invalid mint simulation result");
  }
  const [tokenId, liquidity, amount0, amount1] = simulation.result;
  if ([tokenId, liquidity, amount0, amount1].some((value) => typeof value !== "bigint")) {
    throw new Error("Invalid mint simulation result");
  }
  const gasEstimate = await input.client.estimateGas({
    account: input.owner,
    to: input.mint.to,
    data: input.mint.data,
    value: 0n,
    blockNumber: input.blockNumber,
  });
  return {
    blockNumber: input.blockNumber.toString(),
    gasEstimate: gasEstimate.toString(),
    tokenId: (tokenId as bigint).toString(),
    liquidity: (liquidity as bigint).toString(),
    amount0: (amount0 as bigint).toString(),
    amount1: (amount1 as bigint).toString(),
  };
}

/** A position Stillwater may act on: owned by the managed wallet, in a supported USDC pool. */
export async function verifyV3Position(input: {
  client: ChainReadClient;
  owner: Address;
  tokenId: bigint;
  blockNumber: bigint;
}) {
  if (input.tokenId < 0n) throw new Error("Invalid position token ID");
  const manager = UNISWAP_V3_ARC.nonfungiblePositionManager.address;
  const [ownerValue, positionValue] = await Promise.all([
    input.client.readContract({
      address: manager,
      abi: positionManagerAbi,
      functionName: "ownerOf",
      args: [input.tokenId],
      blockNumber: input.blockNumber,
    }),
    input.client.readContract({
      address: manager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [input.tokenId],
      blockNumber: input.blockNumber,
    }),
  ]);
  if (typeof ownerValue !== "string" || getAddress(ownerValue) !== getAddress(input.owner)) {
    throw new Error("Position is not owned by the managed wallet");
  }
  if (!Array.isArray(positionValue)) throw new Error("Invalid position response");
  const token0 = typeof positionValue[2] === "string" ? getAddress(positionValue[2]) : null;
  const token1 = typeof positionValue[3] === "string" ? getAddress(positionValue[3]) : null;
  if (
    (token0 !== ARC_TOKENS.USDC.address && token1 !== ARC_TOKENS.USDC.address) ||
    !(SUPPORTED_UNISWAP_FEES as readonly unknown[]).includes(positionValue[4])
  ) {
    throw new Error("Position is not in a USDC pool");
  }
  return {
    tokenId: input.tokenId.toString(),
    tickLower: Number(positionValue[5]),
    tickUpper: Number(positionValue[6]),
    liquidity: String(positionValue[7]),
    blockNumber: input.blockNumber.toString(),
  };
}
