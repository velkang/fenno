import { getAddress } from "viem";
import { MIN_POOL_DEPTH_USD, poolDepthUsd } from "@stillwater/chain";
import type { PublicPool } from "../lib/api-client";

const PILL = "inline-flex items-center rounded-full border font-semibold whitespace-nowrap";
// "large" matches the pool page's other header pills.
const SIZE = { small: "px-2.5 py-0.5 text-[.78rem]", large: "min-h-11 px-4 text-[1.02rem]" };
type Size = keyof typeof SIZE;

/** Under a few dollars moves its price: the price can be pushed anywhere, so Stillwater won't trade or add there. */
export function isAlmostEmpty(pool: Pick<PublicPool, "token0" | "token1" | "sqrtPriceX96" | "liquidity">): boolean {
  return poolDepthUsd({ currency0: getAddress(pool.token0), currency1: getAddress(pool.token1),
    sqrtPriceX96: pool.sqrtPriceX96, liquidity: pool.liquidity || "0" }) < MIN_POOL_DEPTH_USD;
}

/** Which Uniswap the pool (or position) is on. */
export function ProtocolBadge({ v4, size = "small" }: { v4: boolean; size?: Size }) {
  return <span className={`${PILL} ${SIZE[size]} border-line text-ink-muted`} title={v4 ? "A Uniswap v4 pool" : "A Uniswap v3 pool"}>
    {v4 ? "v4" : "v3"}
  </span>;
}

export function AlmostEmptyBadge({ size = "small" }: { size?: Size }) {
  return <span className={`${PILL} ${SIZE[size]} border-danger-line text-danger`}
    title="So little is in this pool that a small trade moves its price a lot">Almost empty</span>;
}
