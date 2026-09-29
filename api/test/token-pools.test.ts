import { ContractFunctionRevertedError, encodeEventTopics, getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  ARC_TOKENS,
  UNISWAP_V3_ARC,
  UNISWAP_V4_ARC,
  v4PositionManagerReadAbi,
  v4PoolId,
  type ChainReadClient,
} from "@stillwater/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src";

const owner = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");
const pool = getAddress("0x3333333333333333333333333333333333333333");

describe("token pool discovery route", () => {
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
    const db = { prepare(sql: string) { return { bind() { return this; },
      async first() { return sql.includes("managed_wallets") ? { id: "wallet-1", address: owner } : row; },
      async all() { return { results: [{ transaction_hash: `0x${"ab".repeat(32)}`,
        minted_pool_id: poolId, ...row }] }; },
    }; } } as unknown as D1Database;
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
      pool: { address: poolId, token: { symbol: "MEME" } } }] });
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

  it("lists v3 and v4 pools together with sourced metrics", async () => {
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
    const response = await createApp().request("/v1/pools?q=MEME", {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pools: [{ address: pool, token: { address: token, symbol: "MEME" },
        usdcReserve: "4000000", blockNumber: 123 },
      { protocol: "uniswap-v4", address: v4Id, usdcReserve: null,
        blockNumber: 124 }],
      nextOffset: null,
    });
    expect(statement.bind).toHaveBeenCalledWith("MEME", "%MEME%", 0);
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
    const response = await createApp().request(`/v1/pools?q=${token}`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pools: [{ protocol: "uniswap-v4",
      address: poolId, hooks: zeroAddress, usdcReserve: null,
      token: { address: token, symbol: "MEME" } }] });
    expect(statement.bind).toHaveBeenCalledWith(token, `%${token}%`, 0);
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
      async simulateContract() { return { result: [1000n, 100_000n] }; },
      async getBalance() { return 10n ** 18n; },
      async call() { return { data: "0x" }; },
      async estimateGas() { return 100_000n; },
      async estimateFeesPerGas() { return { maxFeePerGas: 1_000_000_000n }; },
    } as unknown as ChainReadClient;
    const env = { DB: db, SIGNER: {} as Fetcher, AUTH_URI: "http://localhost:8787", ARC_RPC_URL: "https://rpc.mainnet.arc.io" } satisfies Bindings;
    const app = createApp({ createAuthStore: () => authStore, createChainClient: () => chainClient });
    const headers = { cookie: `stillwater_session=${sessionToken}`, "content-type": "application/json" };
    const request = { poolId, tokenIn: zeroAddress, amountIn: "100000000000000000", slippageBps: 100 };
    const quote = await app.request("/v1/wallets/v4/swaps/quote", {
      method: "POST", headers, body: JSON.stringify(request),
    }, env);
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({ expectedAmountOut: "1000", minimumAmountOut: "990" });
    const stale = await app.request("/v1/wallets/v4/swaps/prepare", {
      method: "POST", headers, body: JSON.stringify({ ...request,
        minimumAmountOut: "900", idempotencyKey: "v4-test-idempotency-1" }),
    }, env);
    expect(stale.status).toBe(422);
    expect(await stale.json()).toEqual({ error: "V4_QUOTE_STALE" });
    const prepared = await app.request("/v1/wallets/v4/swaps/prepare", {
      method: "POST", headers, body: JSON.stringify({ ...request,
        minimumAmountOut: "990", idempotencyKey: "v4-test-idempotency-2" }),
    }, env);
    expect(prepared.status).toBe(201);
    expect(await prepared.json()).toMatchObject({ minimumAmountOut: "990" });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("INSERT INTO v4_swap_intents");
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
