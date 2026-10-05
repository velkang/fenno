import { getAddress, maxUint160, maxUint256, zeroAddress, type Hex } from "viem";
import { buildArcV4Mint } from "@stillwater/chain";
import { ApiCallError, SLIPPAGE_BPS, type AgentApi, type Balances, type Purpose } from "./agent-api";
import type { RunState, Sides, Step, Venue } from "./stepper";

// The v4 calls a re-centre makes. Tokens are approved to Permit2, then Permit2 to the router
// (swap) or position manager (mint); native USDC needs neither.

export function v4Venue(api: AgentApi, poolId: Hex): Venue {
  const holdings = async (sides: Sides) => {
    const balances = await api.balances(poolId, "swap");
    const balanceOf = (address: string) => BigInt(balances.allowances
      .find((entry) => entry.token.toLowerCase() === address.toLowerCase())?.balance ?? "0");
    return { token: balanceOf(sides.token), usdc: sides.native ? BigInt(balances.nativeBalance) : balanceOf(sides.usdc) };
  };
  return {
    pool: () => api.pool(poolId),
    holdings,
    async prepareClose(state, deadline) {
      return api.prepareWithdraw({ tokenId: state.tokenId, deadline, idempotencyKey: `${state.runId}:close` });
    },
    async swapStep(state, _sides, tokenIn, amountIn, now) {
      const balances = await api.balances(poolId, "swap");
      const approval = await approvalFor(state, api, poolId, balances, "swap", tokenIn, amountIn, now);
      if (approval) return approval;
      const quote = await api.quoteSwap({ poolId, tokenIn, amountIn: amountIn.toString() });
      const { intentId } = await api.prepareSwap({ poolId, tokenIn, amountIn: amountIn.toString(),
        minimumAmountOut: quote.minimumAmountOut, idempotencyKey: `${state.runId}:swap` });
      return { step: "swap", intentId, expectedOut: quote.expectedAmountOut };
    },
    async openStep({ state, pool, ticks, limit0, limit1, deadline, now }) {
      const build = (amount0Desired: bigint, amount1Desired: bigint) => buildArcV4Mint({
        pool: { id: pool.address as Hex, currency0: getAddress(pool.token0), currency1: getAddress(pool.token1),
          fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: getAddress(pool.hooks ?? zeroAddress),
          sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, liquidity: pool.liquidity, lpFee: pool.lpFee ?? pool.fee },
        tokenDecimals: pool.token.decimals, recipient: state.walletAddress, ...ticks,
        amount0Desired, amount1Desired, slippageBps: SLIPPAGE_BPS, deadline: BigInt(deadline),
      });
      // The mint may take up to its slippage-adjusted maximums. Shrink it until those fit in what
      // may be used, so the slippage never comes out of the wallet's own money.
      let [amount0Desired, amount1Desired] = [limit0, limit1];
      let mint = build(amount0Desired, amount1Desired);
      for (let attempt = 0; attempt < 3 && (mint.amount0Max > limit0 || mint.amount1Max > limit1); attempt += 1) {
        const scale = (limit: bigint, maximum: bigint) => (maximum > limit ? (limit * 1_000_000n) / maximum : 1_000_000n);
        const factor = [scale(limit0, mint.amount0Max), scale(limit1, mint.amount1Max)].reduce((a, b) => (a < b ? a : b));
        [amount0Desired, amount1Desired] = [(amount0Desired * factor) / 1_000_000n, (amount1Desired * factor) / 1_000_000n];
        mint = build(amount0Desired, amount1Desired);
      }
      if (mint.amount0Max > limit0 || mint.amount1Max > limit1 || amount0Desired <= 0n || amount1Desired <= 0n) {
        throw new ApiCallError("NOTHING_TO_REOPEN", 422);
      }
      const balances = await api.balances(poolId, "mint");
      for (const [currency, maximum] of [[pool.token0, mint.amount0Max], [pool.token1, mint.amount1Max]] as const) {
        const approval = await approvalFor(state, api, poolId, balances, "mint", currency, (maximum * 102n + 99n) / 100n, now);
        if (approval) return approval;
      }
      const { intentId } = await api.prepareMint({ poolId, amount0Desired: amount0Desired.toString(),
        amount1Desired: amount1Desired.toString(), ...ticks, deadline, idempotencyKey: `${state.runId}:mint` });
      return { step: "mint", intentId };
    },
  };
}

/**
 * The approval still needed before `amount` of `token` can be spent: the token's approval
 * to Permit2, then Permit2's to the router (swap) or position manager (mint). Each is for
 * the maximum, as the web app does. Native USDC needs none.
 */
async function approvalFor(state: RunState, api: AgentApi, poolId: Hex, balances: Balances, purpose: Purpose,
  token: string, amount: bigint, now: number): Promise<Step | null> {
  if (token.toLowerCase() === zeroAddress) return null;
  const allowance = balances.allowances.find((entry) => entry.token.toLowerCase() === token.toLowerCase());
  const soon = BigInt(Math.floor(now / 1_000) + 10 * 60);
  const stages = [
    { stage: "erc20" as const, short: !allowance || BigInt(allowance.erc20) < amount, amount: maxUint256 },
    { stage: "permit2" as const, short: !allowance || BigInt(allowance.permit2) < amount ||
      BigInt(allowance.expiration) <= soon, amount: maxUint160 },
  ];
  for (const { stage, short, amount: approved } of stages) {
    const step = `${purpose}-${stage}-${token.toLowerCase()}`;
    // Once confirmed, don't approve again even if a lagging read still shows the old allowance.
    if (!short || state.done.includes(step)) continue;
    const { intentId } = await api.prepareApproval({ poolId, token, stage, purpose,
      amount: approved.toString(), idempotencyKey: `${state.runId}:${step}` });
    return { step, intentId };
  }
  return null;
}
