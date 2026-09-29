import { arc, arcRpcTransport, type ChainReadClient } from "@stillwater/chain";
import { createPublicClient } from "viem";
import { D1PoolIndexerStore } from "./pool-store";
import { indexAlphaPool, type IndexerChainClient } from "./pool-indexer";
import { D1WalletIndexerStore } from "./wallet-store";
import { D1IndexerRunStore } from "./run-store";
import { runIndexer } from "./run";
import { indexPoolDirectory } from "./pool-directory";
import { indexV4PoolDirectory } from "./v4-pool-directory";

type Bindings = {
  DB: D1Database;
  // Optional override; without it, Arc's default public RPC is used.
  ARC_RPC_URL?: string;
};

// Each job runs on its own cron (see wrangler.jsonc) so it gets its own
// free-plan budget of 50 subrequests and 10 ms CPU.
const V3_DIRECTORY_CRON = "1-59/5 * * * *";
const V4_DIRECTORY_CRON = "2-59/5 * * * *";

export default {
  async scheduled(
    controller: ScheduledController,
    env: Bindings,
    _context: ExecutionContext,
  ): Promise<void> {
    const client = createPublicClient({
      chain: arc,
      transport: arcRpcTransport(env.ARC_RPC_URL),
      batch: { multicall: true },
    }) as unknown as ChainReadClient & IndexerChainClient;

    if (controller.cron === V3_DIRECTORY_CRON) {
      try {
        await indexPoolDirectory({ client: client as unknown as Parameters<typeof indexPoolDirectory>[0]["client"], db: env.DB });
      } catch (error) {
        console.warn("Pool directory indexing will resume next run", error);
      }
      return;
    }
    if (controller.cron === V4_DIRECTORY_CRON) {
      try {
        await indexV4PoolDirectory({ client: client as unknown as Parameters<typeof indexV4PoolDirectory>[0]["client"], db: env.DB });
      } catch (error) {
        console.warn("V4 pool directory indexing will resume next run", error);
      }
      return;
    }

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
  D1PoolIndexerStore,
  D1WalletIndexerStore,
  D1IndexerRunStore,
  indexAlphaPool,
  runIndexer,
};
