import { buildArcV4Mint } from "@stillwater/chain";
import { getAddress, maxUint160, maxUint256, zeroAddress, type Hex } from "viem";
import { api } from "./api-client";

// The API only prepares a mint once each token's Permit2 allowance covers the SDK's
// slippage-adjusted maximum (amountNMax), which for a concentrated range can be well above the
// desired amount. Rebuild the same mint from the live pool so approvals match that check.
export async function v4MintApprovals(input: {
  poolId: string;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  slippageBps: number;
  recipient: string;
}): Promise<Array<{ token: string; amount: bigint }>> {
  const { pool } = await api.getPool(input.poolId);
  const mint = buildArcV4Mint({
    pool: { id: pool.address as Hex, currency0: getAddress(pool.token0), currency1: getAddress(pool.token1),
      fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: getAddress(pool.hooks ?? zeroAddress),
      sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, liquidity: pool.liquidity, lpFee: pool.lpFee ?? pool.fee },
    tokenDecimals: pool.token.decimals, recipient: getAddress(input.recipient),
    tickLower: input.tickLower, tickUpper: input.tickUpper,
    amount0Desired: input.amount0Desired, amount1Desired: input.amount1Desired,
    slippageBps: input.slippageBps, deadline: BigInt(Math.floor(Date.now() / 1000) + 10 * 60),
  });
  // 2% headroom for the price moving between this read and the API's own check.
  return [{ token: pool.token0, amount: mint.amount0Max }, { token: pool.token1, amount: mint.amount1Max }]
    .filter((entry) => entry.amount > 0n && entry.token.toLowerCase() !== zeroAddress)
    .map((entry) => ({ token: entry.token, amount: (entry.amount * 102n + 99n) / 100n }));
}

// Makes sure the managed wallet has approved at least `amount` of `token` for this v4 pool:
// first the ERC-20 approval to Permit2, then the Permit2 approval to the router. Each is for
// the maximum, so later actions skip it (the signer still caps a Permit2 approval at 30
// minutes). Native USDC needs none.
// Returns false when an approval was sent but has not confirmed yet.
export async function ensureV4Allowance(input: {
  poolId: string;
  token: string;
  amount: bigint;
  purpose: "mint" | "swap";
  execute: (intentId: string) => Promise<boolean>;
  onApprove?: (stage: "erc20" | "permit2") => void;
}): Promise<boolean> {
  if (input.token.toLowerCase() === zeroAddress) return true;
  for (const stage of ["erc20", "permit2"] as const) {
    const current = await api.getV4Allowances(input.poolId, input.purpose);
    const allowance = current.allowances.find((entry) => entry.token.toLowerCase() === input.token.toLowerCase());
    const insufficient = stage === "erc20" ? !allowance || BigInt(allowance.erc20) < input.amount :
      !allowance || BigInt(allowance.permit2) < input.amount ||
      BigInt(allowance.expiration) <= BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
    if (!insufficient) continue;
    input.onApprove?.(stage);
    const prepared = await api.prepareV4Approval({ poolId: input.poolId, token: input.token, stage,
      purpose: input.purpose, amount: (stage === "erc20" ? maxUint256 : maxUint160).toString(),
      idempotencyKey: crypto.randomUUID() });
    if (!await input.execute(prepared.intentId)) return false;
  }
  return true;
}
