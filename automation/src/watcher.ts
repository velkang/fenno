import type { Address, Hex } from "viem";
import {
  positionAmounts,
  readArcV4Pool,
  readArcV4Position,
  readArcV4PositionFees,
  tickToPrice,
  usdcValue,
  type ChainReadClient,
} from "@stillwater/chain";
import type { DecisionFacts } from "./decide/decision";
import { decide, type Decider } from "./decide/provider";
import type { RunPlan } from "./stepper";
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
export type WatchChain = Pick<ChainReadClient, "readContract"> & { getGasPrice(): Promise<bigint> };
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
      if (!trigger || !deps.deciders || worth < MIN_WORTH_USD) continue;

      const runs = await recentRuns(db, mandate.id, now);
      if (!shouldAsk({ memory, trigger, now, openRun: runs.open, lastRunFinishedAt: runs.lastFinishedAt,
        runsStartedToday: runs.startedToday, maxRunsPerDay: mandate.max_runs_per_day })) continue;

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
      const result = await decide(facts, deps.deciders.primary, deps.deciders.fallback);
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

  const tokenIsZero = pool.currency0.toLowerCase() === token.token_address.toLowerCase();
  const usdcDecimals = [pool.currency0, pool.currency1].some((currency) => /^0x0{40}$/i.test(currency))
    ? NATIVE_USDC_DECIMALS : 6;
  const usd = (raw0: bigint, raw1: bigint) => {
    const value = usdcValue({ pool, amount0: raw0, amount1: raw1 });
    return value ? Number(value.usdc) / 10 ** value.usdcDecimals : 0;
  };
  const priceUsd = tokenIsZero
    ? tickToPrice(pool.tick, token.token_decimals, usdcDecimals)
    : 1 / tickToPrice(pool.tick, usdcDecimals, token.token_decimals);
  const [minUsd, maxUsd] = tokenIsZero
    ? [tickToPrice(position.tickLower, token.token_decimals, usdcDecimals), tickToPrice(position.tickUpper, token.token_decimals, usdcDecimals)]
    : [1 / tickToPrice(position.tickUpper, usdcDecimals, token.token_decimals), 1 / tickToPrice(position.tickLower, usdcDecimals, token.token_decimals)];
  const held = positionAmounts(Number(position.liquidity), pool.sqrtPriceX96, position.tickLower, position.tickUpper);
  const [fees, gasPrice] = await Promise.all([
    readArcV4PositionFees({ client: chain, poolId: position.poolId, tokenId: position.tokenId,
      tickLower: position.tickLower, tickUpper: position.tickUpper }).catch(() => ({ amount0: 0n, amount1: 0n })),
    chain.getGasPrice().catch(() => 0n),
  ]);
  return {
    tokenId: position.tokenId.toString(),
    symbol: token.token_symbol,
    feeTierPercent: pool.lpFee / 10_000,
    priceUsd,
    minUsd,
    maxUsd,
    inBand: pool.tick >= position.tickLower && pool.tick < position.tickUpper,
    priceIs: (priceUsd < minUsd ? "below" : priceUsd > maxUsd ? "above" : "inside") as DecisionFacts["band"]["priceIs"],
    valueUsd: usd(BigInt(Math.floor(held.amount0)), BigInt(Math.floor(held.amount1))),
    feesUsd: usd(fees.amount0, fees.amount1),
    recentreCostUsd: Number(gasPrice * RECENTRE_GAS) / 10 ** NATIVE_USDC_DECIMALS,
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
