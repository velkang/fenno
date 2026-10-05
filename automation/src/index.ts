import { WalletAutomation, type AutomationEnv } from "./wallet-automation";

const BANDS = new Set(["wide", "balanced", "narrow"]);

export default {
  // Reachable only through the API's service binding: the Worker has no routes or workers.dev URL.
  async fetch(request: Request, env: AutomationEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/v1/wallets/watch") {
      const body = await request.json().catch(() => null) as { walletId?: unknown } | null;
      if (typeof body?.walletId !== "string" || !body.walletId || body.walletId.length > 200) {
        return Response.json({ error: "INVALID_WALLET" }, { status: 400 });
      }
      const wallet = env.RUNS.get(env.RUNS.idFromName(body.walletId));
      return wallet.fetch(new Request("https://wallet-automation/watch", { method: "POST",
        body: JSON.stringify({ walletId: body.walletId }) }));
    }
    if (request.method !== "POST" || url.pathname !== "/internal/v1/runs/start") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const plan = await request.json().catch(() => null) as Record<string, unknown> | null;
    const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200;
    if (!plan || !text(plan.runId) || !text(plan.walletId) || !text(plan.mandateId) || !text(plan.tokenId) ||
        typeof plan.walletAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(plan.walletAddress) ||
        typeof plan.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(plan.poolId) ||
        !BANDS.has(plan.band as string) || (plan.kind !== "rebalance" && plan.kind !== "close") ||
        typeof plan.revokeMandate !== "boolean") {
      return Response.json({ error: "INVALID_RUN" }, { status: 400 });
    }
    const wallet = env.RUNS.get(env.RUNS.idFromName(plan.walletId as string));
    return wallet.fetch(new Request("https://wallet-automation/start", { method: "POST", body: JSON.stringify(plan) }));
  },
};

export { WalletAutomation };
