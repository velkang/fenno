import { createPublicClient, http } from "viem";
import { expect, it } from "vitest";
import {
  ALPHA_POOL,
  arc,
  readAlphaPoolState,
  type ChainReadClient,
} from "../src";

it.skipIf(process.env.LIVE_ARC_RPC !== "true")(
  "reads the pinned alpha pool from Arc mainnet",
  async () => {
    const client = createPublicClient({
      chain: arc,
      transport: http(arc.rpcUrls.default.http[0]),
    }) as unknown as ChainReadClient;

    const pool = await readAlphaPoolState(client);

    expect(pool.address).toBe(ALPHA_POOL.address);
    expect(pool.liquidity).not.toBe("0");
    expect(Number(pool.token1PerToken0)).toBeGreaterThan(0);
  },
  30_000,
);
