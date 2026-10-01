import { getAddress, isAddress } from "viem";
import { discoverToken, refreshDirectory } from "./pool-discovery";
import { createDirectoryClient, DIRECTORIES, type IndexerEnv } from "./directories";
import { PoolDiscovery } from "./pool-discovery-object";

// Each job runs on its own cron (see wrangler.jsonc) so it gets its own
// per-invocation budget. Live pool discovery runs every ~10 s in PoolDiscovery.
const DISCOVERY_CRON = "* * * * *"; // keeps the live loop running
const REFRESH_CRON = "2-59/5 * * * *";
// Pools re-checked per run. Each v4 pool costs 2 chain calls and each v3 pool 3, and the RPC
// transport paces calls at 20 per 1.1 s with a 10 s request timeout, so a run must stay near
// 120 calls per protocol: larger slices time out and write nothing.
const REFRESH_LIMITS = { v4: 60, v3: 40 };
// At most how many of those may expire per run. A deleted pool costs about five row writes,
// so these caps (7,200 pools a day) keep clearing a backlog inside the daily budget while
// still outpacing the few thousand pools created each day.
const EXPIRE_LIMITS = { v4: 20, v3: 5 };

async function ensureLiveDiscovery(env: IndexerEnv) {
  const stub = env.DISCOVERY.get(env.DISCOVERY.idFromName("pools"));
  await stub.fetch("https://pool-discovery/ensure");
}

export default {
  // Reachable only through service bindings: the Worker has no routes or workers.dev URL.
  async fetch(request: Request, env: IndexerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/internal/v1/pools/discover") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const body = await request.json().catch(() => null) as { tokenAddress?: unknown } | null;
    if (typeof body?.tokenAddress !== "string" || !isAddress(body.tokenAddress)) {
      return Response.json({ error: "INVALID_TOKEN_ADDRESS" }, { status: 400 });
    }
    try {
      const found = await discoverToken({ db: env.DB, dirs: DIRECTORIES,
        client: createDirectoryClient(env.ARC_RPC_URL), token: getAddress(body.tokenAddress) });
      return Response.json({ found });
    } catch (error) {
      console.error("Token pool discovery failed", body.tokenAddress, error);
      return Response.json({ error: "DISCOVERY_FAILED" }, { status: 502 });
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: IndexerEnv,
    _context: ExecutionContext,
  ): Promise<void> {
    if (controller.cron === DISCOVERY_CRON) {
      await ensureLiveDiscovery(env);
      return;
    }
    if (controller.cron === REFRESH_CRON) {
      const client = createDirectoryClient(env.ARC_RPC_URL);
      for (const dir of DIRECTORIES) {
        try {
          await refreshDirectory({ db: env.DB, dir, client, limit: REFRESH_LIMITS[dir.name],
            expireLimit: EXPIRE_LIMITS[dir.name] });
        } catch (error) {
          console.warn(`${dir.name} pool refresh will resume next run`, error);
        }
      }
      return;
    }

    // Every 5 minutes: approved actions nobody confirmed in time stop being usable.
    const timestamp = Date.now();
    await env.DB.prepare(
      `UPDATE wallet_intents
       SET status = 'expired', failure_reason = 'INTENT_EXPIRED', updated_at = ?1
       WHERE status = 'pending' AND expires_at <= ?1`,
    ).bind(timestamp).run();
  },
};

export { PoolDiscovery };
