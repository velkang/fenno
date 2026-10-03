import { zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  ALPHA_POOL,
  ARC_TOKENS,
  UNISWAP_SHARED_ARC,
  UNISWAP_V3_ARC,
  readAlphaPoolState,
  readAlphaWalletSummary,
  type ChainReadClient,
} from "../src";

const owner = "0x1111111111111111111111111111111111111111" as Address;
const otherToken = "0x2222222222222222222222222222222222222222" as Address;
const thirdToken = "0x3333333333333333333333333333333333333333" as Address;
const otherPool = "0x4444444444444444444444444444444444444444" as Address;
const Q96 = 1n << 96n;

function fakeClient(
  overrides: { poolToken0?: Address; unreadableToken?: Address; collectFails?: bigint } = {},
): ChainReadClient {
  return {
    async getBalance() {
      return 1_250_000_000_000_000_000n;
    },
    async readContract(parameters) {
      const { address, functionName, args = [] } = parameters;
      if (address === ALPHA_POOL.address) {
        if (functionName === "slot0") return [Q96, 0, 0, 0, 0, 0, true];
        if (functionName === "liquidity") return 42n;
        if (functionName === "token0") return overrides.poolToken0 ?? ALPHA_POOL.token0.address;
        if (functionName === "token1") return ALPHA_POOL.token1.address;
        if (functionName === "fee") return ALPHA_POOL.fee;
        if (functionName === "tickSpacing") return ALPHA_POOL.tickSpacing;
      }

      if (address === otherPool && functionName === "slot0") return [2n * Q96, 13_863, 0, 0, 0, 0, true];
      if (address === UNISWAP_V3_ARC.factory.address && functionName === "getPool") {
        return args[0] === otherToken ? otherPool : ALPHA_POOL.address;
      }
      if (functionName === "decimals") {
        if (address === overrides.unreadableToken) throw new Error("decimals reverted");
        return address === otherToken ? 18 : 8;
      }
      if (functionName === "symbol") return address === otherToken ? "MEME" : "cirBTC";

      if (address === UNISWAP_V3_ARC.nonfungiblePositionManager.address) {
        if (functionName === "balanceOf") return 3n;
        if (functionName === "tokenOfOwnerByIndex") return (args[1] as bigint) + 7n;
        if (functionName === "positions") {
          const tokenId = args[0] as bigint;
          if (tokenId === 7n) {
            return [
              0n,
              zeroAddress,
              ALPHA_POOL.token0.address,
              ALPHA_POOL.token1.address,
              ALPHA_POOL.fee,
              -100,
              100,
              9_000n,
              0n,
              0n,
              25_000_000n,
              1_500_000n,
            ];
          }
          return [
            0n,
            zeroAddress,
            otherToken,
            // Token 9 is not paired with USDC.
            tokenId === 8n ? ARC_TOKENS.USDC.address : thirdToken,
            3_000,
            -10,
            10,
            1n,
            0n,
            0n,
            0n,
            0n,
          ];
        }
      }

      if (functionName === "balanceOf") {
        return address === ARC_TOKENS.USDC.address ? 12_500_000n : 250_000_000n;
      }
      if (functionName === "allowance") {
        const spender = args[1];
        const base = spender === UNISWAP_SHARED_ARC.permit2.address ? 2n : 1n;
        return address === ARC_TOKENS.USDC.address
          ? base * 1_000_000n
          : base * 100_000_000n;
      }
      throw new Error(`Unexpected ${functionName} call to ${address}`);
    },
    async simulateContract(parameters) {
      expect(parameters.account).toBe(owner);
      expect(parameters.functionName).toBe("collect");
      const { tokenId } = parameters.args![0] as { tokenId: bigint };
      if (tokenId === overrides.collectFails) throw new Error("collect reverted");
      return { result: [30_000_000n, 2_000_000n] };
    },
  };
}

describe("Arc alpha reads", () => {
  it("validates the canonical pool and formats its decimal-adjusted price", async () => {
    const pool = await readAlphaPoolState(fakeClient());

    expect(pool.liquidity).toBe("42");
    expect(pool.token1PerToken0).toBe("100");
    expect(pool.token0PerToken1).toBe("0.01");
  });

  it("pins every pool call to the requested checkpoint block", async () => {
    const client = fakeClient();
    const calls: Array<bigint | undefined> = [];
    const readContract = client.readContract.bind(client);
    client.readContract = async (parameters) => {
      calls.push(parameters.blockNumber);
      return readContract(parameters);
    };

    await readAlphaPoolState(client, { blockNumber: 123n });

    expect(calls).toEqual(Array(6).fill(123n));
  });

  it("rejects a pool whose onchain configuration no longer matches", async () => {
    await expect(
      readAlphaPoolState(fakeClient({ poolToken0: otherToken })),
    ).rejects.toThrow("Arc alpha pool configuration mismatch");
  });

  it("returns balances, allowances, and simulated claimable fees", async () => {
    const summary = await readAlphaWalletSummary(fakeClient(), owner);

    expect(summary.balances).toEqual({
      nativeUsdc: { raw: "1250000000000000000", formatted: "1.25" },
      usdc: { raw: "12500000", formatted: "12.5" },
      cirBtc: { raw: "250000000", formatted: "2.5" },
    });
    expect(summary.allowances.positionManager.usdc.formatted).toBe("1");
    expect(summary.allowances.permit2.usdc.formatted).toBe("2");
    expect(summary.positions[0]).toMatchObject({
      tokenId: "7",
      liquidity: "9000",
      recordedOwed0: { formatted: "0.25" },
      recordedOwed1: { formatted: "1.5" },
      claimable0: { formatted: "0.3" },
      claimable1: { formatted: "2" },
    });
  });

  it("lists positions in every USDC pool with that pool's token and price", async () => {
    const { positions } = await readAlphaWalletSummary(fakeClient(), owner);

    expect(positions.map((position) => position.tokenId)).toEqual(["7", "8"]);
    expect(positions[0].pool).toMatchObject({
      address: ALPHA_POOL.address,
      token: { address: ARC_TOKENS.cirBTC.address, symbol: "cirBTC", decimals: 8, balance: "250000000" },
      fee: ALPHA_POOL.fee,
      sqrtPriceX96: Q96.toString(),
      tick: 0,
    });
    expect(positions[1]).toMatchObject({
      pool: {
        address: otherPool,
        token: { address: otherToken, symbol: "MEME", decimals: 18, balance: "250000000" },
        token0: otherToken,
        token1: ARC_TOKENS.USDC.address,
        fee: 3_000,
        sqrtPriceX96: (2n * Q96).toString(),
        tick: 13_863,
      },
      // Fee amounts use the pool's own token decimals, not cirBTC's.
      claimable0: { raw: "30000000", formatted: "0.00000000003" },
      claimable1: { formatted: "2" },
    });
  });

  it("lists only positions in the given pools", async () => {
    const pools = [{ token0: otherToken, token1: ARC_TOKENS.USDC.address, fee: 3_000 }];
    const { positions } = await readAlphaWalletSummary(fakeClient(), owner, { pools });

    expect(positions.map((position) => position.tokenId)).toEqual(["8"]);
  });

  it("reads no positions at all when no pools are given", async () => {
    const client = fakeClient();
    const readContract = client.readContract.bind(client);
    let positionManagerCalls = 0;
    client.readContract = async (parameters) => {
      if (parameters.address === UNISWAP_V3_ARC.nonfungiblePositionManager.address) positionManagerCalls += 1;
      return readContract(parameters);
    };

    const { positions } = await readAlphaWalletSummary(client, owner, { pools: [] });

    expect(positions).toEqual([]);
    expect(positionManagerCalls).toBe(0);
  });

  it("leaves out a position whose token cannot be read and keeps the rest", async () => {
    const { positions } = await readAlphaWalletSummary(fakeClient({ unreadableToken: otherToken }), owner);

    expect(positions.map((position) => position.tokenId)).toEqual(["7"]);
  });

  it("shows a position's recorded fees when its fee collection cannot be simulated", async () => {
    const { positions } = await readAlphaWalletSummary(fakeClient({ collectFails: 7n }), owner);

    expect(positions.map((position) => position.tokenId)).toEqual(["7", "8"]);
    expect(positions[0]).toMatchObject({
      claimable0: { formatted: "0.25" },
      claimable1: { formatted: "1.5" },
    });
  });
});
