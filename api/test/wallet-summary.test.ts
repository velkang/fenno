import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ARC_TOKENS, UNISWAP_V3_ARC, type ChainReadClient } from "@stillwater/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src";

const managedAddress = "0x1111111111111111111111111111111111111111" as Address;

describe("wallet summary", () => {
  it("maps an Arc RPC failure to a stable gateway error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sessionToken = "test-session-token";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = {
      findSessionUser: async (value: string) =>
        value === sessionHash
          ? { id: "user-1", ownerAddress: managedAddress }
          : null,
    } as unknown as AuthStore;
    const chainError = new Error("RPC unavailable");
    const chainClient = {
      getBalance: async () => {
        throw chainError;
      },
      readContract: async () => {
        throw chainError;
      },
      simulateContract: async () => {
        throw chainError;
      },
    } as ChainReadClient;
    const statement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ id: "wallet-1", address: managedAddress }),
      all: vi.fn().mockResolvedValue({ results: [{ token0_address: "0x2222222222222222222222222222222222222222",
        token1_address: ARC_TOKENS.USDC.address, fee: 3_000 }] }),
    };
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
      AUTH_COOKIE_SECURE: "false",
      ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    } satisfies Bindings;
    const app = createApp({
      createAuthStore: () => authStore,
      createChainClient: () => chainClient,
    });

    const response = await app.request(
      "/v1/wallets/summary",
      { headers: { cookie: `stillwater_session=${sessionToken}` } },
      env,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "CHAIN_READ_FAILED" });
    expect(consoleError).toHaveBeenCalledWith(
      "Arc wallet summary read failed",
      chainError,
    );
    consoleError.mockRestore();
  });

  it("lists only v3 positions in pools the wallet opened through Stillwater", async () => {
    const sessionToken = "test-session-token";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = {
      findSessionUser: async (value: string) =>
        value === sessionHash ? { id: "user-1", ownerAddress: managedAddress } : null,
    } as unknown as AuthStore;
    const opened = "0x2222222222222222222222222222222222222222" as Address;
    const unsolicited = "0x3333333333333333333333333333333333333333" as Address;
    const usdc = ARC_TOKENS.USDC.address;
    const manager = UNISWAP_V3_ARC.nonfungiblePositionManager.address;
    // Token 7 is in a pool the wallet opened; token 8 was sent to the wallet by someone else.
    const chainClient: ChainReadClient = {
      getBalance: async () => 0n,
      readContract: async ({ address, functionName, args = [] }) => {
        if (address === manager && functionName === "balanceOf") return 2n;
        if (functionName === "tokenOfOwnerByIndex") return (args[1] as bigint) + 7n;
        if (functionName === "positions") {
          return [0n, managedAddress, args[0] === 7n ? opened : unsolicited, usdc, 3_000,
            -60, 60, 1_000n, 0n, 0n, 0n, 0n];
        }
        if (functionName === "slot0") return [1n << 96n, 0, 0, 0, 0, 0, true];
        if (functionName === "getPool") return "0x4444444444444444444444444444444444444444";
        if (functionName === "decimals") return 18;
        if (functionName === "symbol") return "MEME";
        return 0n; // balances
      },
      simulateContract: async () => ({ result: [0n, 0n] }),
    };
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ id: "wallet-1", address: managedAddress }),
      all: vi.fn().mockResolvedValue(sql.includes("mint_intents")
        ? { results: [{ token0_address: opened, token1_address: usdc, fee: 3_000 }] }
        : { results: [] }),
    }));
    const env = {
      DB: { prepare } as unknown as D1Database,
      SIGNER: {} as Fetcher,
      AUTH_URI: "http://localhost:8787",
      AUTH_COOKIE_SECURE: "false",
      ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    } satisfies Bindings;
    const app = createApp({
      createAuthStore: () => authStore,
      createChainClient: () => chainClient,
    });

    const response = await app.request(
      "/v1/wallets/summary",
      { headers: { cookie: `stillwater_session=${sessionToken}` } },
      env,
    );

    expect(response.status).toBe(200);
    const { summary } = await response.json() as { summary: { positions: { tokenId: string }[] } };
    expect(summary.positions.map((position) => position.tokenId)).toEqual(["7"]);
  });
});
