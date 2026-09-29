import { zeroAddress } from "viem";
import { ARC_TOKENS } from "@stillwater/chain";
import { api, type PublicPool } from "./api-client";
import { ensureV4Allowance } from "./v4-actions";

// Swaps look the same for every pool; only the API calls differ between Uniswap v3 and v4.

export type SwapDirection = "buy" | "sell";
export type SwapQuote = { amountIn: string; expectedAmountOut: string; minimumAmountOut: string; allowance?: string };

const SLIPPAGE_BPS = 100;

const isV4 = (pool: PublicPool) => pool.protocol === "uniswap-v4";
const usesNativeUsdc = (pool: PublicPool) =>
  isV4(pool) && [pool.token0, pool.token1].some((address) => address.toLowerCase() === zeroAddress);

// A v4 pool can hold native USDC (18 decimals); every other USDC leg is the 6-decimal ERC-20.
export function usdcDecimals(pool: PublicPool) {
  return usesNativeUsdc(pool) ? 18 : 6;
}

export function swapDecimals(pool: PublicPool, direction: SwapDirection, side: "in" | "out") {
  const paysUsdc = (direction === "buy") === (side === "in");
  return paysUsdc ? usdcDecimals(pool) : pool.token.decimals;
}

function v4TokenIn(pool: PublicPool, direction: SwapDirection) {
  if (direction === "sell") return pool.token.address;
  return usesNativeUsdc(pool) ? zeroAddress : ARC_TOKENS.USDC.address;
}

export async function quotePoolSwap(pool: PublicPool, direction: SwapDirection, amountIn: bigint): Promise<SwapQuote> {
  if (isV4(pool)) {
    const quote = await api.quoteV4Swap({ poolId: pool.address, tokenIn: v4TokenIn(pool, direction),
      amountIn: amountIn.toString(), slippageBps: SLIPPAGE_BPS });
    return { amountIn: amountIn.toString(), expectedAmountOut: quote.expectedAmountOut, minimumAmountOut: quote.minimumAmountOut };
  }
  const quote = await api.quoteSwap({ tokenAddress: pool.token.address, poolAddress: pool.address,
    direction, amountIn: amountIn.toString(), slippageBps: SLIPPAGE_BPS });
  return { amountIn: quote.amountIn, expectedAmountOut: quote.expectedAmountOut,
    minimumAmountOut: quote.minimumAmountOut, allowance: quote.allowance };
}

// Approves the exact input if needed, then sends the swap. Returns false when a transaction
// was sent but has not confirmed yet.
export async function executePoolSwap(input: {
  pool: PublicPool;
  direction: SwapDirection;
  quote: SwapQuote;
  execute: (intentId: string) => Promise<boolean>;
  onApprove: () => void;
}): Promise<boolean> {
  const { pool, direction, quote, execute, onApprove } = input;
  const amountIn = BigInt(quote.amountIn);
  if (isV4(pool)) {
    const tokenIn = v4TokenIn(pool, direction);
    if (!await ensureV4Allowance({ poolId: pool.address, token: tokenIn, amount: amountIn,
      purpose: "swap", execute, onApprove })) return false;
    // Approvals take time; stop if the price moved below the minimum the user reviewed.
    const reviewedMinimum = BigInt(quote.minimumAmountOut);
    const fresh = await quotePoolSwap(pool, direction, amountIn);
    if (BigInt(fresh.expectedAmountOut) < reviewedMinimum) throw new Error("V4_QUOTE_STALE");
    const minimumAmountOut = BigInt(fresh.minimumAmountOut) > reviewedMinimum ? fresh.minimumAmountOut : quote.minimumAmountOut;
    const prepared = await api.prepareV4Swap({ poolId: pool.address, tokenIn, amountIn: quote.amountIn,
      slippageBps: SLIPPAGE_BPS, minimumAmountOut, idempotencyKey: crypto.randomUUID() });
    return execute(prepared.intentId);
  }
  if (quote.allowance !== undefined && BigInt(quote.allowance) < amountIn) {
    onApprove();
    const approval = await api.prepareTokenApproval({
      tokenAddress: direction === "buy" ? ARC_TOKENS.USDC.address : pool.token.address,
      poolAddress: pool.address, poolTokenAddress: pool.token.address,
      spender: "swap", amount: quote.amountIn, idempotencyKey: crypto.randomUUID(),
    });
    if (!await execute(approval.intentId)) return false;
  }
  const prepared = await api.prepareSwap({ tokenAddress: pool.token.address, poolAddress: pool.address,
    direction, amountIn: quote.amountIn, slippageBps: SLIPPAGE_BPS, idempotencyKey: crypto.randomUUID() });
  return execute(prepared.intentId);
}

const SWAP_ERRORS: Record<string, string> = {
  POOL_QUOTE_UNAVAILABLE: "This pool could not quote a swap for this amount. Try another fee tier or a smaller amount.",
  V4_QUOTE_TOO_SMALL: "This pool could not quote a swap for this amount. Try another fee tier or a smaller amount.",
  V4_SWAP_SIMULATION_FAILED: "This pool's swap could not be simulated. No swap was sent. Try another pool.",
  V4_QUOTE_STALE: "The pool price changed. Review the new quote before swapping.",
  V4_APPROVAL_REQUIRED: "Your approval changed or expired. Review the swap again to continue.",
  INSUFFICIENT_USDC_AFTER_FEES: "Not enough USDC left to cover this swap and its network fee.",
};

// Codes where another pool for the same token might work.
export const POOL_UNUSABLE_ERRORS = new Set(["POOL_QUOTE_UNAVAILABLE", "V4_QUOTE_TOO_SMALL", "V4_SWAP_SIMULATION_FAILED"]);

export function swapErrorMessage(code: string) {
  return SWAP_ERRORS[code] ?? code;
}
