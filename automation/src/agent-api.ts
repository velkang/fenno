import type { Hex } from "viem";

// The API calls the stepper makes, as the agent for one run. Everything goes through the
// API's normal routes, so the API and the signer check each request as they would a user's.

export const AGENT_SECRET_HEADER = "x-stillwater-agent";
export const AGENT_RUN_HEADER = "x-stillwater-run";

export type PoolInfo = {
  address: string; // the v4 pool id, or the v3 pool address
  token: { address: string; symbol: string; decimals: number };
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  hooks?: string;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  lpFee?: number;
};

export type Balances = {
  allowances: Array<{ token: string; balance: string; erc20: string; permit2: string; expiration: string }>;
  nativeBalance: string;
};

export type Purpose = "mint" | "swap";

/** A v3 pool's two tokens as the wallet holds them; `allowance` is the position manager's. */
export type V3Holdings = {
  token: { address: string; balance: string; allowance: string };
  usdc: { address: string; balance: string; allowance: string };
};

export interface AgentApi {
  pool(poolId: Hex): Promise<PoolInfo>;
  balances(poolId: Hex, purpose: Purpose): Promise<Balances>;
  prepareWithdraw(body: { tokenId: string; deadline: string; idempotencyKey: string }): Promise<{ intentId: string }>;
  prepareApproval(body: { poolId: Hex; token: string; stage: "erc20" | "permit2"; purpose: Purpose;
    amount: string; idempotencyKey: string }): Promise<{ intentId: string }>;
  quoteSwap(body: { poolId: Hex; tokenIn: string; amountIn: string }): Promise<{ expectedAmountOut: string; minimumAmountOut: string }>;
  prepareSwap(body: { poolId: Hex; tokenIn: string; amountIn: string; minimumAmountOut: string;
    idempotencyKey: string }): Promise<{ intentId: string }>;
  prepareMint(body: { poolId: Hex; amount0Desired: string; amount1Desired: string; tickLower: number;
    tickUpper: number; deadline: string; idempotencyKey: string }): Promise<{ intentId: string }>;
  v3Holdings(token: string): Promise<V3Holdings>;
  prepareV3Withdraw(body: { tokenId: string; deadline: string; idempotencyKey: string }): Promise<{ intentId: string }>;
  prepareV3Approval(body: { tokenAddress: string; poolAddress: string; poolTokenAddress: string;
    spender?: "swap"; amount: string; idempotencyKey: string }): Promise<{ intentId: string }>;
  quoteV3Swap(body: { tokenAddress: string; poolAddress: string; direction: "buy" | "sell"; amountIn: string }):
    Promise<{ expectedAmountOut: string; minimumAmountOut: string; allowance: string }>;
  prepareV3Swap(body: { tokenAddress: string; poolAddress: string; direction: "buy" | "sell"; amountIn: string;
    idempotencyKey: string }): Promise<{ intentId: string }>;
  prepareV3Mint(body: { tokenAddress: string; poolAddress: string; amountToken: string; amountUsdc: string;
    tickLower: number; tickUpper: number; deadline: string; idempotencyKey: string }): Promise<{ intentId: string }>;
  execute(intentId: string): Promise<{ attemptId: string }>;
  reconcile(attemptId: string): Promise<{ status: string; reasonCode?: string }>;
}

/** An error the API answered with; `code` is its error code. */
export class ApiCallError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

// One percent, as the web app uses for the same actions.
export const SLIPPAGE_BPS = 100;

/** The agent API over the service binding to the Stillwater API. */
export function agentApi(api: Fetcher, secret: string, runId: string): AgentApi {
  const call = async <T>(path: string, init: { method?: string; body?: unknown; asAgent?: boolean } = {}): Promise<T> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // Pool reads are public; the agent header is only sent where the agent acts.
    if (init.asAgent !== false) {
      headers[AGENT_SECRET_HEADER] = secret;
      headers[AGENT_RUN_HEADER] = runId;
    }
    const response = await api.fetch(new Request(`https://stillwater-api${path}`, {
      method: init.method ?? "GET", headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }));
    const json = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new ApiCallError(json.error ?? `HTTP_${response.status}`, response.status);
    return json;
  };
  const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body });
  return {
    pool: async (poolId) => (await call<{ pool: PoolInfo }>(`/v1/pools/${poolId}`, { asAgent: false })).pool,
    balances: (poolId, purpose) => call(`/v1/wallets/v4/pools/${poolId}/allowances?purpose=${purpose}`),
    prepareWithdraw: (body) => post("/v1/wallets/v4/positions/actions/prepare",
      { action: "withdraw", slippageBps: SLIPPAGE_BPS, ...body }),
    prepareApproval: (body) => post("/v1/wallets/v4/approvals/prepare", body),
    quoteSwap: (body) => post("/v1/wallets/v4/swaps/quote", { slippageBps: SLIPPAGE_BPS, ...body }),
    prepareSwap: (body) => post("/v1/wallets/v4/swaps/prepare", { slippageBps: SLIPPAGE_BPS, ...body }),
    prepareMint: (body) => post("/v1/wallets/v4/positions/mint/prepare", { slippageBps: SLIPPAGE_BPS, ...body }),
    v3Holdings: (token) => call(`/v1/wallets/tokens/${token}/pools`),
    prepareV3Withdraw: (body) => post("/v1/wallets/positions/actions/prepare",
      { action: "withdraw", slippageBps: SLIPPAGE_BPS, ...body }),
    prepareV3Approval: (body) => post("/v1/wallets/approvals/prepare", body),
    quoteV3Swap: (body) => post("/v1/wallets/swaps/quote", { slippageBps: SLIPPAGE_BPS, ...body }),
    prepareV3Swap: (body) => post("/v1/wallets/swaps/prepare", { slippageBps: SLIPPAGE_BPS, ...body }),
    prepareV3Mint: (body) => post("/v1/wallets/positions/mint/prepare", { slippageBps: SLIPPAGE_BPS, ...body }),
    execute: (intentId) => post(`/v1/wallets/intents/${intentId}/execute`, {}),
    reconcile: (attemptId) => post(`/v1/wallets/attempts/${attemptId}/reconcile`, {}),
  };
}
