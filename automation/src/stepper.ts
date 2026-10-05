import { getAddress, maxUint160, maxUint256, zeroAddress, type Address, type Hex } from "viem";
import { BANDS, bandTicks, buildArcV4Mint, rebalanceSwap, tickToPrice, type Band } from "@stillwater/chain";
import { ApiCallError, SLIPPAGE_BPS, type AgentApi, type Balances, type PoolInfo, type Purpose } from "./agent-api";

// Re-centring a v4 position: close it, swap what came back into the ratio the new band
// needs, approve, and open the new band. One transaction at a time; the Durable Object saves
// the state this returns and calls again when it's time to look.

/** What the user asked for. */
export type RunPlan = {
  runId: string;
  walletId: string;
  walletAddress: Address;
  mandateId: string;
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
    const next = await nextTransaction(state, api, now);
    if (next === "finished") return { kind: "done" };
    return wait({ ...next.state, pending: { step: next.step, intentId: next.intentId } }, SEND_MS);
  } catch (error) {
    return failed(error instanceof ApiCallError ? error.code : "AUTOMATION_ERROR");
  }
}

type Next = "finished" | { state: RunState; step: string; intentId: string };

async function nextTransaction(input: RunState, api: AgentApi, now: number): Promise<Next> {
  let state = input;
  const key = (step: string) => `${state.runId}:${step}`;
  const deadline = String(Math.floor(now / 1_000) + 10 * 60);
  let pool = await api.pool(state.poolId);
  const sides = poolSides(pool);

  if (!state.baseline) {
    const held = holdings(sides, await api.balances(state.poolId, "swap"));
    state = { ...state, baseline: { token: held.token.toString(), usdc: held.usdc.toString() } };
  }
  if (!state.done.includes("close")) {
    const { intentId } = await api.prepareWithdraw({ tokenId: state.tokenId, deadline, idempotencyKey: key("close") });
    return { state, step: "close", intentId };
  }
  // Closing only: the tokens are back in the wallet and nothing reopens.
  if (state.kind === "close") return "finished";

  if (!state.proceeds) {
    const returned = reinvestable(state, sides, await api.balances(state.poolId, "swap"));
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
    const balances = await api.balances(state.poolId, "swap");
    const available = usable(state, sides, balances);
    const swap = rebalanceSwap({ sqrtPriceX96: pool.sqrtPriceX96, ...ticks, tokenIsZero: sides.tokenIsZero, ...available });
    if (!swap || swap.amountIn <= 0n) {
      state = { ...state, done: [...state.done, "swap"] };
    } else {
      const tokenIn = swap.from === "usdc" ? sides.usdc : sides.token;
      const approval = await approvalFor(state, api, balances, "swap", tokenIn, swap.amountIn, now);
      if (approval) return approval;
      const quote = await api.quoteSwap({ poolId: state.poolId, tokenIn, amountIn: swap.amountIn.toString() });
      const { intentId } = await api.prepareSwap({ poolId: state.poolId, tokenIn, amountIn: swap.amountIn.toString(),
        minimumAmountOut: quote.minimumAmountOut, idempotencyKey: key("swap") });
      state = { ...state, swap: { from: swap.from, amountIn: swap.amountIn.toString(), expectedOut: quote.expectedAmountOut } };
      return { state, step: "swap", intentId };
    }
  }

  if (state.done.includes("mint")) return "finished";
  pool = await api.pool(state.poolId); // the swap moved the price
  const balances = await api.balances(state.poolId, "mint");
  const available = usable(state, sides, balances);
  const [limit0, limit1] = sides.tokenIsZero ? [available.token, available.usdc] : [available.usdc, available.token];
  if (limit0 <= 0n || limit1 <= 0n) throw new ApiCallError("NOTHING_TO_REOPEN", 422);
  const build = (amount0Desired: bigint, amount1Desired: bigint) => buildArcV4Mint({
    pool: { id: pool.address as Hex, currency0: getAddress(pool.token0), currency1: getAddress(pool.token1),
      fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: getAddress(pool.hooks ?? zeroAddress),
      sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, liquidity: pool.liquidity, lpFee: pool.lpFee ?? pool.fee },
    tokenDecimals: pool.token.decimals, recipient: state.walletAddress, ...ticks,
    amount0Desired, amount1Desired, slippageBps: SLIPPAGE_BPS, deadline: BigInt(deadline),
  });
  // The mint may take up to its slippage-adjusted maximums. Shrink it until those fit in what
  // may be used, so the slippage never comes out of the wallet's own money.
  let [amount0Desired, amount1Desired] = [limit0, limit1];
  let mint = build(amount0Desired, amount1Desired);
  for (let attempt = 0; attempt < 3 && (mint.amount0Max > limit0 || mint.amount1Max > limit1); attempt += 1) {
    const scale = (limit: bigint, maximum: bigint) => (maximum > limit ? (limit * 1_000_000n) / maximum : 1_000_000n);
    const factor = [scale(limit0, mint.amount0Max), scale(limit1, mint.amount1Max)].reduce((a, b) => (a < b ? a : b));
    [amount0Desired, amount1Desired] = [(amount0Desired * factor) / 1_000_000n, (amount1Desired * factor) / 1_000_000n];
    mint = build(amount0Desired, amount1Desired);
  }
  if (mint.amount0Max > limit0 || mint.amount1Max > limit1 || amount0Desired <= 0n || amount1Desired <= 0n) {
    throw new ApiCallError("NOTHING_TO_REOPEN", 422);
  }
  for (const [currency, maximum] of [[pool.token0, mint.amount0Max], [pool.token1, mint.amount1Max]] as const) {
    const approval = await approvalFor(state, api, balances, "mint", currency, (maximum * 102n + 99n) / 100n, now);
    if (approval) return approval;
  }
  const { intentId } = await api.prepareMint({ poolId: state.poolId, amount0Desired: amount0Desired.toString(),
    amount1Desired: amount1Desired.toString(), ...ticks, deadline, idempotencyKey: key("mint") });
  return { state, step: "mint", intentId };
}

type Sides = { token: string; usdc: string; tokenIsZero: boolean; usdcDecimals: number; native: boolean };

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

function holdings(sides: Sides, balances: Balances) {
  const balanceOf = (address: string) => BigInt(balances.allowances
    .find((entry) => entry.token.toLowerCase() === address.toLowerCase())?.balance ?? "0");
  return { token: balanceOf(sides.token), usdc: sides.native ? BigInt(balances.nativeBalance) : balanceOf(sides.usdc) };
}

/**
 * What came out of the closed position (net of fees so far). The wallet's own money stays
 * out, and so does enough USDC to leave the reserve in the wallet for the remaining fees.
 */
function reinvestable(state: RunState, sides: Sides, balances: Balances) {
  const held = holdings(sides, balances);
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
function usable(state: RunState, sides: Sides, balances: Balances) {
  const measured = reinvestable(state, sides, balances);
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

/**
 * The approval still needed before `amount` of `token` can be spent: the token's approval
 * to Permit2, then Permit2's to the router (swap) or position manager (mint). Each is for
 * the maximum, as the web app does. Native USDC needs none.
 */
async function approvalFor(state: RunState, api: AgentApi, balances: Balances, purpose: Purpose,
  token: string, amount: bigint, now: number): Promise<Next | null> {
  if (token.toLowerCase() === zeroAddress) return null;
  const allowance = balances.allowances.find((entry) => entry.token.toLowerCase() === token.toLowerCase());
  const soon = BigInt(Math.floor(now / 1_000) + 10 * 60);
  const stages = [
    { stage: "erc20" as const, short: !allowance || BigInt(allowance.erc20) < amount, amount: maxUint256 },
    { stage: "permit2" as const, short: !allowance || BigInt(allowance.permit2) < amount ||
      BigInt(allowance.expiration) <= soon, amount: maxUint160 },
  ];
  for (const { stage, short, amount: approved } of stages) {
    const step = `${purpose}-${stage}-${token.toLowerCase()}`;
    // Once confirmed, don't approve again even if a lagging read still shows the old allowance.
    if (!short || state.done.includes(step)) continue;
    const { intentId } = await api.prepareApproval({ poolId: state.poolId, token, stage, purpose,
      amount: approved.toString(), idempotencyKey: `${state.runId}:${step}` });
    return { state, step, intentId };
  }
  return null;
}
