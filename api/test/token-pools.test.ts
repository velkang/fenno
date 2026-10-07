import { ContractFunctionRevertedError, encodeEventTopics, getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ARC_TOKENS,
  ARC_WATERS,
  UNISWAP_V3_ARC,
  canSpendArcUsdc,
  UNISWAP_V4_ARC,
  v4PositionManagerReadAbi,
  v4PoolId,
  tokenWithdrawalTypes,
  withdrawalDomain,
  type ChainReadClient,
} from "@stillwater/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src";

const owner = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");
const pool = getAddress("0x3333333333333333333333333333333333333333");

describe("token pool discovery route", () => {
  it("offers a maximum withdrawal that still passes the prepare-time fee check", async () => {
    // Measured on Arc: a 1-unit USDC transfer estimates 49,097 gas, a near-full one 49,121.
    const sessionToken = "withdrawal-max-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const wallet = getAddress("0x4444444444444444444444444444444444444444");
    const authStore = { findSessionUser: async (value: string) =>
      value === sessionHash ? { id: "user-1", ownerAddress: owner } : null } as unknown as AuthStore;
    const db = { prepare() { return { bind() { return this; },
      async first() { return { address: wallet, state: "active" }; } }; } } as unknown as D1Database;
    const balance = 7_456_314_456_657_857_000n;
    const maxFeePerGas = 40_000_000_000n;
    const chainClient = {
      async getBalance() { return balance; },
      async estimateGas() { return 49_097n; },
      async estimateFeesPerGas() { return { maxFeePerGas }; },
    } as unknown as ChainReadClient;
    const env = { DB: db, SIGNER: {} as Fetcher, AUTH_URI: "http://localhost:8787" } satisfies Bindings;
    const response = await createApp({ createAuthStore: () => authStore, createChainClient: () => chainClient })
      .request("/v1/wallets/withdrawals/maximum", { method: "POST",
        headers: { cookie: `stillwater_session=${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ recipient: owner }) }, env);
    expect(response.status).toBe(200);
    const { maximum } = await response.json() as { maximum: string };
    const prepareReserve = (49_121n * 120n * maxFeePerGas + 99n) / 100n;
    expect(canSpendArcUsdc(balance, BigInt(maximum), prepareReserve)).toBe(true);
  });

  it("prepares a withdrawal of another token only with the owner's signature for it", async () => {
    const sessionToken = "token-withdrawal-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const wallet = getAddress("0x4444444444444444444444444444444444444444");
    const authStore = { findSessionUser: async (value: string) =>
      value === sessionHash ? { id: "user-1", ownerAddress: ownerAccount.address } : null } as unknown as AuthStore;
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) { const statement = { sql, args: [] as unknown[],
        bind(...args: unknown[]) { statement.args = args; return statement; },
        async first() { return sql.includes("FROM managed_wallets")
          ? { id: "wallet-1", address: wallet, state: "paused", owner_address: ownerAccount.address } : null; } };
        return statement; },
      async batch(statements: Array<{ sql: string; args: unknown[] }>) { writes.push(...statements); return []; },
    } as unknown as D1Database;
    const chainClient = {
      async getBalance() { return 10n ** 17n; }, // 0.1 USDC for the network fee
      async readContract() { return 2_545n; }, // the wallet's token balance
      async estimateGas() { return 50_000n; },
      async estimateFeesPerGas() { return { maxFeePerGas: 40_000_000_000n }; },
    } as unknown as ChainReadClient;
    const env = { DB: db, SIGNER: {} as Fetcher, AUTH_URI: "http://localhost:8787" } satisfies Bindings;
    const app = createApp({ createAuthStore: () => authStore, createChainClient: () => chainClient, now: () => 2_000_000_000_000 });
    const message = { wallet, token, recipient: owner, amount: 2_545n, nonce: `0x${"55".repeat(32)}` as const,
      expiresAt: 2_000_000_120n };
    const signature = await ownerAccount.signTypedData({ domain: withdrawalDomain, types: tokenWithdrawalTypes,
      primaryType: "TokenWithdrawal", message });
    const prepare = (body: Record<string, unknown>) => app.request("/v1/wallets/withdrawals/prepare", { method: "POST",
      headers: { cookie: `stillwater_session=${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, recipient: owner, amount: "2545", nonce: message.nonce, expiresAt: 2_000_000_120,
        signature, ...body }) }, env);

    // A paused wallet can still take its money out.
    const prepared = await prepare({});
    expect(prepared.status).toBe(201);
    const [intent, detail] = writes;
    expect(intent!.args).toContain("token_withdrawal");
    expect(detail!.sql).toContain("INSERT INTO usdc_withdrawal_intents");
    expect(detail!.args).toContain(token);

    // The same signature can't move a different token or a larger amount, and the balance must cover it.
    expect((await prepare({ token: getAddress("0x5555555555555555555555555555555555555555") })).status).toBe(403);
    expect((await prepare({ amount: "2546" })).status).toBe(403);
    const tooMuch = await ownerAccount.signTypedData({ domain: withdrawalDomain, types: tokenWithdrawalTypes,
      primaryType: "TokenWithdrawal", message: { ...message, amount: 2_546n } });
    const short = await prepare({ amount: "2546", signature: tooMuch });
    expect(short.status).toBe(422);
    expect(await short.json()).toEqual({ error: "INSUFFICIENT_TOKEN_BALANCE" });
  });

  it("returns the signed-in wallet's live balance of any token", async () => {
    const sessionToken = "token-balance-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const wallet = getAddress("0x4444444444444444444444444444444444444444");
    const authStore = { findSessionUser: async (value: string) =>
      value === sessionHash ? { id: "user-1", ownerAddress: owner } : null } as unknown as AuthStore;
    const db = { prepare() { return { bind() { return this; },
      async first() { return { id: "wallet-1", address: wallet }; } }; } } as unknown as D1Database;
    const readContract = vi.fn(async () => 493_648n * 10n ** 18n);
    const env = { DB: db, SIGNER: {} as Fetcher, AUTH_URI: "http://localhost:8787" } satisfies Bindings;
    const app = createApp({ createAuthStore: () => authStore,
      createChainClient: () => ({ readContract }) as unknown as ChainReadClient });
    const headers = { cookie: `stillwater_session=${sessionToken}` };

    const response = await app.request(`/v1/wallets/tokens/${token}/balance`, { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ balance: (493_648n * 10n ** 18n).toString() });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: token,
      functionName: "balanceOf", args: [wallet] }));

    const invalid = await app.request("/v1/wallets/tokens/not-a-token/balance", { headers }, env);
    expect(invalid.status).toBe(400);
  });

  it("lists only confirmed Stillwater-minted v4 NFTs still owned by the wallet", async () => {
    const sessionToken = "v4-position-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (value: string) =>
      value === sessionHash ? { id: "user-1", ownerAddress: owner } : null } as unknown as AuthStore;
    const key = { currency0: zeroAddress, currency1: token, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const poolId = v4PoolId(key);
    const row = { pool_id: poolId, currency0: zeroAddress, currency1: token,
      fee: 3000, tick_spacing: 60, hooks: zeroAddress, token_address: token,
      token_symbol: "MEME", token_decimals: 18, sqrt_price_x96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000", lp_fee: 3000, block_number: 100, updated_at: 123 };
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const db = { prepare(sql: string) { return { sql, args: [] as unknown[],
      bind(...args: unknown[]) { this.args = args; return this; },
      async first() { return sql.includes("managed_wallets") ? { id: "wallet-1", address: owner } : row; },
      async all() { return { results: [{ transaction_hash: `0x${"ab".repeat(32)}`,
        minted_pool_id: poolId, intent_id: "intent-1", token_id: null, ...row }] }; },
    }; }, async batch(statements: Array<{ sql: string; args: unknown[] }>) {
      writes.push(...statements); return []; } } as unknown as D1Database;
    const topics = encodeEventTopics({ abi: v4PositionManagerReadAbi, eventName: "Transfer",
      args: { from: zeroAddress, to: owner, tokenId: 7n } });
    const chainClient = {
      async getBlock() { return { number: 100n }; },
      async getTransactionReceipt() { return { logs: [{ address: UNISWAP_V4_ARC.positionManager,
        topics, data: "0x" }] }; },
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getPoolAndPositionInfo") return [key,
          (((1n << 24n) - 60n) << 8n) | (60n << 32n)];
        if (functionName === "getPositionLiquidity") return 100_000n;
        if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
        if (functionName === "getLiquidity") return 1_000_000n;
        // Fee growth inside the range rose by 3 (×2¹²⁸) for currency0 since the position settled.
        if (functionName === "getFeeGrowthInside") return [5n * 2n ** 128n, 3n * 2n ** 128n];
        if (functionName === "getPositionInfo") return [100_000n, 2n * 2n ** 128n, 3n * 2n ** 128n];
        throw new Error("Unexpected read");
      },
    } as unknown as ChainReadClient;
    const env = { DB: db, SIGNER: {} as Fetcher, AUTH_URI: "http://localhost:8787", ARC_RPC_URL: "https://rpc.mainnet.arc.io" } satisfies Bindings;
    const response = await createApp({ createAuthStore: () => authStore,
      createChainClient: () => chainClient }).request("/v1/wallets/v4/positions", {
      headers: { cookie: `stillwater_session=${sessionToken}` },
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ positions: [{ tokenId: "7",
      tickLower: -60, tickUpper: 60, liquidity: "100000",
      fees: { amount0: "300000", amount1: "0" },
      pool: { address: poolId, token: { symbol: "MEME" } } }] });
    // A mint confirmed before token ids were recorded keeps its id once the receipt is read.
    expect(writes).toEqual([expect.objectContaining({ args: ["intent-1", "7"] })]);
    expect(writes[0].sql).toContain("UPDATE v4_mint_intents SET token_id");
  });

  it("lists v4 NFTs from recorded token ids and skips mints whose receipt is unreadable", async () => {
    const sessionToken = "v4-pruned-receipt-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (value: string) =>
      value === sessionHash ? { id: "user-1", ownerAddress: owner } : null } as unknown as AuthStore;
    const key = { currency0: zeroAddress, currency1: token, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const poolId = v4PoolId(key);
    const row = { pool_id: poolId, currency0: zeroAddress, currency1: token,
      fee: 3000, tick_spacing: 60, hooks: zeroAddress, token_address: token,
      token_symbol: "MEME", token_decimals: 18, sqrt_price_x96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000", lp_fee: 3000, block_number: 100, updated_at: 123 };
    const db = { prepare(sql: string) { return { bind() { return this; },
      async first() { return { id: "wallet-1", address: owner }; },
      async all() { return { results: [
        { transaction_hash: `0x${"ab".repeat(32)}`, minted_pool_id: poolId,
          intent_id: "intent-1", token_id: "7", ...row },
        { transaction_hash: `0x${"cd".repeat(32)}`, minted_pool_id: poolId,
          intent_id: "intent-2", token_id: null, ...row },
      ] }; },
    }; }, async batch() { throw new Error("Unexpected write"); } } as unknown as D1Database;
    // The RPC no longer keeps either mint's receipt.
    const getTransactionReceipt = vi.fn(async () => { throw new Error("Receipt not found"); });
    const chainClient = {
      async getBlock() { return { number: 100n }; },
      getTransactionReceipt,
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getPoolAndPositionInfo") return [key,
          (((1n << 24n) - 60n) << 8n) | (60n << 32n)];
        if (functionName === "getPositionLiquidity") return 100_000n;
        if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
        if (functionName === "getLiquidity") return 1_000_000n;
        throw new Error("Unexpected read");
      },
    } as unknown as ChainReadClient;
    const env = { DB: db, SIGNER: {} as Fetcher, AUTH_URI: "http://localhost:8787" } satisfies Bindings;
    const response = await createApp({ createAuthStore: () => authStore,
      createChainClient: () => chainClient }).request("/v1/wallets/v4/positions", {
      headers: { cookie: `stillwater_session=${sessionToken}` },
    }, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { positions: Array<{ tokenId: string }> };
    expect(body.positions.map((position) => position.tokenId)).toEqual(["7"]);
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: `0x${"cd".repeat(32)}` });
  });

  it("prepares a v4 full withdrawal only for an owned position that simulates", async () => {
    const sessionToken = "v4-action-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (value: string) =>
      value === sessionHash ? { id: "user-1", ownerAddress: owner } : null } as unknown as AuthStore;
    const key = { currency0: zeroAddress, currency1: token, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const poolId = v4PoolId(key);
    const row = { pool_id: poolId, currency0: zeroAddress, currency1: token,
      fee: 3000, tick_spacing: 60, hooks: zeroAddress, token_address: token,
      token_symbol: "MEME", token_decimals: 18 };
    const writes: string[] = [];
    const db = { prepare(sql: string) { return { sql, bind() { return this; },
      async first() { return sql.includes("managed_wallets")
        ? { id: "wallet-1", address: owner, state: "paused" }
        : sql.includes("v4_pool_directory") ? row : null; },
    }; }, async batch(statements: Array<{ sql: string }>) {
      writes.push(...statements.map((statement) => statement.sql)); return []; },
    } as unknown as D1Database;
    const chainClient = {
      async getBlock() { return { number: 100n, hash: `0x${"ab".repeat(32)}` }; },
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getPoolAndPositionInfo") return [key,
          (((1n << 24n) - 60n) << 8n) | (60n << 32n)];
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
    const env = { DB: db, SIGNER: {} as Fetcher, AUTH_URI: "http://localhost:8787", ARC_RPC_URL: "https://rpc.mainnet.arc.io" } satisfies Bindings;
    const app = createApp({ createAuthStore: () => authStore,
      createChainClient: () => chainClient, now: () => 2_000_000_000_000 });
    const response = await app.request("/v1/wallets/v4/positions/actions/prepare", {
      method: "POST", headers: { cookie: `stillwater_session=${sessionToken}`,
        "content-type": "application/json" }, body: JSON.stringify({ action: "withdraw",
        tokenId: "7", slippageBps: 100, deadline: "2000000600",
        idempotencyKey: "v4-action-idempotency-1" }),
    }, env);
    expect(response.status).toBe(201);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("INSERT INTO v4_position_action_intents");
  });
  it("returns a recoverable error when a selected pool cannot quote the swap", async () => {
    const sessionToken = "test-session-token";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = {
      findSessionUser: async (value: string) =>
        value === sessionHash ? { id: "user-1", ownerAddress: owner } : null,
    } as unknown as AuthStore;
    const statement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ id: "wallet-1", address: owner, state: "active" }),
    };
    const chainClient = {
      getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
      getCode: async ({ address }: { address: Address }) =>
        address === UNISWAP_V3_ARC.factory.address || address === token || address === pool ? "0x6000" : "0x",
      getBalance: async () => 10n ** 18n,
      simulateContract: async () => {
        throw new ContractFunctionRevertedError({
          abi: parseAbi(["function quoteExactInputSingle()"]),
          functionName: "quoteExactInputSingle",
          message: "TF",
        });
      },
      readContract: async ({ address, functionName, args = [] }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (address === token) {
          if (functionName === "decimals") return 18;
          if (functionName === "symbol") return "MEME";
          if (functionName === "balanceOf") return 0n;
          if (functionName === "allowance") return 0n;
        }
        if (address === ARC_TOKENS.USDC.address) {
          if (functionName === "decimals") return 6;
          if (functionName === "symbol") return "USDC";
          if (functionName === "balanceOf") return 2_000_000n;
          if (functionName === "allowance") return 0n;
        }
        if (address === UNISWAP_V3_ARC.factory.address && functionName === "getPool") {
          return (args[2] as number) === 500 ? pool : zeroAddress;
        }
        if (address === pool) {
          if (functionName === "slot0") return [1n << 96n, 0, 0, 0, 0, 0, true];
          if (functionName === "liquidity") return 20n;
          if (functionName === "token0") return token;
          if (functionName === "token1") return ARC_TOKENS.USDC.address;
          if (functionName === "fee") return 500;
          if (functionName === "tickSpacing") return 10;
        }
        throw new Error(`Unexpected call ${functionName}`);
      },
    } as unknown as ChainReadClient;
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
      ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    } satisfies Bindings;
    const app = createApp({ createAuthStore: () => authStore, createChainClient: () => chainClient });
    const response = await app.request("/v1/wallets/swaps/quote", {
      method: "POST",
      headers: { cookie: `stillwater_session=${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ tokenAddress: token, poolAddress: pool,
        direction: "buy", amountIn: "2000000", slippageBps: 100 }),
    }, env);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "POOL_QUOTE_UNAVAILABLE" });
  });

  it("lists v3 and v4 pools together, newest first, with their live on-chain state", async () => {
    const v4Id = `0x${"ab".repeat(32)}`;
    const statement = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [{
        protocol: "uniswap-v3", address: pool,
        token_address: token,
        token_symbol: "MEME",
        token_decimals: 18,
        token0: token,
        token1: ARC_TOKENS.USDC.address,
        fee: 500,
        tick_spacing: 10,
        sqrt_price_x96: "79228162514264337593543950336",
        tick: 0,
        liquidity: "99",
        usdc_reserve: "4000000",
        hooks: null, lp_fee: null,
        block_number: 123,
        updated_at: 456,
      }, {
        protocol: "uniswap-v4", address: v4Id,
        token_address: token, token_symbol: "MEME", token_decimals: 18,
        token0: zeroAddress, token1: token, fee: 3000, tick_spacing: 60,
        sqrt_price_x96: (2n ** 96n).toString(), tick: 0, liquidity: "99",
        usdc_reserve: null, hooks: zeroAddress, lp_fee: 3000,
        block_number: 124, updated_at: 457,
      }] }),
    };
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
      ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    } satisfies Bindings;
    const chainClient = { multicall: async () => [
      { status: "success", result: [2n ** 96n, 5] }, { status: "success", result: 777n },
      { status: "success", result: 5_000_000n },
      { status: "success", result: [2n ** 96n, 9, 0, 3000] }, { status: "success", result: 888n },
    ] } as unknown as ChainReadClient;
    const response = await createApp({ createChainClient: () => chainClient })
      .request("/v1/pools?q=MEME", {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pools: [{ address: pool, token: { address: token, symbol: "MEME" },
        tick: 5, liquidity: "777", usdcReserve: "5000000", blockNumber: 123 },
      { protocol: "uniswap-v4", address: v4Id, tick: 9, liquidity: "888", usdcReserve: null,
        blockNumber: 124 }],
      nextOffset: null,
    });
    // A symbol is searched from its start, as a range the symbol index can serve.
    expect(statement.bind).toHaveBeenCalledWith("MEME", "MEME\u{10FFFF}", 0, "", "[]");
    const sql = vi.mocked(env.DB.prepare).mock.calls[0]?.[0];
    expect(sql).toContain("ORDER BY created_block DESC");
    expect(sql).toContain("token_symbol COLLATE NOCASE >= ?1 AND token_symbol COLLATE NOCASE < ?2");
    expect(sql).not.toContain("LIKE");
  });

  it("leaves out a listed pool whose liquidity has since dropped to zero: it cannot be traded", async () => {
    const drainedId = `0x${"cd".repeat(32)}`;
    const liveId = `0x${"ab".repeat(32)}`;
    const row = (address: string) => ({
      protocol: "uniswap-v4", address, token_address: token, token_symbol: "MEME", token_decimals: 18,
      token0: zeroAddress, token1: token, fee: 3000, tick_spacing: 60,
      sqrt_price_x96: (2n ** 96n).toString(), tick: 0, liquidity: "99", // stored when it still had liquidity
      usdc_reserve: null, hooks: zeroAddress, lp_fee: 3000, block_number: 124, updated_at: 457,
    });
    const statement = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [row(drainedId), row(liveId)] }),
    };
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
    } satisfies Bindings;
    const chainClient = { multicall: async () => [
      { status: "success", result: [2n ** 96n, 9, 0, 3000] }, { status: "success", result: 0n },
      { status: "success", result: [2n ** 96n, 9, 0, 3000] }, { status: "success", result: 888n },
    ] } as unknown as ChainReadClient;
    const response = await createApp({ createChainClient: () => chainClient }).request("/v1/pools", {}, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { pools: Array<{ address: string }> };
    expect(body.pools.map((entry) => entry.address)).toEqual([liveId]);
  });

  it("lists indexed v4 pools by token address without inventing a reserve", async () => {
    const poolId = `0x${"ab".repeat(32)}`;
    const statement = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [{
        protocol: "uniswap-v4", address: poolId, token0: zeroAddress, token1: token,
        fee: 3000, tick_spacing: 60, hooks: zeroAddress,
        token_address: token, token_symbol: "MEME", token_decimals: 18,
        sqrt_price_x96: (2n ** 96n).toString(), tick: 0, liquidity: "99",
        lp_fee: 3000, usdc_reserve: null, block_number: 123, updated_at: 456,
      }] }),
    };
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
      ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    } satisfies Bindings;
    // Failed live reads leave the stored state in place.
    const chainClient = { multicall: async () => [{ status: "failure" }, { status: "failure" }] } as unknown as ChainReadClient;
    const response = await createApp({ createChainClient: () => chainClient }).request(`/v1/pools?q=${token}`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pools: [{ protocol: "uniswap-v4",
      address: poolId, hooks: zeroAddress, usdcReserve: null, liquidity: "99",
      token: { address: token, symbol: "MEME" } }] });
    expect(statement.bind).toHaveBeenCalledWith(token, `${token}\u{10FFFF}`, 0, "", "[]");
    // An address is an equality lookup on the token index or the pool key.
    expect(vi.mocked(env.DB.prepare).mock.calls[0]?.[0]).toContain("(token_address = ?1 OR pool_id = ?1)");
  });

  it("filters the listing by waters using the fixed tier addresses", async () => {
    const statement = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [] }) };
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
    } satisfies Bindings;
    const app = createApp({ createChainClient: () => ({ multicall: async () => [] }) as unknown as ChainReadClient });
    await app.request("/v1/pools?waters=gentle", {}, env);
    await app.request("/v1/pools?waters=rapids", {}, env);
    await app.request("/v1/pools?waters=anything", {}, env);
    const [gentle, rapids, ignored] = statement.bind.mock.calls;
    expect(gentle?.[3]).toBe("gentle");
    expect(JSON.parse(gentle?.[4] as string)).toEqual(ARC_WATERS.gentle);
    // Rapids is everything outside both calmer lists.
    expect(rapids?.[3]).toBe("rapids");
    expect(JSON.parse(rapids?.[4] as string)).toEqual([...ARC_WATERS.still, ...ARC_WATERS.gentle]);
    expect(ignored?.[3]).toBe("");
  });

  it("looks up a pasted token the directory does not list yet through the indexer", async () => {
    const poolId = `0x${"cd".repeat(32)}`;
    const row = { protocol: "uniswap-v4", address: poolId, token0: zeroAddress, token1: token,
      fee: 8_388_608, tick_spacing: 200, hooks: zeroAddress, token_address: token, token_symbol: "HOMER",
      token_decimals: 18, sqrt_price_x96: (2n ** 96n).toString(), tick: 0, liquidity: "99",
      lp_fee: 0, usdc_reserve: null, block_number: 123, updated_at: 456, created_block: 120 };
    const statement = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({ results: [row] }),
    };
    const indexer = { fetch: vi.fn(async () => Response.json({ found: 1 })) };
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
      INDEXER: indexer as unknown as Fetcher,
    } satisfies Bindings;
    const chainClient = { multicall: async () => [] } as unknown as ChainReadClient;
    const response = await createApp({ createChainClient: () => chainClient }).request(`/v1/pools?q=${token}`, {}, env);

    expect(await response.json()).toMatchObject({ pools: [{ address: poolId, createdBlock: 120,
      token: { symbol: "HOMER" } }] });
    const request = (indexer.fetch.mock.calls as unknown as Request[][])[0]![0]!;
    expect(new URL(request.url).pathname).toBe("/internal/v1/pools/discover");
    expect(await request.json()).toEqual({ tokenAddress: token });
  });

  it("quotes a native-USDC v4 swap and rejects a stale reviewed minimum", async () => {
    const sessionToken = "v4-swap-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (value: string) =>
      value === sessionHash ? { id: "user-1", ownerAddress: owner } : null } as unknown as AuthStore;
    const key = { currency0: zeroAddress, currency1: token, fee: 3000,
      tickSpacing: 60, hooks: zeroAddress };
    const poolId = v4PoolId(key);
    const row = { pool_id: poolId, ...key, tick_spacing: 60,
      token_address: token, token_symbol: "MEME", token_decimals: 18 };
    const writes: string[] = [];
    const db = { prepare(sql: string) { return {
      bind() { return this; },
      async first() { return sql.includes("wallet_intents") ? null :
        sql.includes("v4_pool_directory") ? row :
        { id: "wallet-1", address: owner, state: "active" }; },
      sql,
    }; },
    async batch(statements: Array<{ sql: string }>) { writes.push(...statements.map((statement) => statement.sql)); return []; },
    } as unknown as D1Database;
    const chainClient = {
      async getBlock() { return { number: 100n, hash: `0x${"ab".repeat(32)}` }; },
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 3000];
        if (functionName === "getLiquidity") return 1_000_000n;
        throw new Error(`Unexpected ${functionName}`);
      },
      // At one raw token per raw USDC, 0.3% fee: what a pool filling at its price returns.
      async simulateContract() { return { result: [quotedOut, 100_000n] }; },
      async getBalance() { return 10n ** 18n; },
      async call() { return { data: "0x" }; },
      async estimateGas() { return 100_000n; },
      async estimateFeesPerGas() { return { maxFeePerGas: 1_000_000_000n }; },
    } as unknown as ChainReadClient;
    let quotedOut = 99_700n;
    const env = { DB: db, SIGNER: {} as Fetcher, AUTH_URI: "http://localhost:8787", ARC_RPC_URL: "https://rpc.mainnet.arc.io" } satisfies Bindings;
    const app = createApp({ createAuthStore: () => authStore, createChainClient: () => chainClient });
    const headers = { cookie: `stillwater_session=${sessionToken}`, "content-type": "application/json" };
    const request = { poolId, tokenIn: zeroAddress, amountIn: "100000", slippageBps: 100 };
    const quote = await app.request("/v1/wallets/v4/swaps/quote", {
      method: "POST", headers, body: JSON.stringify(request),
    }, env);
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({ expectedAmountOut: "99700", minimumAmountOut: "98703",
      priceImpactBps: 0 });
    const stale = await app.request("/v1/wallets/v4/swaps/prepare", {
      method: "POST", headers, body: JSON.stringify({ ...request,
        minimumAmountOut: "90000", idempotencyKey: "v4-test-idempotency-1" }),
    }, env);
    expect(stale.status).toBe(422);
    expect(await stale.json()).toEqual({ error: "V4_QUOTE_STALE" });
    const prepared = await app.request("/v1/wallets/v4/swaps/prepare", {
      method: "POST", headers, body: JSON.stringify({ ...request,
        minimumAmountOut: "98703", idempotencyKey: "v4-test-idempotency-2" }),
    }, env);
    expect(prepared.status).toBe(201);
    expect(await prepared.json()).toMatchObject({ minimumAmountOut: "98703" });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("INSERT INTO v4_swap_intents");

    // A pool that can only fill a sliver of the trade: refused before anything is prepared.
    quotedOut = 900n;
    for (const path of ["/v1/wallets/v4/swaps/quote", "/v1/wallets/v4/swaps/prepare"]) {
      const response = await app.request(path, { method: "POST", headers, body: JSON.stringify({ ...request,
        minimumAmountOut: "891", idempotencyKey: "v4-test-idempotency-3" }) }, env);
      expect(response.status, path).toBe(422);
      expect(await response.json()).toEqual({ error: "PRICE_IMPACT_TOO_HIGH" });
    }
    expect(writes).toHaveLength(2);
  });

  it("returns compatibility data for a pasted CA without a safety decision", async () => {
    const sessionToken = "test-session-token";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = {
      findSessionUser: async (value: string) =>
        value === sessionHash ? { id: "user-1", ownerAddress: owner } : null,
    } as unknown as AuthStore;
    const statement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ address: owner }),
    };
    const chainClient = {
      getCode: async ({ address }: { address: Address }) =>
        address === UNISWAP_V3_ARC.factory.address || address === token || address === pool ? "0x6000" : "0x",
      getBalance: async () => 0n,
      simulateContract: async () => ({ result: true }),
      readContract: async ({ address, functionName, args = [] }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (address === token) {
          if (functionName === "decimals") return 18;
          if (functionName === "symbol") return "MEME";
          if (functionName === "balanceOf") return 10n;
          if (functionName === "allowance") return 2n;
        }
        if (address === ARC_TOKENS.USDC.address) {
          if (functionName === "decimals") return 6;
          if (functionName === "symbol") return "USDC";
          if (functionName === "balanceOf") return 4n;
          if (functionName === "allowance") return 1n;
        }
        if (address === UNISWAP_V3_ARC.factory.address && functionName === "getPool") {
          return (args[2] as number) === 500 ? pool : zeroAddress;
        }
        if (address === pool) {
          if (functionName === "slot0") return [1n, 0, 0, 0, 0, 0, true];
          if (functionName === "liquidity") return 20n;
          if (functionName === "token0") return token;
          if (functionName === "token1") return ARC_TOKENS.USDC.address;
          if (functionName === "fee") return 500;
          if (functionName === "tickSpacing") return 10;
        }
        throw new Error(`Unexpected call ${functionName}`);
      },
    } as unknown as ChainReadClient;
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
      AUTH_COOKIE_SECURE: "false",
      ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    } satisfies Bindings;
    const app = createApp({ createAuthStore: () => authStore, createChainClient: () => chainClient });

    const response = await app.request(
      `/v1/wallets/tokens/${token}/pools`,
      { headers: { cookie: `stillwater_session=${sessionToken}` } },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token: { address: token, symbol: "MEME", decimals: 18, balance: "10", allowance: "2" },
      pools: [{ address: pool, fee: 500, tickSpacing: 10 }],
    });
  });
});
