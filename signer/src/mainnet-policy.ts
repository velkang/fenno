import {
  decodeFunctionData,
  getAddress,
  maxUint128,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  ALPHA_POOL,
  ARC_CHAIN_ID,
  ARC_TOKENS,
  UNISWAP_V3_ARC,
  UNISWAP_V4_ARC,
  UNISWAP_SWAP_ARC,
  approvalPayloadHash,
  mintPayloadHash,
  arcV4MintPayloadHash,
  arcV4ApprovalPayloadHash,
  arcV4SwapPayloadHash,
  arcV4PositionActionPayloadHash,
  positionActionPayloadHash,
  usdcTransferAbi,
  swapPayloadHash,
  swapRouterAbi,
  type Swap,
  withdrawalPayloadHash,
  type UsdcWithdrawal,
  type AlphaMint,
  type ArcV4Mint,
  type ArcV4Approval,
  type ArcV4Swap,
  type ArcV4PositionAction,
  type PositionAction,
} from "@stillwater/chain";
import type { WalletState } from "./policy";

const managerAbi = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const approveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export type MainnetIntentKind =
  | "erc20_approval"
  | "position_mint"
  | "v4_position_mint"
  | "v4_approval"
  | "v4_single_pool_swap"
  | "v4_position_collect"
  | "v4_position_withdraw"
  | "position_increase"
  | "position_decrease"
  | "position_collect"
  | "position_withdraw"
  | "usdc_withdrawal"
  | "single_pool_swap";

export type MainnetPolicyRequest = {
  now: number;
  emergencyStop: boolean;
  wallet: { address: Address; state: WalletState };
  intent: {
    kind: MainnetIntentKind;
    status: string;
    expiresAt: number;
    payloadHash: Hex;
  };
  transaction: {
    chainId: number;
    to: Address;
    data: Hex;
    value: bigint;
  };
  approval?: { tokenAddress: Address; poolAddress?: Address; poolTokenAddress?: Address; tokenDecimals?: number };
  mintPool?: {
    poolAddress?: Address;
    token0: Address;
    token1: Address;
    fee: number;
    tickSpacing: number;
    tokenDecimals?: number;
  };
  v4Mint?: { transaction: ArcV4Mint };
  v4Approval?: { transaction: ArcV4Approval };
  v4Swap?: { transaction: ArcV4Swap; freshAmountOut: bigint };
  v4PositionAction?: { transaction: ArcV4PositionAction };
  position?: {
    tokenId: bigint;
    owner: Address;
    liquidity: bigint;
    expectedCirBtc?: bigint;
    expectedUsdc?: bigint;
  };
  withdrawal?: {
    transaction: UsdcWithdrawal;
    signature: Hex;
    signatureValid: boolean;
  };
  swap?: { transaction: Swap; tokenAddress: Address; freshAmountOut: bigint };
  simulation: {
    success: boolean;
    blockNumber: bigint;
    latestBlockNumber: bigint;
  };
};

export type MainnetPolicyDecision =
  | { allowed: true; reason: "POLICY_ALLOWED" }
  | { allowed: false; reason: string };

const reject = (reason: string): MainnetPolicyDecision => ({ allowed: false, reason });
const same = (left: Address, right: Address) =>
  left.toLowerCase() === right.toLowerCase();
const minimumAllowed = (desired: bigint) => (desired * 9_500n) / 10_000n;
const validDeadline = (deadline: bigint, now: number) => {
  const nowSeconds = BigInt(Math.floor(now / 1_000));
  return deadline > nowSeconds && deadline <= nowSeconds + 30n * 60n;
};

function validateCommon(request: MainnetPolicyRequest): MainnetPolicyDecision | null {
  if (request.emergencyStop && request.intent.kind !== "usdc_withdrawal") return reject("EMERGENCY_STOP_ACTIVE");
  if (request.intent.status !== "pending") return reject("INTENT_NOT_PENDING");
  if (request.intent.expiresAt <= request.now) return reject("INTENT_EXPIRED");
  if (request.transaction.chainId !== ARC_CHAIN_ID) return reject("CHAIN_NOT_ALLOWED");
  if (request.transaction.value !== 0n && request.intent.kind !== "v4_position_mint" &&
      request.intent.kind !== "v4_single_pool_swap") {
    return reject("NATIVE_VALUE_NOT_ALLOWED");
  }
  if (!request.simulation.success) return reject("SIMULATION_FAILED");
  if (
    request.simulation.latestBlockNumber < request.simulation.blockNumber ||
    request.simulation.latestBlockNumber - request.simulation.blockNumber > 2n
  ) return reject("SIMULATION_STALE");
  const exit = request.intent.kind === "position_decrease" ||
    request.intent.kind === "position_collect" ||
    request.intent.kind === "position_withdraw" ||
    request.intent.kind === "v4_position_collect" ||
    request.intent.kind === "v4_position_withdraw" ||
    request.intent.kind === "usdc_withdrawal";
  if (request.wallet.state !== "active" && !(exit && request.wallet.state === "paused")) {
    return reject("WALLET_NOT_SIGNABLE");
  }
  return null;
}

function validatePosition(request: MainnetPolicyRequest, tokenId: bigint) {
  if (!request.position || request.position.tokenId !== tokenId) {
    return reject("POSITION_CONTEXT_MISMATCH");
  }
  if (!same(request.position.owner, request.wallet.address)) {
    return reject("POSITION_NOT_OWNED");
  }
  return null;
}

function validMin(actualMin: bigint, expected: bigint) {
  return expected >= 0n && actualMin >= minimumAllowed(expected);
}

export function validateMainnetIntent(
  request: MainnetPolicyRequest,
): MainnetPolicyDecision {
  const common = validateCommon(request);
  if (common) return common;

  if (request.intent.kind === "usdc_withdrawal") {
    const authorization = request.withdrawal;
    if (!authorization || !authorization.signatureValid) return reject("OWNER_SIGNATURE_INVALID");
    const withdrawal = authorization.transaction;
    if (!same(withdrawal.wallet, request.wallet.address) ||
      !same(request.transaction.to, ARC_TOKENS.USDC.address) ||
      request.transaction.data !== withdrawal.data ||
      withdrawal.expiresAt <= BigInt(Math.floor(request.now / 1_000))) {
      return reject("WITHDRAWAL_CONTEXT_MISMATCH");
    }
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: usdcTransferAbi, data: request.transaction.data });
    } catch {
      return reject("CALLDATA_INVALID");
    }
    if (decoded.functionName !== "transfer" ||
      !same(decoded.args[0], withdrawal.recipient) ||
      decoded.args[1] !== withdrawal.amount || withdrawal.amount <= 0n) {
      return reject("WITHDRAWAL_AMOUNT_OR_RECIPIENT_INVALID");
    }
    return withdrawalPayloadHash(withdrawal, authorization.signature) === request.intent.payloadHash
      ? { allowed: true, reason: "POLICY_ALLOWED" }
      : reject("PAYLOAD_HASH_MISMATCH");
  }

  if (request.intent.kind === "v4_position_mint") {
    const context = request.v4Mint;
    if (!context) return reject("V4_MINT_CONTEXT_MISSING");
    const mint = context.transaction;
    if (!same(request.transaction.to, UNISWAP_V4_ARC.positionManager) ||
        request.transaction.data !== mint.data || request.transaction.value !== mint.value ||
        !same(mint.recipient, request.wallet.address) || !validDeadline(mint.deadline, request.now)) {
      return reject("V4_MINT_PARAMETERS_INVALID");
    }
    return arcV4MintPayloadHash(mint) === request.intent.payloadHash
      ? { allowed: true, reason: "POLICY_ALLOWED" }
      : reject("PAYLOAD_HASH_MISMATCH");
  }

  if (request.intent.kind === "v4_position_collect" ||
      request.intent.kind === "v4_position_withdraw") {
    const action = request.v4PositionAction?.transaction;
    if (!action || (request.intent.kind === "v4_position_collect" ? "collect" : "withdraw") !== action.kind ||
        !same(request.transaction.to, UNISWAP_V4_ARC.positionManager) ||
        request.transaction.data !== action.data || request.transaction.value !== 0n ||
        !same(action.recipient, request.wallet.address) || action.liquidity <= 0n ||
        !validDeadline(action.deadline, request.now) ||
        action.slippageBps < 0 || action.slippageBps > 500) {
      return reject("V4_POSITION_ACTION_INVALID");
    }
    return arcV4PositionActionPayloadHash(action) === request.intent.payloadHash
      ? { allowed: true, reason: "POLICY_ALLOWED" }
      : reject("PAYLOAD_HASH_MISMATCH");
  }

  if (request.intent.kind === "v4_approval") {
    const context = request.v4Approval;
    if (!context) return reject("V4_APPROVAL_CONTEXT_MISSING");
    const approval = context.transaction;
    if (!same(request.transaction.to, approval.to) || request.transaction.data !== approval.data ||
        request.transaction.value !== 0n || approval.amount <= 0n) return reject("V4_APPROVAL_INVALID");
    if (approval.stage === "permit2" && !validDeadline(approval.expiration, request.now)) {
      return reject("PERMIT2_EXPIRATION_INVALID");
    }
    return arcV4ApprovalPayloadHash(approval) === request.intent.payloadHash
      ? { allowed: true, reason: "POLICY_ALLOWED" }
      : reject("PAYLOAD_HASH_MISMATCH");
  }

  if (request.intent.kind === "v4_single_pool_swap") {
    const context = request.v4Swap;
    if (!context) return reject("V4_SWAP_CONTEXT_MISSING");
    const swap = context.transaction;
    if (!same(request.transaction.to, swap.to) || request.transaction.data !== swap.data ||
        request.transaction.value !== swap.value || !validDeadline(swap.deadline, request.now) ||
        context.freshAmountOut <= 0n ||
        swap.amountOutMinimum < minimumAllowed(context.freshAmountOut)) return reject("V4_SWAP_LIMITS_INVALID");
    return arcV4SwapPayloadHash(swap) === request.intent.payloadHash
      ? { allowed: true, reason: "POLICY_ALLOWED" }
      : reject("PAYLOAD_HASH_MISMATCH");
  }

  if (request.intent.kind === "single_pool_swap") {
    const context = request.swap;
    if (!context) return reject("SWAP_CONTEXT_MISSING");
    const swap = context.transaction;
    if (!same(request.transaction.to, UNISWAP_SWAP_ARC.swapRouter02) ||
      request.transaction.data !== swap.data ||
      !same(swap.recipient, request.wallet.address) ||
      !validDeadline(swap.deadline, request.now) ||
      context.freshAmountOut <= 0n ||
      swap.amountOutMinimum < minimumAllowed(context.freshAmountOut)) {
      return reject("SWAP_LIMITS_INVALID");
    }
    if (swap.tokenIn !== ARC_TOKENS.USDC.address && swap.tokenOut !== ARC_TOKENS.USDC.address) {
      return reject("SWAP_PAIR_INVALID");
    }
    if (!same(swap.tokenIn, context.tokenAddress) && !same(swap.tokenOut, context.tokenAddress)) {
      return reject("SWAP_PAIR_INVALID");
    }
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: swapRouterAbi, data: request.transaction.data });
    } catch {
      return reject("CALLDATA_INVALID");
    }
    if (decoded.functionName !== "multicall" || decoded.args[0] !== swap.deadline ||
      decoded.args[1].length !== 1) return reject("SWAP_SEQUENCE_INVALID");
    let inner;
    try {
      inner = decodeFunctionData({ abi: swapRouterAbi, data: decoded.args[1][0] });
    } catch {
      return reject("SWAP_SEQUENCE_INVALID");
    }
    if (inner.functionName !== "exactInputSingle") return reject("SWAP_SELECTOR_INVALID");
    const parameters = inner.args[0];
    if (!same(parameters.tokenIn, swap.tokenIn) || !same(parameters.tokenOut, swap.tokenOut) ||
      parameters.fee !== swap.fee || !same(parameters.recipient, request.wallet.address) ||
      parameters.amountIn !== swap.amountIn ||
      parameters.amountOutMinimum !== swap.amountOutMinimum ||
      parameters.sqrtPriceLimitX96 !== 0n) return reject("SWAP_PARAMETERS_INVALID");
    return swapPayloadHash(swap) === request.intent.payloadHash
      ? { allowed: true, reason: "POLICY_ALLOWED" }
      : reject("PAYLOAD_HASH_MISMATCH");
  }

  if (request.intent.kind === "erc20_approval") {
    if (request.approval && !request.approval.poolAddress) return reject("POOL_NOT_ALLOWED");
    if (request.approval
      ? !same(request.transaction.to, request.approval.tokenAddress)
      : !same(request.transaction.to, ARC_TOKENS.USDC.address) &&
        !same(request.transaction.to, ARC_TOKENS.cirBTC.address)) {
      return reject("TOKEN_NOT_ALLOWED");
    }
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: approveAbi, data: request.transaction.data });
    } catch {
      return reject("CALLDATA_INVALID");
    }
    const [spender, amount] = decoded.args;
    if (!same(spender, UNISWAP_V3_ARC.nonfungiblePositionManager.address) &&
      !(same(spender, UNISWAP_SWAP_ARC.swapRouter02) &&
        request.approval?.poolAddress && request.approval.poolTokenAddress)) {
      return reject("SPENDER_NOT_ALLOWED");
    }
    if (amount <= 0n) return reject("APPROVAL_AMOUNT_INVALID");
    const hash = approvalPayloadHash({
      chainId: ARC_CHAIN_ID,
      tokenSymbol: request.approval ? "TOKEN" : same(request.transaction.to, ARC_TOKENS.USDC.address) ? "USDC" : "cirBTC",
      tokenAddress: request.transaction.to,
      spender,
      amount,
      to: request.transaction.to,
      data: request.transaction.data,
      value: 0n,
    });
    return hash === request.intent.payloadHash
      ? { allowed: true, reason: "POLICY_ALLOWED" }
      : reject("PAYLOAD_HASH_MISMATCH");
  }

  if (!same(request.transaction.to, UNISWAP_V3_ARC.nonfungiblePositionManager.address)) {
    return reject("TARGET_NOT_ALLOWED");
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: managerAbi, data: request.transaction.data });
  } catch {
    return reject("CALLDATA_INVALID");
  }

  if (request.intent.kind === "position_mint") {
    if (decoded.functionName !== "mint") return reject("SELECTOR_NOT_ALLOWED");
    const parameters = decoded.args[0];
    const pool = request.mintPool;
    if (pool
      ? !same(parameters.token0, pool.token0) || !same(parameters.token1, pool.token1) || parameters.fee !== pool.fee
      : !same(parameters.token0, ALPHA_POOL.token0.address) ||
        !same(parameters.token1, ALPHA_POOL.token1.address) || parameters.fee !== ALPHA_POOL.fee) {
      return reject("POOL_NOT_ALLOWED");
    }
    if (!same(parameters.recipient, request.wallet.address)) {
      return reject("RECIPIENT_NOT_WALLET");
    }
    if (
      parameters.tickLower >= parameters.tickUpper ||
      parameters.tickLower % (pool?.tickSpacing ?? ALPHA_POOL.tickSpacing) !== 0 ||
      parameters.tickUpper % (pool?.tickSpacing ?? ALPHA_POOL.tickSpacing) !== 0
    ) return reject("TICK_RANGE_INVALID");
    if (
      !validMin(parameters.amount0Min, parameters.amount0Desired) ||
      !validMin(parameters.amount1Min, parameters.amount1Desired)
    ) return reject("SLIPPAGE_EXCEEDS_POLICY");
    if (parameters.amount0Desired <= 0n || parameters.amount1Desired <= 0n) {
      return reject("POSITION_AMOUNT_INVALID");
    }
    if (!validDeadline(parameters.deadline, request.now)) {
      return reject("TRANSACTION_DEADLINE_EXPIRED");
    }
    const mint: AlphaMint = {
      chainId: ARC_CHAIN_ID,
      to: request.transaction.to,
      data: request.transaction.data,
      value: 0n,
      recipient: parameters.recipient,
      tickLower: parameters.tickLower,
      tickUpper: parameters.tickUpper,
      amount0Desired: parameters.amount0Desired,
      amount1Desired: parameters.amount1Desired,
      amount0Min: parameters.amount0Min,
      amount1Min: parameters.amount1Min,
      slippageBps: 0,
      deadline: parameters.deadline,
    };
    return mintPayloadHash(mint) === request.intent.payloadHash
      ? { allowed: true, reason: "POLICY_ALLOWED" }
      : reject("PAYLOAD_HASH_MISMATCH");
  }

  const expectedFunction = {
    position_increase: "increaseLiquidity",
    position_decrease: "decreaseLiquidity",
    position_collect: "collect",
    position_withdraw: "multicall",
  }[request.intent.kind];
  if (decoded.functionName !== expectedFunction) return reject("SELECTOR_NOT_ALLOWED");

  let tokenId: bigint;
  if (decoded.functionName === "multicall") {
    const calls = decoded.args[0];
    if (calls.length !== 3) return reject("WITHDRAWAL_SEQUENCE_INVALID");
    try {
      const decrease = decodeFunctionData({ abi: managerAbi, data: calls[0] });
      const collect = decodeFunctionData({ abi: managerAbi, data: calls[1] });
      const burn = decodeFunctionData({ abi: managerAbi, data: calls[2] });
      if (
        decrease.functionName !== "decreaseLiquidity" ||
        collect.functionName !== "collect" || burn.functionName !== "burn"
      ) return reject("WITHDRAWAL_SEQUENCE_INVALID");
      tokenId = decrease.args[0].tokenId;
      const positionError = validatePosition(request, tokenId);
      if (positionError) return positionError;
      if (
        decrease.args[0].liquidity !== request.position!.liquidity ||
        collect.args[0].tokenId !== tokenId || burn.args[0] !== tokenId ||
        !same(collect.args[0].recipient, request.wallet.address) ||
        collect.args[0].amount0Max !== maxUint128 ||
        collect.args[0].amount1Max !== maxUint128
      ) return reject("WITHDRAWAL_SEQUENCE_INVALID");
      if (!validDeadline(decrease.args[0].deadline, request.now)) {
        return reject("TRANSACTION_DEADLINE_EXPIRED");
      }
      if (
        request.position!.expectedCirBtc === undefined ||
        request.position!.expectedUsdc === undefined ||
        !validMin(decrease.args[0].amount0Min, request.position!.expectedCirBtc) ||
        !validMin(decrease.args[0].amount1Min, request.position!.expectedUsdc)
      ) return reject("SLIPPAGE_EXCEEDS_POLICY");
    } catch {
      return reject("WITHDRAWAL_SEQUENCE_INVALID");
    }
  } else {
    const parameters = decoded.args[0] as unknown as {
      tokenId: bigint;
      recipient: Address;
      amount0Max: bigint;
      amount1Max: bigint;
      amount0Min: bigint;
      amount1Min: bigint;
      amount0Desired: bigint;
      amount1Desired: bigint;
      liquidity: bigint;
    };
    tokenId = parameters.tokenId;
    const positionError = validatePosition(request, tokenId);
    if (positionError) return positionError;
    if (decoded.functionName === "collect") {
      if (
        !same(parameters.recipient, request.wallet.address) ||
        parameters.amount0Max !== maxUint128 || parameters.amount1Max !== maxUint128
      ) return reject("COLLECT_CONSTRAINT_INVALID");
    } else if (decoded.functionName === "increaseLiquidity") {
      if (
        !validMin(parameters.amount0Min, parameters.amount0Desired) ||
        !validMin(parameters.amount1Min, parameters.amount1Desired)
      ) return reject("SLIPPAGE_EXCEEDS_POLICY");
      const increase = decoded.args[0] as unknown as { deadline: bigint };
      if (!validDeadline(increase.deadline, request.now)) {
        return reject("TRANSACTION_DEADLINE_EXPIRED");
      }
    } else {
      if (parameters.liquidity > request.position!.liquidity) {
        return reject("LIQUIDITY_EXCEEDS_POSITION");
      }
      if (
        request.position!.expectedCirBtc === undefined ||
        request.position!.expectedUsdc === undefined ||
        !validMin(parameters.amount0Min, request.position!.expectedCirBtc) ||
        !validMin(parameters.amount1Min, request.position!.expectedUsdc)
      ) return reject("SLIPPAGE_EXCEEDS_POLICY");
      const decrease = decoded.args[0] as unknown as { deadline: bigint };
      if (!validDeadline(decrease.deadline, request.now)) {
        return reject("TRANSACTION_DEADLINE_EXPIRED");
      }
    }
  }

  const action: PositionAction = {
    chainId: ARC_CHAIN_ID,
    kind: request.intent.kind.replace("position_", "") as PositionAction["kind"],
    tokenId,
    to: request.transaction.to,
    data: request.transaction.data,
    value: 0n,
    recipient: request.wallet.address,
  };
  return positionActionPayloadHash(action) === request.intent.payloadHash
    ? { allowed: true, reason: "POLICY_ALLOWED" }
    : reject("PAYLOAD_HASH_MISMATCH");
}
