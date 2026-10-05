import { createPublicClient } from "viem";
import { arc, arcRpcTransport } from "@stillwater/chain";
import { agentApi } from "./agent-api";
import { decidersFromEnv, type DeciderEnv } from "./decide/provider";
import { advance, startState, type Outcome, type RunPlan, type RunState } from "./stepper";
import { WATCH_MS } from "./watch";
import { watchWallet, type WatchChain, type WatchState } from "./watcher";

const FINISH_RETRY_MS = 60_000;

export type AutomationEnv = DeciderEnv & {
  DB: D1Database;
  ARC_RPC_URL?: string;
  // The Stillwater API, called as the agent for one run.
  API: Fetcher;
  AGENT_SECRET?: string;
  RUNS: DurableObjectNamespace;
};

/**
 * One per wallet, so a wallet has at most one run going. The run's state lives in this
 * object's storage; an alarm moves it on one step at a time, and picks it up again after
 * a restart. Between runs, while the wallet has an active mandate, the same alarm watches
 * its positions every few minutes.
 */
export class WalletAutomation {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: AutomationEnv,
    // Tests replace the watch; the runtime passes only the first two arguments.
    private readonly deps: { watch?: typeof watchWallet } = {},
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/watch") {
      const { walletId } = await request.json() as { walletId: string };
      await this.ctx.storage.put({ walletId, watching: true });
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ watching: true }, { status: 202 });
    }
    if (request.method !== "POST" || path !== "/start") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (await this.ctx.storage.get<RunState>("run")) {
      return Response.json({ error: "RUN_IN_PROGRESS" }, { status: 409 });
    }
    const plan = await request.json() as RunPlan;
    await this.ctx.storage.put({ walletId: plan.walletId, run: startState(plan, Date.now()) });
    await this.ctx.storage.setAlarm(Date.now());
    return Response.json({ started: true }, { status: 202 });
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RunState>("run");
    if (!state) return this.watch();
    const outcome: Outcome = state.finished ?? (this.env.AGENT_SECRET
      ? await advance(state, agentApi(this.env.API, this.env.AGENT_SECRET, state.runId), Date.now())
      : { kind: "failed", reason: "AUTOMATION_NOT_CONFIGURED" });
    if (outcome.kind === "wait") {
      await this.ctx.storage.put("run", outcome.state);
      await this.ctx.storage.setAlarm(Date.now() + outcome.delayMs);
      return;
    }
    try {
      await finishRun(this.env.DB, state, outcome, Date.now());
    } catch (error) {
      // Keep the ending and record it on a later try; until then this wallet can't start another run.
      console.error("Recording the end of an automation run failed", state.runId, error);
      await this.ctx.storage.put("run", { ...state, finished: outcome });
      await this.ctx.storage.setAlarm(Date.now() + FINISH_RETRY_MS);
      return;
    }
    await this.ctx.storage.delete("run");
    if (await this.ctx.storage.get("watching")) await this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
  }

  /** One look at the wallet's mandated positions; an autopilot decision starts a run at once. */
  private async watch(): Promise<void> {
    const [watching, walletId, previous] = await Promise.all([
      this.ctx.storage.get<boolean>("watching"),
      this.ctx.storage.get<string>("walletId"),
      this.ctx.storage.get<WatchState>("watch"),
    ]);
    if (!watching || !walletId) return;
    const now = Date.now();
    try {
      const chain = createPublicClient({ chain: arc, transport: arcRpcTransport(this.env.ARC_RPC_URL),
        batch: { multicall: true } }) as unknown as WatchChain;
      const watch = this.deps.watch ?? watchWallet;
      const result = await watch(walletId, previous ?? { memories: {} },
        { db: this.env.DB, chain, deciders: decidersFromEnv(this.env), now });
      if (result.stop) {
        // No active mandate left: stop until one is set again.
        await this.ctx.storage.delete(["watching", "watch"]);
        return;
      }
      await this.ctx.storage.put("watch", result.state);
      // Deciding can take a while; a run may have been started meanwhile (by hand or an
      // approval). That run goes first: drop the watch's own and leave its alarm alone.
      if (await this.ctx.storage.get<RunState>("run")) {
        if (result.start) {
          await finishRun(this.env.DB, result.start, { kind: "failed", reason: "RUN_IN_PROGRESS" }, now)
            .catch((error: unknown) => console.error("Dropping an automation run failed", result.start?.runId, error));
        }
        return;
      }
      if (result.start) {
        await this.ctx.storage.put("run", startState(result.start, now));
        await this.ctx.storage.setAlarm(now);
        return;
      }
    } catch (error) {
      console.error("Automation watch failed; looking again later", walletId, error);
    }
    await this.ctx.storage.setAlarm(now + WATCH_MS);
  }
}

/** Records how the run ended. A mandate made just for this run ends with it. */
export async function finishRun(db: D1Database, plan: RunPlan,
  outcome: Exclude<Outcome, { kind: "wait" }>, now: number): Promise<void> {
  const statements = [db.prepare(
    `UPDATE automation_runs SET status = ?2, failure_reason = ?3, finished_at = ?4, updated_at = ?4
     WHERE id = ?1 AND status = 'running'`,
  ).bind(plan.runId, outcome.kind === "done" ? "done" : "failed",
    outcome.kind === "failed" ? outcome.reason : null, now)];
  if (plan.revokeMandate) {
    statements.push(db.prepare(
      "UPDATE automation_mandates SET status = 'revoked', updated_at = ?2 WHERE id = ?1 AND status != 'revoked'",
    ).bind(plan.mandateId, now));
  }
  await db.batch(statements);
}
