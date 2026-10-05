import { encodeEventTopics, getAddress, keccak256, encodeAbiParameters, decodeAbiParameters, decodeFunctionData, parseAbi, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_TOKENS, UNISWAP_SHARED_ARC, UNISWAP_V4_ARC, buildArcV4Approval, buildArcV4Mint, buildArcV4PositionAction, buildArcV4Swap, quoteArcV4Swap, readArcV4Allowances, readArcV4Pool, readArcV4Position, readArcV4PositionFees, v4MintedTokenIds, v4PoolId, v4PositionManagerReadAbi } from "../src";

const token = getAddress("0x2222222222222222222222222222222222222222");
const account = getAddress("0x1111111111111111111111111111111111111111");
const hook = getAddress("0x3333333333333333333333333333333333333333");
const key = { currency0: zeroAddress, currency1: token, fee: 3_000, tickSpacing: 60, hooks: hook };

describe("Arc Uniswap v4 minted token ids", () => {
  const transfer = (from: `0x${string}`, to: `0x${string}`, tokenId: bigint) => ({ data: "0x" as const,
    topics: encodeEventTopics({ abi: v4PositionManagerReadAbi, eventName: "Transfer",
      args: { from, to, tokenId } }) as `0x${string}`[] });

  it("reads only PositionManager mints to the owner from receipt logs", () => {
    const logs = [
      { address: UNISWAP_V4_ARC.positionManager, ...transfer(zeroAddress, account, 7n) },
      { address: UNISWAP_V4_ARC.positionManager, ...transfer(token, account, 8n) },
      { address: UNISWAP_V4_ARC.positionManager, ...transfer(zeroAddress, token, 9n) },
      { address: token, ...transfer(zeroAddress, account, 10n) },
      { address: UNISWAP_V4_ARC.positionManager, data: "0x" as const, topics: [`0x${"00".repeat(32)}` as const] },
    ];
    expect(v4MintedTokenIds(logs, account)).toEqual([7n]);
  });
});

describe("Arc Uniswap v4 uncollected fees", () => {
  const poolId = `0x${"ab".repeat(32)}` as const;
  const Q128 = 2n ** 128n;
  const fakeClient = (inside: [bigint, bigint], info: [bigint, bigint, bigint]) => ({
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "getFeeGrowthInside") return inside;
      if (functionName === "getPositionInfo") {
        // PositionManager positions are keyed by the manager as owner and the token id as salt.
        expect(args[1]).toBe(UNISWAP_V4_ARC.positionManager);
        expect(args[4]).toBe(`0x${(42n).toString(16).padStart(64, "0")}`);
        return info;
      }
      throw new Error(`Unexpected read ${functionName}`);
    },
  });

  it("is liquidity times the fee growth inside the range since the position settled", async () => {
    const fees = await readArcV4PositionFees({ client: fakeClient([7n * Q128, 4n * Q128], [1_000n, 2n * Q128, 4n * Q128]) as never,
      poolId, tokenId: 42n, tickLower: -60, tickUpper: 60 });
    expect(fees).toEqual({ amount0: 5_000n, amount1: 0n });
  });

  it("handles fee growth counters that wrapped past 2^256", async () => {
    const nearMax = 2n ** 256n - Q128; // last checkpoint just below the wrap
    const fees = await readArcV4PositionFees({ client: fakeClient([Q128, 0n], [10n, nearMax, 0n]) as never,
      poolId, tokenId: 42n, tickLower: -60, tickUpper: 60 });
    expect(fees.amount0).toBe(20n);
  });
});

describe("Arc Uniswap v4 pool identity and reads", () => {
  it("hashes the full PoolKey, including native USDC and hooks", () => {
    expect(v4PoolId(key)).toBe(keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [zeroAddress, token, 3_000, 60, hook],
    )));
    expect(v4PoolId({ ...key, hooks: zeroAddress })).not.toBe(v4PoolId(key));
    expect(() => v4PoolId({ ...key, currency0: token, currency1: zeroAddress })).toThrow("sorted");
  });

  it("reads a native USDC pool by ID and quotes with empty hook data", async () => {
    const calls: unknown[] = [];
    const client = {
      async readContract(call: { address: string; functionName: string; args: unknown[] }) {
        calls.push(call);
        expect(call.address).toBe(UNISWAP_V4_ARC.stateView);
        expect(call.args[0]).toBe(v4PoolId(key));
        return call.functionName === "getSlot0" ? [2n ** 96n, 0, 0, 3_000] : 42n;
      },
      async simulateContract(call: { address: string; args: Array<{ hookData: string }> }) {
        calls.push(call);
        expect(call.address).toBe(UNISWAP_V4_ARC.quoter);
        expect(call.args[0].hookData).toBe("0x");
        return { result: [500n, 100_000n] };
      },
    };
    const pool = await readArcV4Pool({ client: client as never, key });
    expect(pool).toMatchObject({ id: v4PoolId(key), liquidity: "42", lpFee: 3_000 });
    expect(await quoteArcV4Swap({ client: client as never, pool: pool!, account, tokenIn: zeroAddress,
      amountIn: 1_000_000_000_000_000_000n })).toEqual({ amountOut: 500n, gasEstimate: 100_000n });
    expect(calls).toHaveLength(3);
  });

  it("allows the 6-decimal ERC-20 USDC currency without treating it as native", () => {
    const erc20Key = { currency0: token, currency1: ARC_TOKENS.USDC.address, fee: 500, tickSpacing: 10, hooks: zeroAddress };
    expect(v4PoolId(erc20Key)).toBe(keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [token, ARC_TOKENS.USDC.address, 500, 10, zeroAddress],
    )));
  });

  it("does not mark a hooked pool executable when the empty-data quote reverts", async () => {
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "42", lpFee: 3_000 };
    const client = { async simulateContract() { throw new Error("hook requires data"); } };
    await expect(quoteArcV4Swap({ client: client as never, pool, account, tokenIn: zeroAddress,
      amountIn: 1_000n })).rejects.toThrow("hook requires data");
    await expect(quoteArcV4Swap({ client: client as never, pool, account, tokenIn: zeroAddress,
      amountIn: 1n << 127n })).rejects.toThrow("not executable");
  });

  it("builds a bounded native-USDC mint through the official v4 position manager", () => {
    const pool = { ...key, hooks: zeroAddress, id: v4PoolId({ ...key, hooks: zeroAddress }),
      sqrtPriceX96: (2n ** 96n).toString(), tick: 0, liquidity: "1000000000000000000", lpFee: 3_000 };
    const mint = buildArcV4Mint({ pool, tokenDecimals: 18, recipient: account,
      tickLower: -60, tickUpper: 60, amount0Desired: 1_000_000_000_000_000_000n,
      amount1Desired: 1_000_000_000_000_000_000n, slippageBps: 100, deadline: 2_000_000_000n });
    expect(mint.to).toBe(UNISWAP_V4_ARC.positionManager);
    expect(mint.value).toBe(mint.amount0Max);
    expect(mint.value).toBeGreaterThan(0n);
    expect(mint.amount1Max).toBeGreaterThan(0n);
  });

  it("encodes both required approval stages to the exact v4 spenders", () => {
    const id = v4PoolId(key);
    const first = buildArcV4Approval({ poolId: id, token, stage: "erc20", amount: 100n });
    const second = buildArcV4Approval({ poolId: id, token, stage: "permit2", amount: 100n, expiration: 2_000_000_000n });
    expect(first.to).toBe(token);
    expect(first.data).toContain(UNISWAP_SHARED_ARC.permit2.address.slice(2).toLowerCase());
    expect(second.to).toBe(UNISWAP_SHARED_ARC.permit2.address);
    expect(second.data).toContain(UNISWAP_V4_ARC.positionManager.slice(2).toLowerCase());
    expect(() => buildArcV4Approval({ poolId: id, token: zeroAddress, stage: "erc20", amount: 1n })).toThrow();
  });

  it("reads both ERC-20 and Permit2 allowances", async () => {
    const calls: string[] = [];
    const client = { async readContract(call: { address: string; functionName: string }) {
      calls.push(call.address);
      return call.address === token ? 200n : [150n, 2_000_000_000, 0];
    } };
    expect(await readArcV4Allowances({ client: client as never, owner: account, token })).toEqual({
      erc20: 200n, permit2: 150n, expiration: 2_000_000_000n,
    });
    expect(calls).toEqual([token, UNISWAP_SHARED_ARC.permit2.address]);
  });

  it("encodes a bounded single-pool v4 swap with native value only for USDC input", () => {
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "100", lpFee: 3000 };
    const buy = buildArcV4Swap({ pool, tokenIn: zeroAddress, amountIn: 10n ** 18n,
      amountOutMinimum: 900n, deadline: 2_000_000_000n });
    const sell = buildArcV4Swap({ pool, tokenIn: token, amountIn: 1_000n,
      amountOutMinimum: 900n, deadline: 2_000_000_000n });
    expect(buy.to).toBe(UNISWAP_SHARED_ARC.universalRouter.address);
    expect(buy.value).toBe(10n ** 18n);
    expect(sell.value).toBe(0n);
    expect(sell.tokenOut).toBe(zeroAddress);
    const decoded = decodeFunctionData({ abi: parseAbi([
      "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
    ]), data: buy.data });
    expect(decoded.args[0]).toBe("0x10");
    expect(decoded.args[1]).toHaveLength(1);
    expect(decoded.args[2]).toBe(2_000_000_000n);
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], decoded.args[1][0]);
    expect(actions).toBe("0x060c0f");
    expect(params).toHaveLength(3);
    const [swap] = decodeAbiParameters([{ type: "tuple", components: [
      { name: "poolKey", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ] },
      { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ] }], params[0]);
    expect(swap).toMatchObject({ zeroForOne: true, amountIn: 10n ** 18n,
      amountOutMinimum: 900n, minHopPriceX36: 0n, hookData: "0x" });
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]))
      .toEqual([zeroAddress, 10n ** 18n]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]))
      .toEqual([token, 900n]);
    expect(() => buildArcV4Swap({ pool, tokenIn: zeroAddress, amountIn: 0n,
      amountOutMinimum: 1n, deadline: 2_000_000_000n })).toThrow();
  });

  it("reads owner, pool key, liquidity and signed tick boundaries from a v4 NFT", async () => {
    const negative60 = (1n << 24n) - 60n;
    const packed = (negative60 << 8n) | (60n << 32n);
    const client = { async readContract(call: { functionName: string }) {
      if (call.functionName === "ownerOf") return account;
      if (call.functionName === "getPositionLiquidity") return 123n;
      return [key, packed];
    } };
    await expect(readArcV4Position({ client: client as never, tokenId: 9n, owner: account }))
      .resolves.toMatchObject({ tokenId: 9n, poolId: v4PoolId(key),
        tickLower: -60, tickUpper: 60, liquidity: 123n });
    await expect(readArcV4Position({ client: client as never, tokenId: 9n,
      owner: token })).rejects.toThrow("not owned");
  });

  it("encodes collect and full burn through the v4 SDK with zero native value", () => {
    const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
      tick: 0, liquidity: "1000000000000000000", lpFee: 3000 };
    const common = { pool, tokenDecimals: 18, tokenId: 9n, recipient: account,
      liquidity: 100_000n, tickLower: -60, tickUpper: 60,
      slippageBps: 100, deadline: 2_000_000_000n };
    const collect = buildArcV4PositionAction({ ...common, kind: "collect" });
    const withdraw = buildArcV4PositionAction({ ...common, kind: "withdraw" });
    expect(collect.to).toBe(UNISWAP_V4_ARC.positionManager);
    expect(collect.value).toBe(0n);
    expect(withdraw.value).toBe(0n);
    expect(withdraw.data).not.toBe(collect.data);
    expect(() => buildArcV4PositionAction({ ...common, kind: "withdraw",
      slippageBps: 501 })).toThrow("Invalid v4 position action");
  });
});
