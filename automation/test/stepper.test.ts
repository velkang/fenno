import { describe, expect, it } from "vitest";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { ARC_TOKENS, buildArcV4Mint, positionAmounts, v4PoolId } from "@stillwater/chain";
import { ApiCallError, type AgentApi, type PoolInfo } from "../src/agent-api";
import { advance, startState, type Outcome, type RunState } from "../src/stepper";
import { finishRun, WalletAutomation, type AutomationEnv } from "../src/wallet-automation";

const wallet = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const usdc = ARC_TOKENS.USDC.address;
const NOW = 2_000_000_000_000;
const MAX = (2n ** 256n - 1n).toString();

// Token (6 decimals) is currency0, ERC-20 USDC currency1, at one raw USDC per raw token.
function erc20Pool(): PoolInfo {
  const key = { currency0: token, currency1: usdc, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  return { address: v4PoolId(key), token: { address: token, symbol: "MEME", decimals: 6 },
    token0: token, token1: usdc, fee: 3000, tickSpacing: 60, hooks: zeroAddress,
    sqrtPriceX96: (2n ** 96n).toString(), tick: 0, liquidity: "1000000000000", lpFee: 3000 };
}

// A v4 run never makes v3 calls.
const noV3 = Object.fromEntries(["v3Holdings", "prepareV3Withdraw", "prepareV3Approval", "quoteV3Swap",
  "prepareV3Swap", "prepareV3Mint"].map((name) => [name, async () => { throw new Error(`${name} in a v4 run`); }])) as unknown as
  Pick<AgentApi, "v3Holdings" | "prepareV3Withdraw" | "prepareV3Approval" | "quoteV3Swap" | "prepareV3Swap" | "prepareV3Mint">;

/** A wallet on a pretend chain: transactions settle when sent, each costing 1,000 raw USDC of gas. */
function fakeApi(options: { pool?: PoolInfo; failReconcile?: string; failPrepare?: string; busyOnce?: boolean;
  startUsdc?: bigint; giftAfterClose?: bigint; stayPending?: boolean } = {}) {
  const pool = options.pool ?? erc20Pool();
  const balances = new Map<string, bigint>([[token, 5_000_000n], [usdc, options.startUsdc ?? 10_000_000n]]);
  const erc20 = new Map<string, string>();
  const permit2 = new Map<string, string>(); // `${token}:${purpose}`
  const intents = new Map<string, { step: string; apply: () => void }>();
  const sent: string[] = [];
  const minted: Array<{ amount0Desired: string; amount1Desired: string; tickLower: number; tickUpper: number }> = [];
  let busy = options.busyOnce ?? false;
  const prepare = (step: string, apply: () => void) => {
    if (options.failPrepare === step) throw new ApiCallError("V4_MINT_SIMULATION_FAILED", 422);
    const intentId = `intent-${intents.size + 1}`;
    intents.set(intentId, { step, apply });
    return { intentId };
  };
  const add = (address: string, delta: bigint) => balances.set(address, (balances.get(address) ?? 0n) + delta);
  const api: AgentApi = {
    ...noV3,
    async pool() { return pool; },
    async balances(_poolId, purpose) {
      return {
        allowances: [token, usdc].map((address) => ({ token: address, balance: (balances.get(address) ?? 0n).toString(),
          erc20: erc20.get(address) ?? "0", permit2: permit2.get(`${address}:${purpose}`) ?? "0",
          expiration: permit2.has(`${address}:${purpose}`) ? String(NOW / 1000 + 1800) : "0" })),
        nativeBalance: "0",
      };
    },
    async prepareWithdraw() {
      return prepare("close", () => add(token, 1_000_000n));
    },
    async prepareApproval({ token: address, stage, purpose }) {
      return prepare(`${purpose}-${stage}`, () => stage === "erc20"
        ? erc20.set(address, MAX) : permit2.set(`${address}:${purpose}`, MAX));
    },
    async quoteSwap({ amountIn }) { return { expectedAmountOut: amountIn, minimumAmountOut: amountIn }; },
    async prepareSwap({ tokenIn, amountIn }) {
      return prepare("swap", () => { add(tokenIn, -BigInt(amountIn)); add(tokenIn === token ? usdc : token, BigInt(amountIn)); });
    },
    async prepareMint(body) {
      // The worst case: the mint takes its full slippage-adjusted maximums.
      const mint = buildArcV4Mint({ pool: { id: pool.address as Hex, currency0: getAddress(pool.token0),
        currency1: getAddress(pool.token1), fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: zeroAddress,
        sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, liquidity: pool.liquidity, lpFee: pool.lpFee ?? pool.fee },
        tokenDecimals: pool.token.decimals, recipient: wallet, tickLower: body.tickLower, tickUpper: body.tickUpper,
        amount0Desired: BigInt(body.amount0Desired), amount1Desired: BigInt(body.amount1Desired), slippageBps: 100,
        deadline: BigInt(body.deadline) });
      return prepare("mint", () => { minted.push(body); add(pool.token0, -mint.amount0Max); add(pool.token1, -mint.amount1Max); });
    },
    async execute(intentId) {
      if (busy) { busy = false; throw new ApiCallError("WALLET_EXECUTION_BUSY", 409); }
      const intent = intents.get(intentId)!;
      intent.apply();
      // Someone else's money can arrive while the run is going (here, with the next transaction).
      if (options.giftAfterClose && sent.length === 1) add(token, options.giftAfterClose);
      add(usdc, -1_000n);
      sent.push(intent.step);
      return { attemptId: `attempt-${intentId}` };
    },
    async reconcile(attemptId) {
      const step = intents.get(attemptId.replace("attempt-", ""))!.step;
      if (options.stayPending) return { status: "submitted" };
      return options.failReconcile === step ? { status: "failed", reasonCode: "RECEIPT_REVERTED" } : { status: "confirmed" };
    },
  };
  return { api, sent, minted, balances };
}

const plan = (pool: PoolInfo) => startState({ runId: "run_0123456789abcdef", walletId: "wallet-1",
  walletAddress: wallet, mandateId: "mandate-1", poolId: pool.address as Hex, tokenId: "7",
  kind: "rebalance", band: "balanced", revokeMandate: true }, NOW);

/** Drives a run to its end, saving and reloading its state between steps as the Durable Object does. */
async function drive(api: AgentApi, state: RunState, now = NOW): Promise<Outcome> {
  for (let step = 0; step < 60; step += 1) {
    const outcome = await advance(JSON.parse(JSON.stringify(state)) as RunState, api, now);
    if (outcome.kind !== "wait") return outcome;
    state = outcome.state;
  }
  throw new Error("Run never finished");
}

describe("rebalance stepper", () => {
  it("closes, swaps to the band's ratio, approves and reopens using only the closed position's money", async () => {
    const { api, sent, minted, balances } = fakeApi();
    expect(await drive(api, plan(erc20Pool()))).toEqual({ kind: "done" });
    // Even at the mint's maximums, the wallet's own money is untouched; only the fees came off it.
    expect(balances.get(token)).toBeGreaterThanOrEqual(5_000_000n);
    expect(balances.get(usdc)).toBeGreaterThanOrEqual(10_000_000n - 8_000n);

    expect(sent).toEqual(["close", "swap-erc20", "swap-permit2", "swap", "mint-permit2", "mint-erc20", "mint-permit2", "mint"]);
    const [{ amount0Desired, amount1Desired, tickLower, tickUpper }] = minted;
    // The position returned 1,000,000 raw tokens; the wallet's own 5,000,000 tokens and
    // 10,000,000 USDC stay out. The band is sized so even its slippage maximums fit in what
    // came back, so a little stays in the wallet.
    const reopened = BigInt(amount0Desired) + BigInt(amount1Desired);
    expect(reopened).toBeLessThanOrEqual(1_000_000n);
    expect(reopened).toBeGreaterThan(850_000n);
    // The swap left the two sides in the ratio the new ±10% band needs at this price.
    const needed = positionAmounts(1e18, erc20Pool().sqrtPriceX96, tickLower, tickUpper);
    expect(Number(amount0Desired) / Number(amount1Desired)).toBeCloseTo(needed.amount0 / needed.amount1, 1);
  });

  it("keeps enough USDC in the wallet for fees when it had almost none of its own", async () => {
    const { api, balances } = fakeApi({ startUsdc: 20_000n });
    expect(await drive(api, plan(erc20Pool()))).toEqual({ kind: "done" });
    // 0.05 USDC (50,000 raw) stays back; at most the mint's own fee (1,000) comes out of it.
    expect(balances.get(usdc)).toBeGreaterThanOrEqual(49_000n);
  });

  it("reinvests only what the closed position returned, even if more money arrives meanwhile", async () => {
    const { api, minted, balances } = fakeApi({ giftAfterClose: 3_000_000n });
    expect(await drive(api, plan(erc20Pool()))).toEqual({ kind: "done" });
    const [{ amount0Desired, amount1Desired }] = minted;
    expect(BigInt(amount0Desired) + BigInt(amount1Desired)).toBeLessThanOrEqual(1_000_000n);
    expect(balances.get(token)).toBeGreaterThanOrEqual(8_000_000n);
  });

  it("only closes when the run is a close", async () => {
    const { api, sent, balances } = fakeApi();
    expect(await drive(api, { ...plan(erc20Pool()), kind: "close" })).toEqual({ kind: "done" });
    expect(sent).toEqual(["close"]);
    expect(balances.get(token)).toBe(6_000_000n);
  });

  it("stops with the reason when a transaction fails, and sends nothing more", async () => {
    const { api, sent } = fakeApi({ failReconcile: "close" });
    expect(await drive(api, plan(erc20Pool()))).toEqual({ kind: "failed", reason: "RECEIPT_REVERTED" });
    expect(sent).toEqual(["close"]);
  });

  it("stops with the API's reason when a step can't be prepared", async () => {
    const { api, sent } = fakeApi({ failPrepare: "mint" });
    expect(await drive(api, plan(erc20Pool()))).toEqual({ kind: "failed", reason: "V4_MINT_SIMULATION_FAILED" });
    expect(sent.at(-1)).not.toBe("mint");
  });

  it("waits while another transaction from the wallet is still going", async () => {
    const { api, sent } = fakeApi({ busyOnce: true });
    expect(await drive(api, plan(erc20Pool()))).toEqual({ kind: "done" });
    expect(sent[0]).toBe("close");
  });

  it("keeps waiting past the time limit while a sent transaction is still settling", async () => {
    const { api } = fakeApi({ stayPending: true });
    const sent = { ...plan(erc20Pool()), done: [], pending: { step: "close", intentId: "intent-1", attemptId: "attempt-intent-1" } };
    await api.prepareWithdraw({ tokenId: "7", deadline: "1", idempotencyKey: "close-key-000001" });
    const outcome = await advance(sent, api, NOW + 31 * 60 * 1_000);
    expect(outcome.kind).toBe("wait");
  });

  it("gives up on a run that has gone on too long", async () => {
    const { api, sent } = fakeApi();
    expect(await drive(api, plan(erc20Pool()), NOW + 31 * 60 * 1_000)).toEqual({ kind: "failed", reason: "RUN_TIMED_OUT" });
    expect(sent).toEqual([]);
  });
});

// The QUANTS-style v3 pool: token (6 decimals) first, ERC-20 USDC second, one raw USDC per raw token.
const v3Pool = "0x3333333333333333333333333333333333333333" as Hex;
const v3PoolInfo: PoolInfo = { address: v3Pool, token: { address: token, symbol: "MEME", decimals: 6 },
  token0: token, token1: usdc, fee: 3000, tickSpacing: 60, sqrtPriceX96: (2n ** 96n).toString(), tick: 0,
  liquidity: "1000000000000" };

/** A v3 wallet on a pretend chain, as `fakeApi`: approvals go straight to the router or position manager. */
function fakeV3Api(options: { closeReturns?: { token: bigint; usdc: bigint }; failReconcile?: string } = {}) {
  const balances = new Map<string, bigint>([[token, 5_000_000n], [usdc, 10_000_000n]]);
  const allowed = new Map<string, bigint>(); // `${token}:${"router" | "manager"}`
  const intents = new Map<string, { step: string; apply: () => void }>();
  const sent: string[] = [];
  const minted: Array<{ amountToken: string; amountUsdc: string; tickLower: number; tickUpper: number; poolAddress: string }> = [];
  const add = (address: string, delta: bigint) => balances.set(address, (balances.get(address) ?? 0n) + delta);
  const allowance = (address: string, spender: string) => allowed.get(`${address}:${spender}`) ?? 0n;
  const prepare = (step: string, apply: () => void) => {
    const intentId = `intent-${intents.size + 1}`;
    intents.set(intentId, { step, apply });
    return { intentId };
  };
  const unused = async () => { throw new Error("v4 call in a v3 run"); };
  const api: AgentApi = {
    pool: async () => v3PoolInfo,
    balances: unused, prepareWithdraw: unused, prepareApproval: unused, quoteSwap: unused, prepareSwap: unused,
    prepareMint: unused,
    async v3Holdings() {
      return { token: { address: token, balance: String(balances.get(token)), allowance: String(allowance(token, "manager")) },
        usdc: { address: usdc, balance: String(balances.get(usdc)), allowance: String(allowance(usdc, "manager")) } };
    },
    async prepareV3Withdraw() {
      const back = options.closeReturns ?? { token: 1_000_000n, usdc: 0n };
      return prepare("close", () => { add(token, back.token); add(usdc, back.usdc); });
    },
    async prepareV3Approval({ tokenAddress, spender }) {
      return prepare(`${spender ?? "mint"}-approve`, () =>
        allowed.set(`${tokenAddress}:${spender === "swap" ? "router" : "manager"}`, 2n ** 256n - 1n));
    },
    async quoteV3Swap({ direction, amountIn }) {
      const tokenIn = direction === "buy" ? usdc : token;
      return { expectedAmountOut: amountIn, minimumAmountOut: amountIn, allowance: String(allowance(tokenIn, "router")) };
    },
    async prepareV3Swap({ direction, amountIn }) {
      const [tokenIn, tokenOut] = direction === "buy" ? [usdc, token] : [token, usdc];
      if (allowance(tokenIn, "router") < BigInt(amountIn)) throw new ApiCallError("ROUTER_APPROVAL_REQUIRED", 409);
      return prepare("swap", () => { add(tokenIn, -BigInt(amountIn)); add(tokenOut, BigInt(amountIn)); });
    },
    async prepareV3Mint(body) {
      if (allowance(token, "manager") < BigInt(body.amountToken) || allowance(usdc, "manager") < BigInt(body.amountUsdc)) {
        throw new ApiCallError("MINT_SIMULATION_FAILED", 422);
      }
      // The worst case: the open takes all it names.
      return prepare("mint", () => { minted.push(body); add(token, -BigInt(body.amountToken)); add(usdc, -BigInt(body.amountUsdc)); });
    },
    async execute(intentId) {
      const intent = intents.get(intentId)!;
      intent.apply();
      add(usdc, -1_000n);
      sent.push(intent.step);
      return { attemptId: `attempt-${intentId}` };
    },
    async reconcile(attemptId) {
      const step = intents.get(attemptId.replace("attempt-", ""))!.step;
      return options.failReconcile === step ? { status: "failed", reasonCode: "RECEIPT_REVERTED" } : { status: "confirmed" };
    },
  };
  return { api, sent, minted, balances };
}

describe("re-centring a v3 position", () => {
  it("closes, swaps, approves and reopens in the same pool with only the closed position's money", async () => {
    const { api, sent, minted, balances } = fakeV3Api();
    expect(await drive(api, plan(v3PoolInfo))).toEqual({ kind: "done" });
    expect(sent).toEqual(["close", "swap-approve", "swap", "mint-approve", "mint-approve", "mint"]);
    const [opened] = minted;
    expect(opened!.poolAddress).toBe(v3Pool);
    expect(BigInt(opened!.amountToken) + BigInt(opened!.amountUsdc)).toBeLessThanOrEqual(1_000_000n);
    expect(BigInt(opened!.amountToken) + BigInt(opened!.amountUsdc)).toBeGreaterThan(900_000n);
    expect(opened!.tickLower).toBeLessThan(0);
    expect(opened!.tickUpper).toBeGreaterThan(0);
    // The wallet's own money is untouched; only the six transactions' fees came off it.
    expect(balances.get(token)).toBeGreaterThanOrEqual(5_000_000n);
    expect(balances.get(usdc)).toBeGreaterThanOrEqual(10_000_000n - 6_000n);
  });

  it("skips the swap when the close already returned the band's ratio (about 47% token here)", async () => {
    const { api, sent } = fakeV3Api({ closeReturns: { token: 470_000n, usdc: 530_000n } });
    expect(await drive(api, plan(v3PoolInfo))).toEqual({ kind: "done" });
    expect(sent).toEqual(["close", "mint-approve", "mint-approve", "mint"]);
  });

  it("stops after the close when the swap fails, leaving the tokens in the wallet", async () => {
    const { api, sent, balances } = fakeV3Api({ failReconcile: "swap" });
    expect(await drive(api, plan(v3PoolInfo))).toEqual({ kind: "failed", reason: "RECEIPT_REVERTED" });
    expect(sent).toEqual(["close", "swap-approve", "swap"]);
    expect(balances.get(token)! + balances.get(usdc)!).toBeGreaterThan(15_000_000n);
  });

  it("only closes when the run is a close", async () => {
    const { api, sent } = fakeV3Api();
    expect(await drive(api, { ...plan(v3PoolInfo), kind: "close" })).toEqual({ kind: "done" });
    expect(sent).toEqual(["close"]);
  });
});

describe("finishing a run", () => {
  const recorded = () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
      async batch(list: Array<{ sql: string; args: unknown[] }>) { statements.push(...list); return []; } };
    return { db: db as unknown as D1Database, statements };
  };

  it("records a failure and ends a one-off mandate", async () => {
    const { db, statements } = recorded();
    await finishRun(db, plan(erc20Pool()), { kind: "failed", reason: "RECEIPT_REVERTED" }, NOW);
    expect(statements[0].args).toEqual(["run_0123456789abcdef", "failed", "RECEIPT_REVERTED", NOW]);
    expect(statements[1].sql).toContain("status = 'revoked'");
    expect(statements[1].args).toEqual(["mandate-1", NOW]);
  });

  it("leaves the user's own mandate in place", async () => {
    const { db, statements } = recorded();
    await finishRun(db, { ...plan(erc20Pool()), revokeMandate: false }, { kind: "done" }, NOW);
    expect(statements).toHaveLength(1);
    expect(statements[0].args).toEqual(["run_0123456789abcdef", "done", null, NOW]);
  });
});

describe("the wallet's Durable Object", () => {
  it("doesn't overwrite a run started while it was deciding, and drops its own", async () => {
    const stored = new Map<string, unknown>([["watching", true], ["walletId", "wallet-1"]]);
    const alarms: number[] = [];
    const ctx = { storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") stored.set(key, value); else for (const [k, v] of Object.entries(key)) stored.set(k, v);
      },
      delete: async (key: string | string[]) => { for (const k of [key].flat()) stored.delete(k); },
      setAlarm: async (at: number) => { alarms.push(at); },
    } } as unknown as DurableObjectState;
    const batches: Array<Array<{ args: unknown[] }>> = [];
    const db = { prepare: () => ({ bind: (...args: unknown[]) => ({ args }) }),
      batch: async (list: Array<{ args: unknown[] }>) => { batches.push(list); return []; } } as unknown as D1Database;
    const handStarted = plan(erc20Pool());
    const automation = new WalletAutomation(ctx, { DB: db } as AutomationEnv, {
      // While the model is thinking, the user starts a re-centre by hand.
      watch: async () => {
        stored.set("run", handStarted);
        return { state: { memories: {} }, stop: false, start: { ...handStarted, runId: "run_agent_000000001", revokeMandate: false } };
      },
    });

    await automation.alarm();
    expect(stored.get("run")).toBe(handStarted);
    expect(batches[0]![0]!.args).toEqual(["run_agent_000000001", "failed", "RUN_IN_PROGRESS", expect.any(Number)]);
    expect(alarms).toHaveLength(0);
  });


  it("keeps a finished run and tries again when recording its end fails", async () => {
    const stored = new Map<string, unknown>();
    const alarms: number[] = [];
    const ctx = { storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => { stored.set(key, value); },
      delete: async (key: string) => { stored.delete(key); },
      setAlarm: async (at: number) => { alarms.push(at); },
    } } as unknown as DurableObjectState;
    let failures = 1;
    const db = { prepare: () => ({ bind: () => ({}) }),
      batch: async () => { if (failures-- > 0) throw new Error("D1 unavailable"); return []; } } as unknown as D1Database;
    // No agent secret: the run ends at once, so only the recording of its end is exercised.
    const automation = new WalletAutomation(ctx, { DB: db, API: {} as Fetcher, RUNS: {} as DurableObjectNamespace } as AutomationEnv);
    stored.set("run", plan(erc20Pool()));

    await automation.alarm();
    expect(stored.has("run")).toBe(true);
    expect(alarms).toHaveLength(1);

    await automation.alarm();
    expect(stored.has("run")).toBe(false);
  });
});
