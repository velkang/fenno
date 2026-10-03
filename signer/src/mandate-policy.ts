import { zeroAddress, type Address, type Hex } from "viem";
import { ARC_TOKENS } from "@stillwater/chain";
import type { MainnetIntentKind, MainnetPolicyDecision } from "./mainnet-policy";
import type { WalletState } from "./policy";

/** What the signer knows about a request the automation agent made. */
export type AutomationContext = {
  runId: string;
  /** null when the run no longer exists. */
  runStatus: string | null;
  /** null when the run's mandate no longer exists. */
  mandate: { status: string; poolId: Hex; maxPositionUsd: number; maxRunsPerDay: number } | null;
  /** Runs of this mandate started in the last 24 hours, this one included. */
  runsStartedToday: number;
};

export type MandateRequest = {
  automation: AutomationContext;
  kind: MainnetIntentKind;
  walletState: WalletState;
  poolId: Hex | undefined;
  /** What a mint or swap puts into the pool, in USDC, at the fresh on-chain price. */
  value?: { usdc: bigint; usdcDecimals: number };
};

// The agent may only work a v4 position: approve its tokens, swap, open, collect and close.
const AGENT_KINDS = new Set<MainnetIntentKind>([
  "v4_approval",
  "v4_single_pool_swap",
  "v4_position_mint",
  "v4_position_collect",
  "v4_position_withdraw",
]);
const VALUED_KINDS = new Set<MainnetIntentKind>(["v4_single_pool_swap", "v4_position_mint"]);

const reject = (reason: string): MainnetPolicyDecision => ({ allowed: false, reason });

/**
 * The user's mandate is the agent's whole permission. Checked on top of the normal
 * policy for every request the agent makes; anything unclear is refused.
 */
export function validateMandate(request: MandateRequest): MainnetPolicyDecision {
  const { automation } = request;
  if (automation.runStatus !== "running") return reject("MANDATE_RUN_NOT_RUNNING");
  const mandate = automation.mandate;
  if (!mandate || mandate.status !== "active") return reject("MANDATE_NOT_ACTIVE");
  if (request.walletState !== "active") return reject("MANDATE_WALLET_NOT_ACTIVE");
  if (!AGENT_KINDS.has(request.kind)) return reject("MANDATE_KIND_NOT_ALLOWED");
  if (!request.poolId || request.poolId.toLowerCase() !== mandate.poolId.toLowerCase()) {
    return reject("MANDATE_POOL_NOT_ALLOWED");
  }
  if (VALUED_KINDS.has(request.kind)) {
    if (!request.value) return reject("MANDATE_VALUE_UNKNOWN");
    const limit = BigInt(mandate.maxPositionUsd) * 10n ** BigInt(request.value.usdcDecimals);
    if (request.value.usdc > limit) return reject("MANDATE_VALUE_EXCEEDS_LIMIT");
  }
  if (automation.runsStartedToday > mandate.maxRunsPerDay) return reject("MANDATE_DAILY_LIMIT_REACHED");
  return { allowed: true, reason: "POLICY_ALLOWED" };
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
