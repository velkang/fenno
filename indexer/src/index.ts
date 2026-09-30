import { arc, arcRpcTransport, type ChainReadClient } from "@stillwater/chain";
import { createPublicClient, getAddress, isAddress } from "viem";
import { D1PoolIndexerStore } from "./pool-store";
import { indexAlphaPool, type IndexerChainClient } from "./pool-indexer";
import { D1WalletIndexerStore } from "./wallet-store";
import { D1IndexerRunStore } from "./run-store";
import { runIndexer } from "./run";
import { discoverToken, refreshDirectory, runBackfillPass } from "./pool-discovery";
import { createDirectoryClient, DEFAULT_ARCHIVE_RPC_URL, DIRECTORIES, type IndexerEnv } from "./directories";
import { PoolDiscovery } from "./pool-discovery-object";
import { v3Directory } from "./pool-directory";
import { v4Directory } from "./v4-pool-directory";

// Each job runs on its own cron (see wrangler.jsonc) so it gets its own
// per-invocation budget. Live pool discovery runs every ~10 s in PoolDiscovery.
const DISCOVERY_CRON = "* * * * *"; // live loop check + v4 backfill
const V3_BACKFILL_CRON = "1-59/2 * * * *";
const REFRESH_CRON = "2-59/5 * * * *";
const REFRESH_LIMITS = { v4: 200, v3: 150 };

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
    if (controller.cron === DISCOVERY_CRON || controller.cron === V3_BACKFILL_CRON) {
      if (controller.cron === DISCOVERY_CRON) await ensureLiveDiscovery(env);
      const dir = controller.cron === DISCOVERY_CRON ? v4Directory : v3Directory;
      try {
        await runBackfillPass({ db: env.DB, dir, client: createDirectoryClient(env.ARC_RPC_URL),
          archive: createDirectoryClient(env.ARC_ARCHIVE_RPC_URL ?? DEFAULT_ARCHIVE_RPC_URL) });
      } catch (error) {
        console.warn(`${dir.name} pool backfill will resume next run`, error);
      }
      return;
    }
    if (controller.cron === REFRESH_CRON) {
      const client = createDirectoryClient(env.ARC_RPC_URL);
      for (const dir of DIRECTORIES) {
        try {
          await refreshDirectory({ db: env.DB, dir, client, limit: REFRESH_LIMITS[dir.name] });
        } catch (error) {
          console.warn(`${dir.name} pool refresh will resume next run`, error);
        }
      }
      return;
    }

    const client = createPublicClient({
      chain: arc,
      transport: arcRpcTransport(env.ARC_RPC_URL),
      batch: { multicall: true },
    }) as unknown as ChainReadClient & IndexerChainClient;
    const timestamp = Date.now();
    await env.DB.prepare(
      `UPDATE wallet_intents
       SET status = 'expired', failure_reason = 'INTENT_EXPIRED', updated_at = ?1
       WHERE status = 'pending' AND expires_at <= ?1`,
    ).bind(timestamp).run();
    await runIndexer({
      client,
      poolStore: new D1PoolIndexerStore(env.DB),
      walletStore: new D1WalletIndexerStore(env.DB),
      runStore: new D1IndexerRunStore(env.DB),
    });
  },
};

export {
  PoolDiscovery,
  D1PoolIndexerStore,
  D1WalletIndexerStore,
  D1IndexerRunStore,
  indexAlphaPool,
  runIndexer,
};
