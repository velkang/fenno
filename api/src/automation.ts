import type { Context, Hono } from "hono";
import type { Address, Hex } from "viem";
import {
  positionAmounts,
  readArcV4Pool,
  readArcV4Position,
  readArcV4PositionFees,
  usdcValue,
  type ChainReadClient,
} from "@stillwater/chain";
import { AuthError } from "./auth";
import type { AppEnvironment, Bindings } from "./index";

// The automation Worker calls the API with this secret and the run it is working on.
export const AGENT_SECRET_HEADER = "x-stillwater-agent";
export const AGENT_RUN_HEADER = "x-stillwater-run";

/** The run an agent request belongs to. Set only for requests from the automation Worker. */
export type AgentRun = { id: string; mandateId: string; poolId: Hex; walletId: string };

const DAY_MS = 24 * 60 * 60 * 1_000;

// Everything the agent may call: reading and working a v4 position. Withdrawals, wallet
// settings and mandates are deliberately absent; the signer checks every request again.
const AGENT_ROUTES: Array<[method: string, path: RegExp]> = [
  ["GET", /^\/v1\/wallets\/v4\/positions$/],
  ["GET", /^\/v1\/wallets\/v4\/pools\/0x[0-9a-fA-F]{64}\/allowances$/],
  ["POST", /^\/v1\/wallets\/v4\/swaps\/(quote|prepare)$/],
  ["POST", /^\/v1\/wallets\/v4\/approvals\/prepare$/],
  ["POST", /^\/v1\/wallets\/v4\/positions\/(mint|actions)\/prepare$/],
  ["POST", /^\/v1\/wallets\/intents\/[A-Za-z0-9_-]+\/execute$/],
  ["POST", /^\/v1\/wallets\/attempts\/[A-Za-z0-9_-]+\/reconcile$/],
];

async function sameSecret(given: string, expected: string): Promise<boolean> {
  // Compare digests so the time taken says nothing about the secret.
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

/**
 * Lets the automation Worker act for one wallet, as that wallet's user, on the routes
 * above and only while its run is running under an active mandate. Requests without
 * the agent header pass through to the normal session check.
 */
export function agentIdentity() {
  return async (context: Context<AppEnvironment>, next: () => Promise<void>) => {
    const secret = context.req.header(AGENT_SECRET_HEADER);
    if (secret === undefined) return next();
    const expected = context.env.AGENT_SECRET;
    if (!expected || !(await sameSecret(secret, expected))) {
      return context.json({ error: "UNAUTHENTICATED" }, 401);
    }
    const path = new URL(context.req.url).pathname;
    if (!AGENT_ROUTES.some(([method, pattern]) => method === context.req.method && pattern.test(path))) {
      return context.json({ error: "AGENT_ROUTE_NOT_ALLOWED" }, 403);
    }
    const runId = context.req.header(AGENT_RUN_HEADER) ?? "";
    const run = await context.env.DB.prepare(
      `SELECT ar.id, ar.status AS run_status, am.id AS mandate_id, am.status AS mandate_status,
              am.pool_id, mw.id AS wallet_id, mw.user_id, u.owner_address
       FROM automation_runs ar
       JOIN automation_mandates am ON am.id = ar.mandate_id
       JOIN managed_wallets mw ON mw.id = am.wallet_id
       JOIN users u ON u.id = mw.user_id
       WHERE ar.id = ?1`,
    ).bind(runId).first<{ id: string; run_status: string; mandate_id: string; mandate_status: string;
      pool_id: Hex; wallet_id: string; user_id: string; owner_address: Address }>();
    if (!run || run.run_status !== "running" || run.mandate_status !== "active") {
      return context.json({ error: "MANDATE_RUN_NOT_RUNNING" }, 403);
    }
    context.set("user", { id: run.user_id, ownerAddress: run.owner_address });
    context.set("agentRun", { id: run.id, mandateId: run.mandate_id, poolId: run.pool_id, walletId: run.wallet_id });
    await next();
  };
}

type MandateRow = {
  id: string;
  pool_id: Hex;
  mode: string;
  status: string;
  band: string;
  max_position_usd: number;
  max_runs_per_day: number;
  created_at: number;
  updated_at: number;
};

type RunRow = {
  id: string;
  mandate_id: string;
  pool_id: Hex;
  kind: string;
  status: string;
  band: string | null;
  trigger: string;
  reason: string | null;
  provider: string | null;
  model: string | null;
  failure_reason: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

const publicMandate = (row: MandateRow) => ({
  id: row.id, poolId: row.pool_id, mode: row.mode, status: row.status, band: row.band,
  maxPositionUsd: row.max_position_usd, maxRunsPerDay: row.max_runs_per_day,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const publicRun = (row: RunRow) => ({
  id: row.id, mandateId: row.mandate_id, poolId: row.pool_id, kind: row.kind, status: row.status,
  band: row.band, trigger: row.trigger, reason: row.reason, provider: row.provider, model: row.model,
  failureReason: row.failure_reason, createdAt: row.created_at, startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const MANDATE_FIELDS = `id, pool_id, mode, status, band, max_position_usd, max_runs_per_day,
  created_at, updated_at`;

function parseMandate(body: Record<string, unknown>) {
  const { poolId, mode, band, maxPositionUsd, maxRunsPerDay, status = "active" } = body;
  const whole = (value: unknown, min: number, max: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
  if (
    typeof poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(poolId) ||
    (mode !== "ask" && mode !== "autopilot") ||
    (band !== "wide" && band !== "balanced" && band !== "narrow" && band !== "agent") ||
    !whole(maxPositionUsd, 1, 1_000_000) || !whole(maxRunsPerDay, 1, 24) ||
    (status !== "active" && status !== "paused")
  ) throw new AuthError("INVALID_MANDATE", 400);
  return { poolId: poolId.toLowerCase() as Hex, mode, band, maxPositionUsd: maxPositionUsd as number,
    maxRunsPerDay: maxRunsPerDay as number, status };
}

// A mandate made just for one hand-started re-centre: ask-first, one run, a limit a little
// above the position's value so the reopened band fits even if the price rises meanwhile.
const ONE_OFF_HEADROOM = 1.25;
// A mandate the user set must cover the position with at least this much room.
const OWN_MANDATE_HEADROOM = 1.1;
// Below this, the network fees of closing, swapping and reopening cost more than the band holds.
const MIN_RECENTRE_USD = 1;

/** The signed-in user's mandates and runs. Session only: the agent can't reach these. */
export function registerAutomationRoutes(
  app: Hono<AppEnvironment>,
  now: () => number,
  chainClient: (env: Bindings) => ChainReadClient,
) {
  const walletOf = async (context: Context<AppEnvironment>) => {
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    ).bind(context.get("user").id).first<{ id: string; address: Address; state: string }>();
    if (!wallet) throw new AuthError("WALLET_NOT_FOUND", 404);
    return wallet;
  };

  // Asks the automation Worker to start a run now; false when it couldn't.
  const startRun = async (context: Context<AppEnvironment>, plan: Record<string, unknown>) => {
    const started = await context.env.AUTOMATION?.fetch(new Request(
      "https://stillwater-automation/internal/v1/runs/start",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plan) },
    )).catch(() => null);
    return started ?? null;
  };

  app.get("/v1/automation/mandates", async (context) => {
    const wallet = await walletOf(context);
    const rows = await context.env.DB.prepare(
      `SELECT ${MANDATE_FIELDS} FROM automation_mandates
       WHERE wallet_id = ?1 AND status != 'revoked' ORDER BY created_at DESC`,
    ).bind(wallet.id).all<MandateRow>();
    return context.json({ mandates: (rows.results ?? []).map(publicMandate) });
  });

  // Creates the wallet's mandate for a pool, or changes the one it has.
  app.put("/v1/automation/mandates", async (context) => {
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new AuthError("INVALID_MANDATE", 400);
    const mandate = parseMandate(body);
    const wallet = await walletOf(context);
    const pool = await context.env.DB.prepare(
      "SELECT pool_id FROM v4_pool_directory WHERE pool_id = ?1",
    ).bind(mandate.poolId).first<{ pool_id: string }>();
    if (!pool) return context.json({ error: "POOL_NOT_FOUND" }, 404);
    const timestamp = now();
    await context.env.DB.prepare(
      `INSERT INTO automation_mandates (id, wallet_id, pool_id, mode, status, band,
         max_position_usd, max_runs_per_day, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT (wallet_id, pool_id) WHERE status != 'revoked' DO UPDATE SET
         mode = excluded.mode, status = excluded.status, band = excluded.band,
         max_position_usd = excluded.max_position_usd,
         max_runs_per_day = excluded.max_runs_per_day, updated_at = excluded.updated_at`,
    ).bind(`mandate_${crypto.randomUUID()}`, wallet.id, mandate.poolId, mandate.mode, mandate.status,
      mandate.band, mandate.maxPositionUsd, mandate.maxRunsPerDay, timestamp).run();
    const saved = await context.env.DB.prepare(
      `SELECT ${MANDATE_FIELDS} FROM automation_mandates
       WHERE wallet_id = ?1 AND pool_id = ?2 AND status != 'revoked'`,
    ).bind(wallet.id, mandate.poolId).first<MandateRow>();
    if (!saved) throw new Error("Mandate was not saved");
    // The wallet's automation starts (or keeps) watching its positions. It stops by itself once
    // no mandate is active, so a failed wake only delays the first look until the next save.
    if (saved.status === "active") {
      await context.env.AUTOMATION?.fetch(new Request("https://stillwater-automation/internal/v1/wallets/watch", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletId: wallet.id }),
      })).catch((error: unknown) => console.warn("Waking the automation watcher failed", wallet.id, error));
    }
    return context.json({ mandate: publicMandate(saved) });
  });

  // Ends a mandate. A proposal waiting on it is declined; a run in progress is stopped by
  // the signer, which refuses its next step.
  app.delete("/v1/automation/mandates/:mandateId", async (context) => {
    const wallet = await walletOf(context);
    const mandateId = context.req.param("mandateId");
    const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE automation_mandates SET status = 'revoked', updated_at = ?3
         WHERE id = ?1 AND wallet_id = ?2 AND status != 'revoked'`,
      ).bind(mandateId, wallet.id, timestamp),
      context.env.DB.prepare(
        `UPDATE automation_runs SET status = 'declined', finished_at = ?2, updated_at = ?2
         WHERE mandate_id = ?1 AND status = 'proposed'`,
      ).bind(mandateId, timestamp),
    ]);
    return context.json({ revoked: true });
  });

  app.get("/v1/automation/runs", async (context) => {
    const wallet = await walletOf(context);
    const rows = await context.env.DB.prepare(
      `SELECT ar.id, ar.mandate_id, am.pool_id, ar.kind, ar.status, ar.band, ar.trigger, ar.reason,
              ar.provider, ar.model, ar.failure_reason, ar.created_at, ar.started_at, ar.finished_at
       FROM automation_runs ar JOIN automation_mandates am ON am.id = ar.mandate_id
       WHERE am.wallet_id = ?1 ORDER BY ar.created_at DESC LIMIT 20`,
    ).bind(wallet.id).all<RunRow>();
    return context.json({ runs: (rows.results ?? []).map(publicRun) });
  });

  // Re-centres one of the wallet's v4 positions now, at the band the user picked.
  app.post("/v1/automation/runs", async (context) => {
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const band = body?.band;
    if (typeof body?.tokenId !== "string" || !/^[1-9][0-9]{0,77}$/.test(body.tokenId) ||
        (band !== "wide" && band !== "balanced" && band !== "narrow")) {
      throw new AuthError("INVALID_RUN", 400);
    }
    const tokenId = body.tokenId;
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    ).bind(context.get("user").id).first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active") return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    const automation = context.env.AUTOMATION;
    if (!automation) return context.json({ error: "AUTOMATION_UNAVAILABLE" }, 503);

    // What the position is worth now, to size (or check) the mandate the signer will hold it to.
    const client = chainClient(context.env);
    let position;
    try {
      position = await readArcV4Position({ client, tokenId: BigInt(tokenId), owner: wallet.address });
    } catch {
      return context.json({ error: "V4_POSITION_NOT_OWNED" }, 404);
    }
    if (position.liquidity <= 0n) return context.json({ error: "POSITION_EMPTY" }, 422);
    const listed = await context.env.DB.prepare("SELECT pool_id FROM v4_pool_directory WHERE pool_id = ?1")
      .bind(position.poolId.toLowerCase()).first<{ pool_id: Hex }>();
    if (!listed) return context.json({ error: "POOL_NOT_ELIGIBLE" }, 404);
    const pool = await readArcV4Pool({ client, key: position.poolKey });
    if (!pool) return context.json({ error: "POOL_NOT_AVAILABLE" }, 422);
    const amounts = positionAmounts(Number(position.liquidity), pool.sqrtPriceX96,
      position.tickLower, position.tickUpper);
    // The close also collects uncollected fees, and the new band holds those too. A fee read
    // that fails counts as none; the mandate's headroom covers small amounts.
    const fees = await readArcV4PositionFees({ client, poolId: position.poolId, tokenId: BigInt(tokenId),
      tickLower: position.tickLower, tickUpper: position.tickUpper }).catch(() => ({ amount0: 0n, amount1: 0n }));
    const value = usdcValue({ pool, amount0: BigInt(Math.floor(amounts.amount0)) + fees.amount0,
      amount1: BigInt(Math.floor(amounts.amount1)) + fees.amount1 });
    if (!value) return context.json({ error: "POOL_NOT_ELIGIBLE" }, 422);
    const valueUsd = Number(value.usdc) / 10 ** value.usdcDecimals;
    if (valueUsd < MIN_RECENTRE_USD) return context.json({ error: "POSITION_TOO_SMALL" }, 422);

    const poolId = listed.pool_id;
    const timestamp = now();
    const own = await context.env.DB.prepare(
      `SELECT id, status, max_position_usd, max_runs_per_day FROM automation_mandates
       WHERE wallet_id = ?1 AND pool_id = ?2 AND status != 'revoked'`,
    ).bind(wallet.id, poolId).first<{ id: string; status: string; max_position_usd: number;
      max_runs_per_day: number }>();
    if (own) {
      if (own.status !== "active") return context.json({ error: "MANDATE_NOT_ACTIVE" }, 409);
      if (own.max_position_usd < valueUsd * OWN_MANDATE_HEADROOM) {
        return context.json({ error: "MANDATE_LIMIT_TOO_LOW" }, 409);
      }
      const started = await context.env.DB.prepare(
        "SELECT COUNT(*) AS runs FROM automation_runs WHERE mandate_id = ?1 AND started_at >= ?2",
      ).bind(own.id, timestamp - DAY_MS).first<{ runs: number }>();
      if ((started?.runs ?? 0) >= own.max_runs_per_day) {
        return context.json({ error: "MANDATE_DAILY_LIMIT_REACHED" }, 409);
      }
    }
    const mandateId = own?.id ?? `mandate_${crypto.randomUUID()}`;
    const runId = `run_${crypto.randomUUID()}`;
    const statements = own ? [] : [context.env.DB.prepare(
      `INSERT INTO automation_mandates (id, wallet_id, pool_id, mode, band, max_position_usd,
         max_runs_per_day, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8)`,
    ).bind(mandateId, wallet.id, poolId, "ask", band, Math.ceil(valueUsd * ONE_OFF_HEADROOM) + 1, 1, timestamp)];
    statements.push(context.env.DB.prepare(
      `INSERT INTO automation_runs (id, mandate_id, kind, status, band, trigger, token_id, created_at, started_at, updated_at)
       VALUES (?1, ?2, 'rebalance', 'running', ?3, 'user', ?4, ?5, ?5, ?5)`,
    ).bind(runId, mandateId, band, tokenId, timestamp));
    try {
      await context.env.DB.batch(statements);
    } catch {
      // Only one run per mandate at a time (automation_runs_open).
      return context.json({ error: "RUN_IN_PROGRESS" }, 409);
    }

    const plan = { runId, walletId: wallet.id, walletAddress: wallet.address, mandateId, poolId, tokenId,
      kind: "rebalance", band, revokeMandate: !own };
    const started = await startRun(context, plan);
    if (!started?.ok) {
      const reason = started?.status === 409 ? "RUN_IN_PROGRESS" : "AUTOMATION_UNAVAILABLE";
      // Nothing ran, so it doesn't count against the mandate's runs for the day.
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE automation_runs SET status = 'failed', failure_reason = ?2, started_at = NULL,
             finished_at = ?3, updated_at = ?3
           WHERE id = ?1 AND status = 'running'`,
        ).bind(runId, reason, timestamp),
        ...(own ? [] : [context.env.DB.prepare(
          "UPDATE automation_mandates SET status = 'revoked', updated_at = ?2 WHERE id = ?1",
        ).bind(mandateId, timestamp)]),
      ]).catch((error: unknown) => console.error("Cleaning up an automation run that never started failed", runId, error));
      return context.json({ error: reason }, reason === "RUN_IN_PROGRESS" ? 409 : 503);
    }
    return context.json({ run: { id: runId, mandateId, poolId, kind: "rebalance", status: "running", band,
      trigger: "user", startedAt: timestamp } }, 201);
  });

  // The user says yes to something the agent proposed (ask-first mode).
  app.post("/v1/automation/runs/:runId/approve", async (context) => {
    const wallet = await walletOf(context);
    const runId = context.req.param("runId");
    const run = await context.env.DB.prepare(
      `SELECT ar.id, ar.status, ar.created_at, ar.kind, ar.band, ar.token_id, am.id AS mandate_id,
              am.status AS mandate_status, am.max_runs_per_day, am.pool_id
       FROM automation_runs ar JOIN automation_mandates am ON am.id = ar.mandate_id
       WHERE ar.id = ?1 AND am.wallet_id = ?2`,
    ).bind(runId, wallet.id).first<{ id: string; status: string; created_at: number; kind: string;
      band: string | null; token_id: string | null; mandate_id: string; mandate_status: string;
      max_runs_per_day: number; pool_id: Hex }>();
    if (!run) return context.json({ error: "RUN_NOT_FOUND" }, 404);
    if (run.status !== "proposed") return context.json({ error: "RUN_NOT_PROPOSED" }, 409);
    if (wallet.state !== "active") return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    const timestamp = now();
    if (run.created_at + DAY_MS < timestamp) {
      await context.env.DB.prepare(
        `UPDATE automation_runs SET status = 'expired', finished_at = ?2, updated_at = ?2
         WHERE id = ?1 AND status = 'proposed'`,
      ).bind(run.id, timestamp).run();
      return context.json({ error: "RUN_EXPIRED" }, 409);
    }
    if (run.mandate_status !== "active") return context.json({ error: "MANDATE_NOT_ACTIVE" }, 409);
    const started = await context.env.DB.prepare(
      "SELECT COUNT(*) AS runs FROM automation_runs WHERE mandate_id = ?1 AND started_at >= ?2",
    ).bind(run.mandate_id, timestamp - DAY_MS).first<{ runs: number }>();
    if ((started?.runs ?? 0) >= run.max_runs_per_day) {
      return context.json({ error: "MANDATE_DAILY_LIMIT_REACHED" }, 409);
    }
    if (!context.env.AUTOMATION || !run.token_id) return context.json({ error: "AUTOMATION_UNAVAILABLE" }, 503);
    const claimed = await context.env.DB.prepare(
      `UPDATE automation_runs SET status = 'running', started_at = ?2, updated_at = ?2
       WHERE id = ?1 AND status = 'proposed'`,
    ).bind(run.id, timestamp).run();
    // Two approvals at once: only the one that moved it to running starts it.
    if (claimed.meta.changes !== 1) return context.json({ error: "RUN_NOT_PROPOSED" }, 409);
    const begun = await startRun(context, { runId: run.id, walletId: wallet.id, walletAddress: wallet.address,
      mandateId: run.mandate_id, poolId: run.pool_id, tokenId: run.token_id, kind: run.kind,
      band: run.band ?? "balanced", revokeMandate: false });
    if (begun?.status === 409) {
      // Another run holds the wallet; the suggestion stays open to approve once it's done.
      await context.env.DB.prepare(
        `UPDATE automation_runs SET status = 'proposed', started_at = NULL, updated_at = ?2
         WHERE id = ?1 AND status = 'running'`,
      ).bind(run.id, timestamp).run().catch((error: unknown) =>
        console.error("Reopening a suggestion that couldn't start failed", run.id, error));
      return context.json({ error: "RUN_IN_PROGRESS" }, 409);
    }
    if (!begun?.ok) {
      await context.env.DB.prepare(
        `UPDATE automation_runs SET status = 'failed', failure_reason = 'AUTOMATION_UNAVAILABLE', started_at = NULL,
           finished_at = ?2, updated_at = ?2
         WHERE id = ?1 AND status = 'running'`,
      ).bind(run.id, timestamp).run().catch((error: unknown) =>
        console.error("Cleaning up an approved run that never started failed", run.id, error));
      return context.json({ error: "AUTOMATION_UNAVAILABLE" }, 503);
    }
    return context.json({ runId: run.id, status: "running" });
  });

  app.post("/v1/automation/runs/:runId/decline", async (context) => {
    const wallet = await walletOf(context);
    const timestamp = now();
    await context.env.DB.prepare(
      `UPDATE automation_runs SET status = 'declined', finished_at = ?3, updated_at = ?3
       WHERE id = ?1 AND status = 'proposed'
         AND mandate_id IN (SELECT id FROM automation_mandates WHERE wallet_id = ?2)`,
    ).bind(context.req.param("runId"), wallet.id, timestamp).run();
    return context.json({ runId: context.req.param("runId"), status: "declined" });
  });
}
