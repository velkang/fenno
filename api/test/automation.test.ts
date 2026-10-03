import { getAddress, zeroAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { v4PoolId, type ChainReadClient } from "@stillwater/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src";

const owner = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");
const key = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const poolId = v4PoolId(key);
const NOW = 2_000_000_000_000;
const SECRET = "agent-secret-for-tests";
const sessionToken = "automation-session";

type Statement = { sql: string; args: unknown[] };
type Answer = (sql: string, args: unknown[]) => unknown;

/** A D1 stand-in: `answer` gives the row (first), rows (all) for each query; writes are recorded. */
function fakeDb(answer: Answer) {
  const statements: Statement[] = [];
  const prepare = (sql: string) => {
    const statement: Statement & Record<string, unknown> = { sql, args: [] };
    statement.bind = (...args: unknown[]) => { statement.args = args; return statement; };
    statement.first = async () => { statements.push(statement); return answer(sql, statement.args) ?? null; };
    statement.all = async () => { statements.push(statement); return { results: answer(sql, statement.args) ?? [] }; };
    statement.run = async () => { statements.push(statement); return { meta: { changes: 1 } }; };
    return statement;
  };
  const db = { prepare, async batch(list: Statement[]) { statements.push(...list); return []; } };
  return { db: db as unknown as D1Database, statements };
}

async function setup(answer: Answer, options: { signer?: Fetcher; chain?: ChainReadClient } = {}) {
  const sessionHash = await hashOpaqueValue(sessionToken);
  const authStore = { findSessionUser: async (value: string) =>
    value === sessionHash ? { id: "user-1", ownerAddress: owner } : null } as unknown as AuthStore;
  const { db, statements } = fakeDb(answer);
  const env = { DB: db, SIGNER: options.signer ?? ({} as Fetcher), AUTH_URI: "http://localhost:8787",
    ARC_RPC_URL: "https://rpc.mainnet.arc.io", AGENT_SECRET: SECRET } satisfies Bindings;
  const app = createApp({ createAuthStore: () => authStore, now: () => NOW,
    ...(options.chain ? { createChainClient: () => options.chain! } : {}) });
  return { request: (path: string, init: RequestInit = {}) => app.request(path, init, env), statements };
}

const agentHeaders = (runId = "run-1", secret = SECRET) =>
  ({ "x-stillwater-agent": secret, "x-stillwater-run": runId, "content-type": "application/json" });
const sessionHeaders = { cookie: `stillwater_session=${sessionToken}`, "content-type": "application/json" };

const runningRun = { id: "run-1", run_status: "running", mandate_id: "mandate-1", mandate_status: "active",
  pool_id: poolId, wallet_id: "wallet-1", user_id: "user-1", owner_address: owner };
const answerRun = (run: Record<string, unknown> | null) => (sql: string) =>
  sql.includes("FROM automation_runs ar") && sql.includes("JOIN users") ? run : null;

describe("agent identity", () => {
  it("refuses a wrong agent secret", async () => {
    const { request } = await setup(answerRun(runningRun));
    const response = await request("/v1/wallets/v4/positions", { headers: agentHeaders("run-1", "wrong") });
    expect(response.status).toBe(401);
  });

  it("refuses every route outside the agent's list, before reading anything", async () => {
    const { request, statements } = await setup(answerRun(runningRun));
    for (const [method, path] of [
      ["POST", "/v1/wallets/withdrawals/prepare"],
      ["POST", "/v1/wallets/provision"],
      ["POST", "/v1/wallets/pause"],
      ["POST", "/v1/wallets/positions/actions/prepare"],
      ["PUT", "/v1/automation/mandates"],
      ["GET", "/v1/wallets/summary"],
    ]) {
      const response = await request(path, { method, headers: agentHeaders(), body: method === "GET" ? undefined : "{}" });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual({ error: "AGENT_ROUTE_NOT_ALLOWED" });
    }
    expect(statements).toHaveLength(0);
  });

  it("refuses a run that is not running or whose mandate is revoked", async () => {
    for (const run of [null, { ...runningRun, run_status: "proposed" }, { ...runningRun, mandate_status: "revoked" }]) {
      const { request } = await setup(answerRun(run));
      const response = await request("/v1/wallets/intents/intent-1/execute", { method: "POST", headers: agentHeaders() });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "MANDATE_RUN_NOT_RUNNING" });
    }
  });

  it("executes only the run's own requests, as the wallet's user", async () => {
    const signer = { fetch: vi.fn(async () => Response.json({ attemptId: "attempt-1" })) } as unknown as Fetcher;
    const { request, statements } = await setup((sql, args) => {
      if (sql.includes("FROM automation_runs ar")) return runningRun;
      if (sql.includes("FROM wallet_intents wi")) return args[2] === "run-1" ? { id: "intent-1", wallet_id: "wallet-1" } : null;
      return null;
    }, { signer });
    const response = await request("/v1/wallets/intents/intent-1/execute", { method: "POST", headers: agentHeaders() });
    expect(response.status).toBe(200);
    const owned = statements.find((statement) => statement.sql.includes("FROM wallet_intents wi"))!;
    expect(owned.args).toEqual(["intent-1", "user-1", "run-1"]);
    expect(owned.sql).toContain("automation_run_id");
  });

  it("marks the requests it prepares with its run, and the user's stay unmarked", async () => {
    const chain = {
      async getBlock() { return { number: 100n, hash: `0x${"ab".repeat(32)}` }; },
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getPoolAndPositionInfo") return [key, (((1n << 24n) - 60n) << 8n) | (60n << 32n)];
        if (functionName === "getPositionLiquidity") return 100_000n;
        if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
        if (functionName === "getLiquidity") return 1_000_000n;
        throw new Error(`Unexpected ${functionName}`);
      },
      async call() { return { data: "0x" }; },
      async estimateGas() { return 100_000n; },
      async estimateFeesPerGas() { return { maxFeePerGas: 1_000_000_000n }; },
      async getBalance() { return 10n ** 18n; },
    } as unknown as ChainReadClient;
    const directory = { pool_id: poolId, currency0: zeroAddress, currency1: token, fee: 3000, tick_spacing: 60,
      hooks: zeroAddress, token_address: token, token_symbol: "MEME", token_decimals: 18 };
    const answer: Answer = (sql) => sql.includes("FROM automation_runs ar") ? runningRun
      : sql.includes("FROM managed_wallets") ? { id: "wallet-1", address: owner, state: "active" }
      : sql.includes("v4_pool_directory") ? directory : null;
    const body = (key: string) => JSON.stringify({ action: "collect", tokenId: "7", slippageBps: 100,
      deadline: "2000000600", idempotencyKey: key });
    const inserted = async (headers: Record<string, string>, idempotencyKey: string) => {
      const { request, statements } = await setup(answer, { chain });
      const response = await request("/v1/wallets/v4/positions/actions/prepare",
        { method: "POST", headers, body: body(idempotencyKey) });
      expect(response.status).toBe(201);
      return statements.find((statement) => statement.sql.includes("INSERT INTO wallet_intents"))!;
    };

    const agent = await inserted(agentHeaders(), "agent-action-key-0001");
    expect(agent.sql).toContain("automation_run_id");
    expect(agent.args.at(-1)).toBe("run-1");
    const user = await inserted(sessionHeaders, "user-action-key-00001");
    expect(user.args.at(-1)).toBeNull();
  });
});

describe("mandate routes", () => {
  const wallet = { id: "wallet-1", address: owner, state: "active" };

  it("rejects an invalid mandate and one for a pool Stillwater doesn't list", async () => {
    const { request } = await setup((sql) => sql.includes("FROM managed_wallets") ? wallet : null);
    const mandate = { poolId, mode: "autopilot", band: "balanced", maxPositionUsd: 50, maxRunsPerDay: 2 };
    for (const bad of [{ ...mandate, mode: "yolo" }, { ...mandate, maxPositionUsd: 0 },
      { ...mandate, maxRunsPerDay: 25 }, { ...mandate, poolId: "0x1234" }]) {
      const response = await request("/v1/automation/mandates", { method: "PUT", headers: sessionHeaders,
        body: JSON.stringify(bad) });
      expect(response.status).toBe(400);
    }
    const unknownPool = await request("/v1/automation/mandates", { method: "PUT", headers: sessionHeaders,
      body: JSON.stringify(mandate) });
    expect(unknownPool.status).toBe(404);
    expect(await unknownPool.json()).toEqual({ error: "POOL_NOT_FOUND" });
  });

  it("saves a mandate for the signed-in user's wallet", async () => {
    const saved = { id: "mandate-1", pool_id: poolId, mode: "autopilot", status: "active", band: "balanced",
      max_position_usd: 50, max_runs_per_day: 2, created_at: NOW, updated_at: NOW };
    const { request, statements } = await setup((sql) => sql.includes("FROM managed_wallets") ? wallet
      : sql.includes("v4_pool_directory") ? { pool_id: poolId }
      : sql.includes("FROM automation_mandates") ? saved : null);
    const response = await request("/v1/automation/mandates", { method: "PUT", headers: sessionHeaders,
      body: JSON.stringify({ poolId, mode: "autopilot", band: "balanced", maxPositionUsd: 50, maxRunsPerDay: 2 }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mandate: { id: "mandate-1", poolId, mode: "autopilot",
      status: "active", maxPositionUsd: 50, maxRunsPerDay: 2 } });
    const upsert = statements.find((statement) => statement.sql.includes("INSERT INTO automation_mandates"))!;
    expect(upsert.args).toContain("wallet-1");
  });

  it("starts a proposed run only while its mandate is active and under the daily limit", async () => {
    const proposed = { id: "run-9", status: "proposed", created_at: NOW - 60_000, mandate_id: "mandate-1",
      mandate_status: "active", max_runs_per_day: 2 };
    const approve = async (run: Record<string, unknown>, startedToday: number) => {
      const { request, statements } = await setup((sql) => sql.includes("FROM managed_wallets") ? wallet
        : sql.includes("COUNT(*)") ? { runs: startedToday }
        : sql.includes("FROM automation_runs ar") ? run : null);
      const response = await request("/v1/automation/runs/run-9/approve", { method: "POST", headers: sessionHeaders });
      return { response, statements };
    };

    const ok = await approve(proposed, 1);
    expect(ok.response.status).toBe(200);
    const start = ok.statements.find((statement) => statement.sql.includes("status = 'running'"))!;
    expect(start.args).toEqual(["run-9", NOW]);

    expect((await approve(proposed, 2)).response.status).toBe(409);
    expect((await approve({ ...proposed, mandate_status: "paused" }, 0)).response.status).toBe(409);
    expect((await approve({ ...proposed, status: "running" }, 0)).response.status).toBe(409);
    const stale = await approve({ ...proposed, created_at: NOW - 25 * 60 * 60 * 1_000 }, 0);
    expect(stale.response.status).toBe(409);
    expect(await stale.response.json()).toEqual({ error: "RUN_EXPIRED" });
  });
});
