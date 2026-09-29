import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ChainReadClient } from "@stillwater/chain";
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
      first: vi.fn().mockResolvedValue({ address: managedAddress }),
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
});
