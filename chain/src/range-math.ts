import { zeroAddress, type Address } from "viem";
import { ARC_TOKENS } from "./arc";

// Price, tick and amount math shared by the web app and the automation Worker.

export function tickToPrice(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

export function priceToTick(price: number, dec0: number, dec1: number): number {
  if (price <= 0) return 0;
  return Math.round(Math.log(price / Math.pow(10, dec0 - dec1)) / Math.log(1.0001));
}

export function alignTick(tick: number, spacing: number): number {
  return Math.round(tick / spacing) * spacing;
}

function trimAmount(value: number, decimals: number): string {
  if (!(value > 0)) return "";
  return value.toLocaleString("en-US", {
    maximumSignificantDigits: 8,
    maximumFractionDigits: Math.min(decimals, 12),
    useGrouping: false,
  });
}

// Given one side of a deposit, returns the other side so both match the range at the
// current price. "token" is the listed token and "usdc" the quote; pool order may be either.
export function pairedAmount(input: {
  from: "token" | "usdc";
  value: string;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  spotPrice: number;
  tokenDecimals: number;
  usdcDecimals: number;
  usdcIsPoolToken0: boolean;
}): string {
  const num = Number.parseFloat(input.value.trim().replace(",", "."));
  if (Number.isNaN(num) || num <= 0 || !input.spotPrice) return "";
  const { currentTick, tickLower, tickUpper, usdcIsPoolToken0 } = input;
  // Outside the range the position holds only one asset.
  const belowRange = currentTick <= tickLower;
  const aboveRange = currentTick >= tickUpper;
  if (belowRange || aboveRange) {
    const heldIsUsdc = belowRange === usdcIsPoolToken0;
    return (input.from === "usdc") === heldIsUsdc ? "0" : "";
  }
  const sqrtP = Math.pow(1.0001, currentTick / 2);
  const deltaLower = sqrtP - Math.pow(1.0001, tickLower / 2);
  const sqrtPu = Math.pow(1.0001, tickUpper / 2);
  const deltaUpper = sqrtPu - sqrtP;
  // Raw pool-token1 per pool-token0 required at this range.
  const rawRatio = (sqrtP * sqrtPu * deltaLower) / deltaUpper;
  const usdcPerToken = usdcIsPoolToken0
    ? 1 / (rawRatio * Math.pow(10, input.usdcDecimals - input.tokenDecimals))
    : rawRatio * Math.pow(10, input.tokenDecimals - input.usdcDecimals);
  if (!Number.isFinite(usdcPerToken) || usdcPerToken <= 0) return "";
  return input.from === "token"
    ? trimAmount(num * usdcPerToken, input.usdcDecimals)
    : trimAmount(num / usdcPerToken, input.tokenDecimals);
}

/** How far either side of today's price each band reaches. */
export const BANDS = { wide: 0.25, balanced: 0.1, narrow: 0.03 } as const;
export type Band = keyof typeof BANDS;

/**
 * The ticks for a band around the token's dollar price. `spotPrice` is USDC per token;
 * the pool may list USDC first or second.
 */
export function bandTicks(input: {
  spotPrice: number;
  spread: number;
  tokenDecimals: number;
  usdcDecimals: number;
  usdcIsPoolToken0: boolean;
  tickSpacing: number;
}) {
  const { spotPrice, spread, tokenDecimals, usdcDecimals, usdcIsPoolToken0, tickSpacing } = input;
  const minPrice = spotPrice * (1 - spread);
  const maxPrice = spotPrice * (1 + spread);
  const rawLower = usdcIsPoolToken0
    ? priceToTick(1 / maxPrice, usdcDecimals, tokenDecimals)
    : priceToTick(minPrice, tokenDecimals, usdcDecimals);
  const rawUpper = usdcIsPoolToken0
    ? priceToTick(1 / minPrice, usdcDecimals, tokenDecimals)
    : priceToTick(maxPrice, tokenDecimals, usdcDecimals);
  const tickLower = alignTick(rawLower, tickSpacing);
  // A very narrow band can round to a single tick; keep it at least one spacing wide.
  const tickUpper = Math.max(alignTick(rawUpper, tickSpacing), tickLower + tickSpacing);
  return { minPrice, maxPrice, tickLower, tickUpper };
}

/** Raw token amounts a position holds at the current price (Uniswap's liquidity math). */
export function positionAmounts(liquidity: number, sqrtPriceX96: string, tickLower: number, tickUpper: number) {
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  const sqrtLower = Math.pow(1.0001, tickLower / 2);
  const sqrtUpper = Math.pow(1.0001, tickUpper / 2);
  if (sqrtPrice <= sqrtLower) return { amount0: liquidity * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper), amount1: 0 };
  if (sqrtPrice >= sqrtUpper) return { amount0: 0, amount1: liquidity * (sqrtUpper - sqrtLower) };
  return { amount0: liquidity * (sqrtUpper - sqrtPrice) / (sqrtPrice * sqrtUpper), amount1: liquidity * (sqrtPrice - sqrtLower) };
}

// Swaps smaller than this share of the money aren't worth a transaction.
const MIN_SWAP_SHARE = 0.005;

/**
 * The swap that leaves `token` and `usdc` (raw amounts) in the ratio a new band needs at
 * today's price, ignoring the swap's own fee. Null when no swap is needed.
 */
export function rebalanceSwap(input: {
  sqrtPriceX96: string;
  tickLower: number;
  tickUpper: number;
  tokenIsZero: boolean;
  token: bigint;
  usdc: bigint;
}): { from: "token" | "usdc"; amountIn: bigint } | null {
  const price = (Number(input.sqrtPriceX96) / 2 ** 96) ** 2; // raw currency1 per raw currency0
  const [held0, held1] = input.tokenIsZero
    ? [Number(input.token), Number(input.usdc)] : [Number(input.usdc), Number(input.token)];
  const total = held0 * price + held1; // in currency1
  if (!(price > 0) || !(total > 0)) return null;
  const unit = positionAmounts(1e18, input.sqrtPriceX96, input.tickLower, input.tickUpper);
  const share1 = unit.amount1 / (unit.amount0 * price + unit.amount1);
  const excess1 = held1 - total * share1;
  if (Math.abs(excess1) < total * MIN_SWAP_SHARE) return null;
  // Too much currency1: swap the excess into currency0. Too little: swap currency0 into it.
  const fromCurrency0 = excess1 < 0;
  const amountIn = fromCurrency0 ? -excess1 / price : excess1;
  return { from: fromCurrency0 === input.tokenIsZero ? "token" : "usdc", amountIn: BigInt(Math.floor(amountIn)) };
}

const Q192 = 1n << 192n;

/**
 * The USDC value of putting `amount0` and `amount1` into a v4 USDC pool at its current
 * price. USDC is the 6-decimal ERC-20 or native USDC (18 decimals, always currency0).
 * Null when the pool has no USDC side or no price.
 */
export function usdcValue(input: {
  pool: { currency0: Address; currency1: Address; sqrtPriceX96: string };
  amount0: bigint;
  amount1: bigint;
}): { usdc: bigint; usdcDecimals: number } | null {
  const { pool, amount0, amount1 } = input;
  const isUsdc = (currency: Address) =>
    currency.toLowerCase() === zeroAddress || currency.toLowerCase() === ARC_TOKENS.USDC.address.toLowerCase();
  const squared = BigInt(pool.sqrtPriceX96) ** 2n; // raw currency1 per raw currency0, times 2^192
  if (squared === 0n) return null;
  const usdcDecimals = (usdc: Address) => (usdc.toLowerCase() === zeroAddress ? 18 : ARC_TOKENS.USDC.decimals);
  if (isUsdc(pool.currency0)) {
    return { usdc: amount0 + (amount1 * Q192) / squared, usdcDecimals: usdcDecimals(pool.currency0) };
  }
  if (isUsdc(pool.currency1)) {
    return { usdc: amount1 + (amount0 * squared) / Q192, usdcDecimals: usdcDecimals(pool.currency1) };
  }
  return null;
}
