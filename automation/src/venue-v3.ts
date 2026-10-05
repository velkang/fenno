import { maxUint256, type Hex } from "viem";
import type { AgentApi } from "./agent-api";
import type { Sides, Step, Venue } from "./stepper";

// The v3 calls a re-centre makes. A token is approved straight to the router (swap) or the
// position manager (mint), once, for the maximum, as the web app does. A v3 open never takes
// more than the amounts it names, so the new band is simply given what may be used.

export function v3Venue(api: AgentApi, poolAddress: Hex): Venue {
  return {
    pool: () => api.pool(poolAddress),
    async holdings(sides: Sides) {
      const held = await api.v3Holdings(sides.token);
      return { token: BigInt(held.token.balance), usdc: BigInt(held.usdc.balance) };
    },
    async prepareClose(state, deadline) {
      return api.prepareV3Withdraw({ tokenId: state.tokenId, deadline, idempotencyKey: `${state.runId}:close` });
    },
    async swapStep(state, sides, tokenIn, amountIn) {
      const direction = tokenIn.toLowerCase() === sides.usdc.toLowerCase() ? "buy" as const : "sell" as const;
      const trade = { tokenAddress: sides.token, poolAddress, direction, amountIn: amountIn.toString() };
      const quote = await api.quoteV3Swap(trade);
      const approval = await approve(api, state, poolAddress, sides, "swap", tokenIn, BigInt(quote.allowance) < amountIn);
      if (approval) return approval;
      const { intentId } = await api.prepareV3Swap({ ...trade, idempotencyKey: `${state.runId}:swap` });
      return { step: "swap", intentId, expectedOut: quote.expectedAmountOut };
    },
    async openStep({ state, sides, ticks, limit0, limit1, deadline }) {
      const [amountToken, amountUsdc] = sides.tokenIsZero ? [limit0, limit1] : [limit1, limit0];
      const held = await api.v3Holdings(sides.token);
      for (const [token, allowance, amount] of [[sides.token, held.token.allowance, amountToken],
        [sides.usdc, held.usdc.allowance, amountUsdc]] as const) {
        const approval = await approve(api, state, poolAddress, sides, "mint", token, BigInt(allowance) < amount);
        if (approval) return approval;
      }
      const { intentId } = await api.prepareV3Mint({ tokenAddress: sides.token, poolAddress,
        amountToken: amountToken.toString(), amountUsdc: amountUsdc.toString(), ...ticks, deadline,
        idempotencyKey: `${state.runId}:mint` });
      return { step: "mint", intentId };
    },
  };
}

/** The approval of `token` for a swap or an open, when it falls short and hasn't been sent yet. */
async function approve(api: AgentApi, state: { runId: string; done: string[] }, poolAddress: Hex, sides: Sides,
  purpose: "swap" | "mint", token: string, short: boolean): Promise<Step | null> {
  const step = `${purpose}-approve-${token.toLowerCase()}`;
  // Once confirmed, don't approve again even if a lagging read still shows the old allowance.
  if (!short || state.done.includes(step)) return null;
  const { intentId } = await api.prepareV3Approval({ tokenAddress: token, poolAddress, poolTokenAddress: sides.token,
    ...(purpose === "swap" ? { spender: "swap" as const } : {}), amount: maxUint256.toString(),
    idempotencyKey: `${state.runId}:${step}` });
  return { step, intentId };
}
