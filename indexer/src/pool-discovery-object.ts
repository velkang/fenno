import { runLivePass, type LivePosition } from "./pool-discovery";
import { createDirectoryClient, DIRECTORIES, type IndexerEnv } from "./directories";

// Cron triggers fire at most once a minute, so the live pass runs from this Durable
// Object's alarm instead: every TICK_MS, rescheduled even when a tick fails. The
// minute cron calls /ensure, which restarts the loop if no alarm is set, or if one is set
// but no tick has run for STALLED_MS (an alarm stuck that way stopped the loop for weeks).
const TICK_MS = 10_000;
const STALLED_MS = 60_000;

export class PoolDiscovery {
  // Where each protocol's live pass has read up to. Kept in memory between ticks; the pass
  // saves it to the database about once a minute and reads it back after a restart.
  private readonly positions = new Map<string, LivePosition>();

  constructor(private readonly ctx: DurableObjectState, private readonly env: IndexerEnv) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/ensure") return new Response("Not found", { status: 404 });
    const [alarm, lastTickAt] = await Promise.all([this.ctx.storage.getAlarm(),
      this.ctx.storage.get<number>("lastTickAt")]);
    // No recorded tick counts as stalled: at worst one extra tick right after a deploy.
    const stalled = lastTickAt === undefined || Date.now() - lastTickAt > STALLED_MS;
    if (alarm === null || stalled) {
      if (alarm !== null) console.warn(`Live pool discovery's alarm is set but it last ticked at ${lastTickAt ?? "never"}; restarting it`);
      // Replaces any alarm already set.
      await this.ctx.storage.setAlarm(Date.now());
    }
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.put("lastTickAt", Date.now());
    try {
      const client = createDirectoryClient(this.env.ARC_RPC_URL);
      for (const dir of DIRECTORIES) {
        try {
          this.positions.set(dir.name, await runLivePass({ db: this.env.DB, dir, client,
            position: this.positions.get(dir.name) }));
        } catch (error) {
          console.warn(`Live ${dir.name} pool discovery will retry next tick`, error);
        }
      }
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }
}
