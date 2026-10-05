import { createPublicClient, http, type Address } from "viem";
import { expect, it } from "vitest";
import { arc, readWalletSummary, type ChainReadClient } from "../src";

it.skipIf(process.env.LIVE_ARC_RPC !== "true")(
  "reads a wallet summary from Arc mainnet",
  async () => {
    const client = createPublicClient({
      chain: arc,
      transport: http(arc.rpcUrls.default.http[0]),
      batch: { multicall: true },
    }) as unknown as ChainReadClient;

    const summary = await readWalletSummary(client, "0x000000000000000000000000000000000000dEaD" as Address);

    expect(Number(summary.balances.nativeUsdc.formatted)).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(summary.positions)).toBe(true);
  },
  30_000,
);
