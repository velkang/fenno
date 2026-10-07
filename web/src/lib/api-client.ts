import type { WalletSummary, DiscoveredPool, DiscoveredToken, Waters } from "@stillwater/chain";

export type AuthUser = {
  id: string;
  address?: string;
  ownerAddress?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type ManagedWalletRecord = {
  id: string;
  address: string;
  state: "provisioning" | "active" | "paused" | "withdrawing" | "closed" | "quarantined";
  created_at: number;
  updated_at: number;
};

export type TokenPoolDiscovery = {
  token: DiscoveredToken;
  usdc: DiscoveredToken;
  pools: DiscoveredPool[];
  liability: string;
};

export type PublicPool = {
  protocol?: "uniswap-v3" | "uniswap-v4";
  address: string;
  token: { address: string; symbol: string; decimals: number };
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  usdcReserve: string | null;
  hooks?: string;
  lpFee?: number;
  blockNumber: number | null;
  updatedAt: number;
  // Block the pool was created in; null until the indexer's backfill reaches it.
  createdBlock?: number | null;
};

/** What working out a pool's token price needs. */
export type PricedPool = Pick<PublicPool, "protocol" | "token" | "token0" | "token1" | "sqrtPriceX96">;

export type V4Position = {
  tokenId: string;
  pool: PublicPool;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  transactionHash: string;
  // Fees earned but not collected, in currency0/currency1 smallest units; null when unreadable.
  fees: { amount0: string; amount1: string } | null;
};

export type RecentreBand = "wide" | "balanced" | "narrow";

export type AutomationRun = {
  id: string;
  mandateId: string;
  poolId: string;
  kind: "rebalance" | "close";
  status: "proposed" | "running" | "done" | "failed" | "declined" | "expired";
  band: RecentreBand | null;
  trigger: string;
  reason: string | null;
  failureReason: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type Mandate = {
  id: string;
  poolId: string;
  mode: "ask" | "autopilot";
  status: "active" | "paused" | "revoked";
  band: RecentreBand | "agent";
  maxPositionUsd: number;
  maxRunsPerDay: number;
};

export class ApiError extends Error {
  constructor(public code: string, public status: number, message?: string) {
    super(message || code);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      credentials: "include",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Network fetch failed";
    throw new ApiError("NETWORK_ERROR", 0, `Failed to fetch ${path}: ${msg}`);
  }

  if (!res.ok) {
    let errorCode = "UNKNOWN_ERROR";
    let errorMessage: string | undefined;
    try {
      const data = await res.json();
      if (data?.error) errorCode = data.error;
      if (data?.message) errorMessage = data.message;
    } catch {
      // response is not json (e.g. Vite proxy error, 502 Bad Gateway)
      errorCode = res.status >= 500 ? "BACKEND_UNREACHABLE" : `HTTP_${res.status}`;
      errorMessage = `Server returned HTTP ${res.status} (${res.statusText || "unreachable backend"}).`;
    }
    throw new ApiError(errorCode, res.status, errorMessage);
  }

  if (res.status === 204) {
    return null as T;
  }

  return res.json();
}

export const api = {
  async listPools(query = "", offset = 0, waters: Waters | "" = "") {
    return request<{ pools: PublicPool[]; nextOffset: number | null }>(
      `/v1/pools?q=${encodeURIComponent(query)}&offset=${offset}${waters ? `&waters=${waters}` : ""}`,
    );
  },

  async getPool(address: string) {
    return request<{ pool: PublicPool }>(`/v1/pools/${encodeURIComponent(address)}`);
  },
  async getV4Allowances(poolId: string, purpose: "mint" | "swap" = "mint") {
    return request<{ allowances: Array<{ token: string; balance: string; erc20: string;
      permit2: string; expiration: string }>; nativeBalance: string }>(
      `/v1/wallets/v4/pools/${encodeURIComponent(poolId)}/allowances?purpose=${purpose}`);
  },
  async prepareV4Approval(params: { poolId: string; token: string; stage: "erc20" | "permit2";
    amount: string; purpose?: "mint" | "swap"; idempotencyKey: string }) {
    return request<{ intentId: string; status: string; simulation: { gasEstimate: string } }>(
      "/v1/wallets/v4/approvals/prepare", { method: "POST", body: JSON.stringify(params) });
  },
  async prepareV4Mint(params: { poolId: string; amount0Desired: string; amount1Desired: string;
    tickLower: number; tickUpper: number; slippageBps: number; deadline: string;
    idempotencyKey: string }) {
    return request<{ intentId: string; status: string; simulation: { gasEstimate: string } }>(
      "/v1/wallets/v4/positions/mint/prepare", { method: "POST", body: JSON.stringify(params) });
  },
  async startRecentre(tokenId: string, band: RecentreBand, poolId: string) {
    return request<{ run: AutomationRun }>("/v1/automation/runs", {
      method: "POST", body: JSON.stringify({ tokenId, band, poolId }) });
  },
  async listMandates() {
    return request<{ mandates: Mandate[] }>("/v1/automation/mandates");
  },
  async saveMandate(mandate: Pick<Mandate, "poolId" | "mode" | "band" | "maxPositionUsd" | "maxRunsPerDay">) {
    return request<{ mandate: Mandate }>("/v1/automation/mandates", { method: "PUT", body: JSON.stringify(mandate) });
  },
  async revokeMandate(mandateId: string) {
    return request<{ revoked: boolean }>(`/v1/automation/mandates/${encodeURIComponent(mandateId)}`, { method: "DELETE" });
  },
  async answerProposal(runId: string, approve: boolean) {
    return request<{ runId: string; status: string }>(
      `/v1/automation/runs/${encodeURIComponent(runId)}/${approve ? "approve" : "decline"}`, { method: "POST" });
  },
  async listAutomationRuns() {
    return request<{ runs: AutomationRun[] }>("/v1/automation/runs");
  },
  async listV4Positions(page = 0) {
    return request<{ positions: V4Position[]; page: number; hasMore: boolean }>(`/v1/wallets/v4/positions?page=${page}`);
  },
  async prepareV4PositionAction(params: { action: "collect" | "withdraw";
    tokenId: string; slippageBps: number; deadline: string; idempotencyKey: string }) {
    return request<{ intentId: string; status: string; simulation: { gasEstimate: string } }>(
      "/v1/wallets/v4/positions/actions/prepare", { method: "POST", body: JSON.stringify(params) });
  },
  async quoteV4Swap(params: { poolId: string; tokenIn: string; amountIn: string; slippageBps: number }) {
    return request<{ expectedAmountOut: string; minimumAmountOut: string; tokenOut: string;
      allowance: { erc20: string; permit2: string; expiration: string } | null;
      nativeBalance: string; priceImpactBps: number }>("/v1/wallets/v4/swaps/quote", {
      method: "POST", body: JSON.stringify(params),
    });
  },
  async prepareV4Swap(params: { poolId: string; tokenIn: string; amountIn: string;
    slippageBps: number; minimumAmountOut: string; idempotencyKey: string }) {
    return request<{ intentId: string; expectedAmountOut: string;
      minimumAmountOut: string; gasEstimate: string }>("/v1/wallets/v4/swaps/prepare", {
      method: "POST", body: JSON.stringify(params),
    });
  },
  // Auth
  async issueChallenge(address: string) {
    return request<{ challengeId: string; message: string; expiresAt: number }>(
      "/v1/auth/challenge",
      {
        method: "POST",
        body: JSON.stringify({ address }),
      },
    );
  },

  async verifyChallenge(challengeId: string, message: string, signature: string) {
    return request<{ user: AuthUser; sessionExpiresAt: number }>(
      "/v1/auth/verify",
      {
        method: "POST",
        body: JSON.stringify({ challengeId, message, signature }),
      },
    );
  },

  async getMe() {
    return request<{ user: AuthUser }>("/v1/me");
  },

  async logout() {
    return request<void>("/v1/auth/logout", { method: "POST" });
  },

  // Managed Wallet
  async provisionWallet() {
    return request<ManagedWalletRecord>("/v1/wallets/provision", {
      method: "POST",
    });
  },

  async getMyWallet() {
    return request<{ wallet: ManagedWalletRecord }>("/v1/wallets/me");
  },

  async getWalletSummary() {
    return request<{ summary: WalletSummary }>("/v1/wallets/summary");
  },

  async getWalletAssets() {
    return request<{ assets: Array<{ address: string; symbol: string; decimals: number; raw: string }> }>(
      "/v1/wallets/assets",
    );
  },

  async getTokenBalance(tokenAddress: string) {
    return request<{ balance: string }>(
      `/v1/wallets/tokens/${encodeURIComponent(tokenAddress)}/balance`,
    );
  },

  async discoverTokenPools(tokenAddress: string) {
    return request<TokenPoolDiscovery>(
      `/v1/wallets/tokens/${encodeURIComponent(tokenAddress)}/pools`,
    );
  },

  async pauseWallet() {
    return request<{ status: string }>("/v1/wallets/pause", { method: "POST" });
  },

  /** USDC, or with `token` any other token the wallet holds. */
  async prepareWithdrawal(params: {
    token?: string;
    recipient: string;
    amount: string;
    nonce: string;
    expiresAt: number;
    signature: string;
  }) {
    return request<{ intentId: string; status: string; gasEstimate?: string; feeReserve?: string }>(
      "/v1/wallets/withdrawals/prepare",
      { method: "POST", body: JSON.stringify(params) },
    );
  },

  async getMaximumUsdcWithdrawal(recipient: string) {
    return request<{ maximum: string; feeReserve: string }>(
      "/v1/wallets/withdrawals/maximum",
      { method: "POST", body: JSON.stringify({ recipient }) },
    );
  },

  // Intents
  async prepareTokenApproval(params: {
    tokenAddress: string;
    poolAddress: string;
    poolTokenAddress?: string;
    spender?: "swap";
    amount: string;
    idempotencyKey: string;
  }) {
    return request<{
      intentId: string;
      status: string;
      token: string;
      tokenAddress: string;
      poolAddress: string | null;
      spender: string;
      amount: string;
      simulation: { gasEstimate: string; blockNumber: string };
    }>("/v1/wallets/approvals/prepare", {
      method: "POST",
      body: JSON.stringify(params),
    });
  },

  async quoteSwap(params: {
    tokenAddress: string;
    poolAddress: string;
    direction: "buy" | "sell";
    amountIn: string;
    slippageBps: number;
  }) {
    return request<{
      poolAddress: string;
      tokenIn: string;
      tokenOut: string;
      amountIn: string;
      expectedAmountOut: string;
      minimumAmountOut: string;
      priceImpactBps: number;
      allowance: string;
      nativeBalance: string;
      blockNumber: string;
    }>("/v1/wallets/swaps/quote", { method: "POST", body: JSON.stringify(params) });
  },

  async prepareSwap(params: {
    tokenAddress: string;
    poolAddress: string;
    direction: "buy" | "sell";
    amountIn: string;
    slippageBps: number;
    idempotencyKey: string;
  }) {
    return request<{ intentId: string; status: string; gasEstimate?: string;
      expectedAmountOut?: string; minimumAmountOut?: string }>(
      "/v1/wallets/swaps/prepare",
      { method: "POST", body: JSON.stringify(params) },
    );
  },

  async prepareTokenMint(params: {
    tokenAddress: string;
    poolAddress: string;
    tickLower: number;
    tickUpper: number;
    amountToken: string;
    amountUsdc: string;
    slippageBps: number;
    deadline: string;
    idempotencyKey: string;
  }) {
    return request<{
      intentId: string;
      status: string;
      transaction: { chainId: number; to: string; data: string; value: string };
      constraints: {
        tokenAddress: string;
        poolAddress: string;
        token0: string;
        token1: string;
        fee: number;
        tickLower: number;
        tickUpper: number;
        amount0Min: string;
        amount1Min: string;
        deadline: string;
      };
      simulation: {
        gasEstimate: string;
        tokenId: string;
        liquidity: string;
        amount0: string;
        amount1: string;
        blockNumber: string;
      };
    }>("/v1/wallets/positions/mint/prepare", {
      method: "POST",
      body: JSON.stringify(params),
    });
  },

  async preparePositionAction(params: {
    kind: "increase" | "decrease" | "collect" | "withdraw";
    action?: "increase" | "decrease" | "collect" | "withdraw";
    tokenId: string;
    // The position's token0 and token1 amounts, whichever tokens those are.
    amount0?: string;
    amount1?: string;
    liquidity?: string;
    expected0?: string;
    expected1?: string;
    slippageBps?: number;
    deadline?: string;
    idempotencyKey: string;
  }) {
    return request<{
      intentId: string;
      status: string;
      action: { kind: string; tokenId: string };
      simulation: { gasEstimate: string; output: unknown };
      existing?: boolean;
    }>("/v1/wallets/positions/actions/prepare", {
      method: "POST",
      body: JSON.stringify({
        ...params,
        action: params.action ?? params.kind,
      }),
    });
  },

  async executeIntent(intentId: string) {
    return request<{
      attemptId: string;
      intentId: string;
      status: string;
      transactionHash: string;
      nonce: number;
    }>(`/v1/wallets/intents/${intentId}/execute`, {
      method: "POST",
    });
  },

  async reconcileAttempt(attemptId: string) {
    return request<{
      attemptId: string;
      intentId: string;
      status: string;
      reasonCode: string;
      transactionHash: string;
      blockNumber?: number | null;
    }>(`/v1/wallets/attempts/${attemptId}/reconcile`, {
      method: "POST",
    });
  },
};
