import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { ARC_CHAIN_ID, ARC_TOKENS, UNISWAP_SWAP_ARC } from "./arc";
import type { DiscoveredPool } from "./pool-discovery";

export const swapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export type Swap = {
  chainId: typeof ARC_CHAIN_ID;
  to: Address;
  data: Hex;
  value: 0n;
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
};

export async function quoteSwap(input: {
  client: {
    simulateContract(parameters: {
      account: Address;
      address: Address;
      abi: typeof quoterAbi;
      functionName: "quoteExactInputSingle";
      args: readonly [{ tokenIn: Address; tokenOut: Address; amountIn: bigint; fee: number; sqrtPriceLimitX96: bigint }];
      blockNumber?: bigint;
    }): Promise<{ result: readonly [bigint, bigint, number, bigint] }>;
  };
  pool: Pick<DiscoveredPool, "fee">;
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  blockNumber?: bigint;
}): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  if (input.amountIn <= 0n) throw new Error("Swap amount must be positive");
  const response = await input.client.simulateContract({
    account: getAddress(input.account),
    address: UNISWAP_SWAP_ARC.quoterV2,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: getAddress(input.tokenIn), tokenOut: getAddress(input.tokenOut),
      amountIn: input.amountIn, fee: input.pool.fee, sqrtPriceLimitX96: 0n }],
    blockNumber: input.blockNumber,
  });
  const amountOut = response.result[0];
  if (amountOut <= 0n) throw new Error("No output available for this swap");
  return { amountOut, gasEstimate: response.result[3] };
}

export function buildSwap(input: {
  poolAddress: Address;
  poolFee: number;
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
}): Swap {
  if (input.amountIn <= 0n || input.amountOutMinimum <= 0n || input.deadline <= 0n) {
    throw new Error("Invalid swap limits");
  }
  const tokenIn = getAddress(input.tokenIn);
  const tokenOut = getAddress(input.tokenOut);
  if (tokenIn === tokenOut ||
    (tokenIn !== ARC_TOKENS.USDC.address && tokenOut !== ARC_TOKENS.USDC.address)) {
    throw new Error("Swap must pair a token with Arc USDC");
  }
  const recipient = getAddress(input.recipient);
  const call = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [{ tokenIn, tokenOut, fee: input.poolFee, recipient,
      amountIn: input.amountIn, amountOutMinimum: input.amountOutMinimum,
      sqrtPriceLimitX96: 0n }],
  });
  return {
    chainId: ARC_CHAIN_ID,
    to: UNISWAP_SWAP_ARC.swapRouter02,
    data: encodeFunctionData({ abi: swapRouterAbi, functionName: "multicall", args: [input.deadline, [call]] }),
    value: 0n,
    poolAddress: getAddress(input.poolAddress),
    tokenIn, tokenOut, fee: input.poolFee, recipient,
    amountIn: input.amountIn,
    amountOutMinimum: input.amountOutMinimum,
    deadline: input.deadline,
  };
}

export function swapPayloadHash(swap: Swap): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes" }],
    [BigInt(swap.chainId), swap.poolAddress, swap.to, swap.data],
  ));
}
