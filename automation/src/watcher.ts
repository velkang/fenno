import type { Address, Hex } from "viem";
import {
  positionAmounts,
  readArcV4Pool,
  readArcV4Position,
  readArcV4PositionFees,
  readV3Positions,
  tickToPrice,
  usdcValue,
  type ChainReadClient,
} from "@stillwater/chain";
import type { DecisionFacts } from "./decide/decision";
import { decide, type Decider } from "./decide/provider";
import { isV3Pool, type RunPlan } from "./stepper";
import {
  HOUR,
  asked,
  emptyMemory,
  observe,
  priceAgo,
  shouldAsk,
  triggerFor,
  type MandateMemory,
} from "./watch";

// One look at every position a wallet has handed to the agent: read it, remember the price,
// and ask the model only when something calls for it. A decision to act becomes a proposal
// (ask-first) or a run that starts now (autopilot); the signer still checks every step.

export type WatchState = { memories: Record<string, MandateMemory> };
export type WatchChain = Pick<ChainReadClient, "readContract" | "simulateContract" | "getBalance"> &
  { getGasPrice(): Promise<bigint> };
export type Deciders = { primary: Decider; fallback?: Decider };
export type WatchResult = { state: WatchState; stop: boolean; start?: RunPlan };

type Mandate = {
  id: string;
  pool_id: Hex;
  mode: "ask" | "autopilot";
  band: "wide" | "balanced" | "narrow" | "agent";
  max_position_usd: number;
  max_runs_per_day: number;
};

const DAY = 24 * HOUR;
// Below this, a re-centre's fees cost more than the band holds: not worth asking the model.
const MIN_WORTH_USD = 1;
// A mandate the user set must cover the position with this much room, or reopening is refused.
const LIMIT_HEADROOM = 1.1;
// No run lasts this long (the stepper gives up after 30 minutes); one still "running" was lost.
const LOST_RUN_MS = HOUR;
// Rough gas for a whole re-centre (close, swap, approvals, reopen), to weigh against fees.
const RECENTRE_GAS = 1_500_000n;
const NATIVE_USDC_DECIMALS = 18;

export async function watchWallet(walletId: string, input: WatchState, deps: {
  db: D1Database;
  chain: WatchChain;
  deciders: Deciders | null;
  now: number;
  /** Takes one model call from today's budget; false once it's used up. */
  reserveCall?: () => Promise<boolean>;
}): Promise<WatchResult> {
  const { db, chain, now } = deps;
  const wallet = await db.prepare("SELECT id, address, state FROM managed_wallets WHERE id = ?1")
    .bind(walletId).first<{ id: string; address: Address; state: string }>();
  const mandates = wallet?.state === "active" ? (await db.prepare(
    `SELECT id, pool_id, mode, band, max_position_usd, max_runs_per_day FROM automation_mandates
     WHERE wallet_id = ?1 AND status = 'active'`,
  ).bind(walletId).all<Mandate>()).results ?? [] : [];
  if (!wallet || mandates.length === 0) return { state: { memories: {} }, stop: true };

  // Forget mandates that ended; keep the rest.
  const memories: Record<string, MandateMemory> = {};
  for (const mandate of mandates) memories[mandate.id] = input.memories[mandate.id] ?? emptyMemory();

  for (const mandate of mandates) {
    try {
      const look = await lookAt(mandate, wallet.address, walletId, deps);
      if (!look) continue;
      let memory = observe(memories[mandate.id]!, { now, price: look.priceUsd, inBand: look.inBand });
      memories[mandate.id] = memory;
      const trigger = triggerFor(memory, now);
      const worth = look.valueUsd + look.feesUsd;
      if (!trigger) continue;
      // Something called for a look: the logs say why the model wasn't asked, when it isn't.
      const notAsking = (why: Record<string, unknown>) => console.info("Automation not asking",
        JSON.stringify({ mandateId: mandate.id, poolId: mandate.pool_id, trigger, priceUsd: look.priceUsd, ...why }));
      if (!deps.deciders) { notAsking({ because: "no_provider" }); continue; }
      if (worth < MIN_WORTH_USD) { notAsking({ because: "worth_under_a_dollar", worthUsd: worth }); continue; }

      const runs = await recentRuns(db, mandate.id, now);
      if (!shouldAsk({ memory, trigger, now, openRun: runs.open, lastRunFinishedAt: runs.lastFinishedAt,
        runsStartedToday: runs.startedToday, maxRunsPerDay: mandate.max_runs_per_day })) {
        notAsking({ openRun: runs.open, runsStartedToday: runs.startedToday, maxRunsPerDay: mandate.max_runs_per_day,
          lastRunFinishedAt: runs.lastFinishedAt, lastAskedAt: memory.lastAskedAt, lastTrigger: memory.lastTrigger });
        continue;
      }

      const facts: DecisionFacts = {
        trigger,
        token: { symbol: look.symbol },
        feeTierPercent: look.feeTierPercent,
        priceUsd: look.priceUsd,
        band: { minUsd: look.minUsd, maxUsd: look.maxUsd, priceIs: look.priceIs },
        priceHistoryUsd: { "1h": priceAgo(memory, now, HOUR), "6h": priceAgo(memory, now, 6 * HOUR),
          "24h": priceAgo(memory, now, DAY) },
        position: { valueUsd: look.valueUsd, uncollectedFeesUsd: look.feesUsd },
        recentreCostUsd: look.recentreCostUsd,
        mandate: { mode: mandate.mode, band: mandate.band, maxPositionUsd: mandate.max_position_usd,
          runsLeftToday: Math.max(0, mandate.max_runs_per_day - runs.startedToday) },
      };
      const deciders = deps.reserveCall ? withBudget(deps.deciders, deps.reserveCall) : deps.deciders;
      const result = await decide(facts, deciders.primary, deciders.fallback);
      // Every answer is logged, holds included (they leave no other trace), with what the model saw.
      console.info("Automation decision", JSON.stringify({
        mandateId: mandate.id, poolId: mandate.pool_id, tokenId: look.tokenId, mode: mandate.mode, trigger,
        provider: result.provider, model: result.model,
        ...(result.decision ? { action: result.decision.action, band: result.decision.band,
          confidence: result.decision.confidence, reason: result.decision.reason } : { action: null, note: result.note }),
        priceUsd: look.priceUsd, minUsd: look.minUsd, maxUsd: look.maxUsd, priceIs: look.priceIs,
        valueUsd: look.valueUsd, feesUsd: look.feesUsd, recentreCostUsd: look.recentreCostUsd,
      }));
      // Out of calls for today: hold, and ask again once there are calls to spare.
      if (!result.decision && result.note === "daily_limit") continue;
      memory = asked(memory, trigger, now);
      memories[mandate.id] = memory;
      const decision = result.decision;
      if (!decision || decision.action === "hold") {
        if (!decision) console.warn("Automation got no usable decision; holding", mandate.id, result.provider, result.note);
        continue;
      }

      const kind = decision.action === "close" ? "close" : "rebalance";
      // The signer would refuse the new band after the old one was closed, leaving the money idle.
      if (kind === "rebalance" && worth * LIMIT_HEADROOM > mandate.max_position_usd) {
        console.warn("Automation won't re-centre a position worth more than its mandate allows", mandate.id);
        continue;
      }
      const band = mandate.band !== "agent" ? mandate.band : decision.band ?? "balanced";
      const runId = `run_${crypto.randomUUID()}`;
      const autopilot = mandate.mode === "autopilot";
      try {
        await db.prepare(
          `INSERT INTO automation_runs (id, mandate_id, kind, status, band, trigger, reason, provider, model,
             token_id, created_at, started_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?11)`,
        ).bind(runId, mandate.id, kind, autopilot ? "running" : "proposed", kind === "close" ? null : band,
          trigger, decision.reason, result.provider, result.model, look.tokenId, now, autopilot ? now : null).run();
      } catch (error) {
        // automation_runs_open: a proposal or run already exists for this mandate.
        console.warn("Automation could not record its decision", mandate.id, error);
        continue;
      }
      if (autopilot) {
        // One run per wallet at a time: start this one and look at the rest next time.
        return { state: { memories }, stop: false, start: { runId, walletId, walletAddress: wallet.address,
          mandateId: mandate.id, poolId: mandate.pool_id, tokenId: look.tokenId, band, kind, revokeMandate: false } };
      }
    } catch (error) {
      console.warn("Automation could not look at a position; trying again next time", mandate.id, error);
    }
  }
  return { state: { memories }, stop: false };
}

/** The mandate's live position (the newest one with liquidity) and its numbers in dollars. */
async function lookAt(mandate: Mandate, owner: Address, walletId: string, deps: { db: D1Database; chain: WatchChain }) {
  return isV3Pool(mandate.pool_id) ? lookAtV3(mandate, owner, deps) : lookAtV4(mandate, owner, walletId, deps);
}

async function lookAtV4(mandate: Mandate, owner: Address, walletId: string, deps: { db: D1Database; chain: WatchChain }) {
  const { db, chain } = deps;
  const ids = (await db.prepare(
    `SELECT vmi.token_id FROM wallet_intents wi JOIN v4_mint_intents vmi ON vmi.intent_id = wi.id
     WHERE wi.wallet_id = ?1 AND wi.status = 'confirmed' AND vmi.token_id IS NOT NULL
       AND lower(vmi.pool_id) = lower(?2)
     ORDER BY wi.created_at DESC LIMIT 10`,
  ).bind(walletId, mandate.pool_id).all<{ token_id: string }>()).results ?? [];
  let position: Awaited<ReturnType<typeof readArcV4Position>> | null = null;
  for (const { token_id } of ids) {
    try {
      const candidate = await readArcV4Position({ client: chain, tokenId: BigInt(token_id), owner });
      if (candidate.poolId.toLowerCase() === mandate.pool_id.toLowerCase() && candidate.liquidity > 0n) {
        position = candidate;
        break;
      }
    } catch {
      // Closed, burned or moved: not this wallet's position any more.
    }
  }
  if (!position) return null;
  const [pool, token] = await Promise.all([
    readArcV4Pool({ client: chain, key: position.poolKey }),
    db.prepare("SELECT token_address, token_symbol, token_decimals FROM v4_pool_directory WHERE pool_id = ?1")
      .bind(mandate.pool_id).first<{ token_address: Address; token_symbol: string; token_decimals: number }>(),
  ]);
  if (!pool || !token) return null;
  const [fees, gasPrice] = await Promise.all([
    readArcV4PositionFees({ client: chain, poolId: position.poolId, tokenId: position.tokenId,
      tickLower: position.tickLower, tickUpper: position.tickUpper }).catch(() => ({ amount0: 0n, amount1: 0n })),
    chain.getGasPrice().catch(() => 0n),
  ]);
  const native = [pool.currency0, pool.currency1].some((currency) => /^0x0{40}$/i.test(currency));
  return describe({ tokenId: position.tokenId.toString(), symbol: token.token_symbol,
    feeTierPercent: pool.lpFee / 10_000, pool, tokenIsZero: pool.currency0.toLowerCase() === token.token_address.toLowerCase(),
    tokenDecimals: token.token_decimals, usdcDecimals: native ? NATIVE_USDC_DECIMALS : 6,
    tickLower: position.tickLower, tickUpper: position.tickUpper, liquidity: position.liquidity, fees, gasPrice });
}

/** A v3 mandate's position: the newest one with liquidity that the wallet holds in that pool. */
async function lookAtV3(mandate: Mandate, owner: Address, deps: { db: D1Database; chain: WatchChain }) {
  const { db, chain } = deps;
  const listed = await db.prepare(
    `SELECT token_address, token_symbol, token_decimals, token0_address, token1_address, fee
     FROM pool_directory WHERE pool_address = ?1`,
  ).bind(mandate.pool_id).first<{ token_address: Address; token_symbol: string; token_decimals: number;
    token0_address: Address; token1_address: Address; fee: number }>();
  if (!listed) return null;
  const positions = await readV3Positions(chain, owner, { pools: [{ token0: listed.token0_address,
    token1: listed.token1_address, fee: listed.fee }] });
  const position = positions
    .filter((entry) => entry.pool.address.toLowerCase() === mandate.pool_id.toLowerCase() && BigInt(entry.liquidity) > 0n)
    .sort((a, b) => (BigInt(b.tokenId) > BigInt(a.tokenId) ? 1 : -1))[0];
  if (!position) return null;
  const gasPrice = await chain.getGasPrice().catch(() => 0n);
  const pool = { currency0: position.pool.token0, currency1: position.pool.token1,
    sqrtPriceX96: position.pool.sqrtPriceX96, tick: position.pool.tick };
  return describe({ tokenId: position.tokenId, symbol: listed.token_symbol, feeTierPercent: listed.fee / 10_000, pool,
    tokenIsZero: pool.currency0.toLowerCase() === listed.token_address.toLowerCase(),
    tokenDecimals: listed.token_decimals, usdcDecimals: 6, tickLower: position.tickLower, tickUpper: position.tickUpper,
    liquidity: BigInt(position.liquidity),
    fees: { amount0: BigInt(position.claimable0.raw), amount1: BigInt(position.claimable1.raw) }, gasPrice });
}

/** A position's numbers in dollars, the same for v3 and v4. */
function describe(input: { tokenId: string; symbol: string; feeTierPercent: number;
  pool: { currency0: Address; currency1: Address; sqrtPriceX96: string; tick: number }; tokenIsZero: boolean;
  tokenDecimals: number; usdcDecimals: number; tickLower: number; tickUpper: number; liquidity: bigint;
  fees: { amount0: bigint; amount1: bigint }; gasPrice: bigint }) {
  const { pool, tokenIsZero, tokenDecimals, usdcDecimals, tickLower, tickUpper } = input;
  const usd = (raw0: bigint, raw1: bigint) => {
    const value = usdcValue({ pool, amount0: raw0, amount1: raw1 });
    return value ? Number(value.usdc) / 10 ** value.usdcDecimals : 0;
  };
  const priceUsd = tokenIsZero
    ? tickToPrice(pool.tick, tokenDecimals, usdcDecimals)
    : 1 / tickToPrice(pool.tick, usdcDecimals, tokenDecimals);
  const [minUsd, maxUsd] = tokenIsZero
    ? [tickToPrice(tickLower, tokenDecimals, usdcDecimals), tickToPrice(tickUpper, tokenDecimals, usdcDecimals)]
    : [1 / tickToPrice(tickUpper, usdcDecimals, tokenDecimals), 1 / tickToPrice(tickLower, usdcDecimals, tokenDecimals)];
  const held = positionAmounts(Number(input.liquidity), pool.sqrtPriceX96, tickLower, tickUpper);
  return {
    tokenId: input.tokenId,
    symbol: input.symbol,
    feeTierPercent: input.feeTierPercent,
    priceUsd,
    minUsd,
    maxUsd,
    inBand: pool.tick >= tickLower && pool.tick < tickUpper,
    priceIs: (priceUsd < minUsd ? "below" : priceUsd > maxUsd ? "above" : "inside") as DecisionFacts["band"]["priceIs"],
    valueUsd: usd(BigInt(Math.floor(held.amount0)), BigInt(Math.floor(held.amount1))),
    feesUsd: usd(input.fees.amount0, input.fees.amount1),
    recentreCostUsd: Number(input.gasPrice * RECENTRE_GAS) / 10 ** NATIVE_USDC_DECIMALS,
  };
}

/** Whether a proposal or run is open, when the last one ended, and how many started today. */
async function recentRuns(db: D1Database, mandateId: string, now: number) {
  const [latest, started] = await Promise.all([
    db.prepare(
      `SELECT id, status, created_at, started_at, finished_at FROM automation_runs WHERE mandate_id = ?1
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(mandateId).first<{ id: string; status: string; created_at: number; started_at: number | null;
      finished_at: number | null }>(),
    db.prepare("SELECT COUNT(*) AS runs FROM automation_runs WHERE mandate_id = ?1 AND started_at >= ?2")
      .bind(mandateId, now - DAY).first<{ runs: number }>(),
  ]);
  let open = latest?.status === "proposed" || latest?.status === "running";
  // A proposal nobody answered within a day lapses, so the agent can look again.
  if (latest?.status === "proposed" && latest.created_at < now - DAY) {
    await db.prepare(
      `UPDATE automation_runs SET status = 'expired', finished_at = ?2, updated_at = ?2
       WHERE id = ?1 AND status = 'proposed'`,
    ).bind(latest.id, now).run();
    open = false;
  }
  // The watcher only runs while this wallet has no run in hand, so a long-"running" row was lost
  // (for example, the Worker restarted before it picked the run up).
  if (latest?.status === "running" && (latest.started_at ?? latest.created_at) < now - LOST_RUN_MS) {
    await db.prepare(
      `UPDATE automation_runs SET status = 'failed', failure_reason = 'RUN_LOST', finished_at = ?2, updated_at = ?2
       WHERE id = ?1 AND status = 'running'`,
    ).bind(latest.id, now).run();
    open = false;
  }
  return { open, lastFinishedAt: latest?.finished_at ?? null, startedToday: started?.runs ?? 0 };
}

/** Each provider call takes one call from the budget first, and is skipped when there is none. */
function withBudget(deciders: Deciders, reserve: () => Promise<boolean>): Deciders {
  const limited = (decider: Decider): Decider => ({
    ...decider,
    async decide(facts) {
      if (!(await reserve())) return { provider: decider.provider, model: decider.model, decision: null, note: "daily_limit" };
      return decider.decide(facts);
    },
  });
  return { primary: limited(deciders.primary), ...(deciders.fallback ? { fallback: limited(deciders.fallback) } : {}) };
}

/**
 * Counts a model call against today's (UTC) limit across all users, in one statement so
 * two wallets can't both take the last call. Nothing is written once the limit is reached.
 */
export async function reserveModelCall(db: D1Database, now: number, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const counted = await db.prepare(
    `INSERT INTO automation_model_calls (day, calls) VALUES (?1, 1)
     ON CONFLICT (day) DO UPDATE SET calls = calls + 1 WHERE calls < ?2
     RETURNING calls`,
  ).bind(new Date(now).toISOString().slice(0, 10), limit).first<{ calls: number }>();
  return counted !== null;
}
