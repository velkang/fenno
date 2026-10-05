import { zeroAddress, type Address, type Hex } from "viem";
import { BANDS, bandTicks, rebalanceSwap, tickToPrice, type Band } from "@stillwater/chain";
import { ApiCallError, type AgentApi, type PoolInfo } from "./agent-api";
import { v3Venue } from "./venue-v3";
import { v4Venue } from "./venue-v4";

// Re-centring a position: close it, swap what came back into the ratio the new band needs,
// approve, and open the new band. One transaction at a time; the Durable Object saves the
// state this returns and calls again when it's time to look. The steps are the same for v3
// and v4; a venue makes the protocol's own calls.

/** What the user asked for. */
export type RunPlan = {
  runId: string;
  walletId: string;
  walletAddress: Address;
  mandateId: string;
  /** A v4 pool id, or a v3 pool address. */
  poolId: Hex;
  tokenId: string;
  /** Re-centre the band, or only close it. */
  kind: "rebalance" | "close";
  band: Band;
  /** The mandate was made for this run only and ends with it. */
  revokeMandate: boolean;
};

export type RunState = RunPlan & {
  startedAt: number;
  /** Wallet balances before the close: only money from the closed position is reinvested. */
  baseline?: { token: string; usdc: string };
  /** What the close returned, measured once right after it: the most the new band may hold. */
  proceeds?: { token: string; usdc: string };
  /** The swap sent, so its result is counted in place of whatever else arrives. */
  swap?: { from: "token" | "usdc"; amountIn: string; expectedOut: string };
  /** The new band, fixed when first worked out so the swap and the mint agree. */
  ticks?: { tickLower: number; tickUpper: number };
  /** The transaction in flight. `attemptId` is set once it has been sent. */
  pending?: { step: string; intentId: string; attemptId?: string };
  /** Steps that have confirmed on chain (or, for the swap, turned out not to be needed). */
  done: string[];
  /** How the run ended, kept until that has been recorded. */
  finished?: Exclude<Outcome, { kind: "wait" }>;
};

export type Outcome =
  | { kind: "wait"; state: RunState; delayMs: number }
  | { kind: "done" }
  | { kind: "failed"; reason: string };

export const RUN_TIMEOUT_MS = 30 * 60 * 1_000;
const CHECK_MS = 4_000;
// Sent right after it was prepared, in the next call, so the intent is saved first.
const SEND_MS = 100;
// USDC the wallet keeps after the reinvestment, so the remaining transactions can pay their fees.
const GAS_RESERVE = { erc20: 50_000n, native: 50_000_000_000_000_000n }; // 0.05 USDC

export type Sides = { token: string; usdc: string; tokenIsZero: boolean; usdcDecimals: number; native: boolean };
export type Holdings = { token: bigint; usdc: bigint };
/** The next transaction: its step name and the intent prepared for it. */
export type Step = { step: string; intentId: string };

/** A protocol's calls for each part of a re-centre. */
export interface Venue {
  pool(): Promise<PoolInfo>;
  holdings(sides: Sides): Promise<Holdings>;
  prepareClose(state: RunState, deadline: string): Promise<{ intentId: string }>;
  /** An approval the swap still needs, or the swap itself with what it should return. */
  swapStep(state: RunState, sides: Sides, tokenIn: string, amountIn: bigint, now: number):
    Promise<Step & { expectedOut?: string }>;
  /** An approval the new band still needs, or opening it with at most `limit0`/`limit1`. */
  openStep(input: { state: RunState; pool: PoolInfo; sides: Sides; ticks: { tickLower: number; tickUpper: number };
    limit0: bigint; limit1: bigint; deadline: string; now: number }): Promise<Step>;
}

/** A run's pool: a v4 pool id (32 bytes) or a v3 pool address (20 bytes). */
export const isV3Pool = (poolId: string) => /^0x[0-9a-fA-F]{40}$/.test(poolId);

export function startState(plan: RunPlan, now: number): RunState {
  return { ...plan, startedAt: now, done: [] };
}

const wait = (state: RunState, delayMs = CHECK_MS): Outcome => ({ kind: "wait", state, delayMs });
const failed = (reason: string): Outcome => ({ kind: "failed", reason });

/** One look at the run: settle what's in flight, then prepare the next transaction. */
export async function advance(input: RunState, api: AgentApi, now: number): Promise<Outcome> {
  // A transaction already sent always settles (the reconciler marks one that never lands as
  // dropped), so the time limit only stops a run between transactions.
  if (now - input.startedAt > RUN_TIMEOUT_MS && !input.pending?.attemptId) return failed("RUN_TIMED_OUT");
  let state: RunState = { ...input, done: [...input.done] };
  try {
    if (state.pending) {
      const pending = state.pending;
      if (!pending.attemptId) {
        try {
          const { attemptId } = await api.execute(pending.intentId);
          return wait({ ...state, pending: { ...pending, attemptId } });
        } catch (error) {
          // The wallet is finishing another transaction (perhaps the user's): try again shortly.
          if (error instanceof ApiCallError && error.code === "WALLET_EXECUTION_BUSY") return wait(state);
          throw error;
        }
      }
      const attempt = await api.reconcile(pending.attemptId);
      if (attempt.status === "submitted" || attempt.status === "pending") return wait(state);
      if (attempt.status !== "confirmed") return failed(attempt.reasonCode || "TRANSACTION_FAILED");
      state = { ...state, pending: undefined, done: [...state.done, pending.step] };
    }
    const venue = isV3Pool(state.poolId) ? v3Venue(api, state.poolId) : v4Venue(api, state.poolId);
    const next = await nextTransaction(state, venue, now);
    if (next === "finished") return { kind: "done" };
    return wait({ ...next.state, pending: { step: next.step, intentId: next.intentId } }, SEND_MS);
  } catch (error) {
    return failed(error instanceof ApiCallError ? error.code : "AUTOMATION_ERROR");
  }
}

type Next = "finished" | { state: RunState; step: string; intentId: string };

async function nextTransaction(input: RunState, venue: Venue, now: number): Promise<Next> {
  let state = input;
  const deadline = String(Math.floor(now / 1_000) + 10 * 60);
  let pool = await venue.pool();
  const sides = poolSides(pool);

  if (!state.baseline) {
    const held = await venue.holdings(sides);
    state = { ...state, baseline: { token: held.token.toString(), usdc: held.usdc.toString() } };
  }
  if (!state.done.includes("close")) {
    const { intentId } = await venue.prepareClose(state, deadline);
    return { state, step: "close", intentId };
  }
  // Closing only: the tokens are back in the wallet and nothing reopens.
  if (state.kind === "close") return "finished";

  if (!state.proceeds) {
    const returned = reinvestable(state, sides, await venue.holdings(sides));
    state = { ...state, proceeds: { token: returned.token.toString(), usdc: returned.usdc.toString() } };
  }

  if (!state.ticks) {
    const { tickLower, tickUpper } = bandTicks({ spotPrice: spotPrice(pool, sides), spread: BANDS[state.band],
      tokenDecimals: pool.token.decimals, usdcDecimals: sides.usdcDecimals, usdcIsPoolToken0: !sides.tokenIsZero,
      tickSpacing: pool.tickSpacing });
    state = { ...state, ticks: { tickLower, tickUpper } };
  }
  const ticks = state.ticks!;

  if (!state.done.includes("swap")) {
    const available = usable(state, sides, await venue.holdings(sides));
    const swap = rebalanceSwap({ sqrtPriceX96: pool.sqrtPriceX96, ...ticks, tokenIsZero: sides.tokenIsZero, ...available });
    if (!swap || swap.amountIn <= 0n) {
      state = { ...state, done: [...state.done, "swap"] };
    } else {
      const tokenIn = swap.from === "usdc" ? sides.usdc : sides.token;
      const next = await venue.swapStep(state, sides, tokenIn, swap.amountIn, now);
      if (next.expectedOut !== undefined) {
        state = { ...state, swap: { from: swap.from, amountIn: swap.amountIn.toString(), expectedOut: next.expectedOut } };
      }
      return { state, step: next.step, intentId: next.intentId };
    }
  }

  if (state.done.includes("mint")) return "finished";
  pool = await venue.pool(); // the swap moved the price
  const available = usable(state, sides, await venue.holdings(sides));
  const [limit0, limit1] = sides.tokenIsZero ? [available.token, available.usdc] : [available.usdc, available.token];
  if (limit0 <= 0n || limit1 <= 0n) throw new ApiCallError("NOTHING_TO_REOPEN", 422);
  const next = await venue.openStep({ state, pool, sides, ticks, limit0, limit1, deadline, now });
  return { state, ...next };
}

function poolSides(pool: PoolInfo): Sides {
  const tokenIsZero = pool.token0.toLowerCase() === pool.token.address.toLowerCase();
  const usdc = tokenIsZero ? pool.token1 : pool.token0;
  const native = usdc.toLowerCase() === zeroAddress;
  return { token: pool.token.address, usdc, tokenIsZero, native, usdcDecimals: native ? 18 : 6 };
}

function spotPrice(pool: PoolInfo, sides: Sides): number {
  return sides.tokenIsZero
    ? tickToPrice(pool.tick, pool.token.decimals, sides.usdcDecimals)
    : 1 / tickToPrice(pool.tick, sides.usdcDecimals, pool.token.decimals);
}

/**
 * What came out of the closed position (net of fees so far). The wallet's own money stays
 * out, and so does enough USDC to leave the reserve in the wallet for the remaining fees.
 */
function reinvestable(state: RunState, sides: Sides, held: Holdings) {
  const positive = (value: bigint) => (value > 0n ? value : 0n);
  const reserve = sides.native ? GAS_RESERVE.native : GAS_RESERVE.erc20;
  const baseline = BigInt(state.baseline!.usdc);
  return {
    token: positive(held.token - BigInt(state.baseline!.token)),
    usdc: positive(held.usdc - (baseline > reserve ? baseline : reserve)),
  };
}

/**
 * What the new band may use now: what the close returned (adjusted by the swap), but never
 * more than the wallet has gained since the run began. Money that arrives from elsewhere
 * meanwhile stays out, and so do the fees paid along the way.
 */
function usable(state: RunState, sides: Sides, held: Holdings) {
  const measured = reinvestable(state, sides, held);
  let token = BigInt(state.proceeds!.token);
  let usdc = BigInt(state.proceeds!.usdc);
  if (state.swap && state.done.includes("swap")) {
    const [amountIn, out] = [BigInt(state.swap.amountIn), BigInt(state.swap.expectedOut)];
    if (state.swap.from === "token") { token -= amountIn; usdc += out; } else { usdc -= amountIn; token += out; }
  }
  const least = (a: bigint, b: bigint) => (a < b ? a : b);
  const positive = (value: bigint) => (value > 0n ? value : 0n);
  return { token: positive(least(token, measured.token)), usdc: positive(least(usdc, measured.usdc)) };
}
