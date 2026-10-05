import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  maxUint128,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { ARC_CHAIN_ID, UNISWAP_V3_ARC } from "./arc";

export const managerAbi = parseAbi([
  "function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

const MAX_SLIPPAGE_BPS = 500;

export type PositionAction = {
  chainId: typeof ARC_CHAIN_ID;
  kind: "increase" | "decrease" | "collect" | "withdraw";
  tokenId: bigint;
  to: Address;
  data: Hex;
  value: 0n;
  recipient: Address;
};

function minimum(amount: bigint, slippageBps: number): bigint {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > MAX_SLIPPAGE_BPS
  ) {
    throw new Error("Position action slippage exceeds policy");
  }
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

function base(
  kind: PositionAction["kind"],
  tokenId: bigint,
  recipient: Address,
  data: Hex,
): PositionAction {
  if (tokenId <= 0n) throw new Error("Invalid position token ID");
  return {
    chainId: ARC_CHAIN_ID,
    kind,
    tokenId,
    to: UNISWAP_V3_ARC.nonfungiblePositionManager.address,
    data,
    value: 0n,
    recipient: getAddress(recipient),
  };
}

export function buildIncreaseLiquidity(input: {
  tokenId: bigint;
  recipient: Address;
  amount0: bigint;
  amount1: bigint;
  slippageBps: number;
  deadline: bigint;
}): PositionAction {
  if (input.amount0 < 0n || input.amount1 < 0n) {
    throw new Error("Position amounts cannot be negative");
  }
  if (input.amount0 === 0n && input.amount1 === 0n) {
    throw new Error("At least one position amount must be positive");
  }
  if (input.deadline <= 0n) throw new Error("Invalid position deadline");
  const data = encodeFunctionData({
    abi: managerAbi,
    functionName: "increaseLiquidity",
    args: [{
      tokenId: input.tokenId,
      amount0Desired: input.amount0,
      amount1Desired: input.amount1,
      amount0Min: minimum(input.amount0, input.slippageBps),
      amount1Min: minimum(input.amount1, input.slippageBps),
      deadline: input.deadline,
    }],
  });
  return base("increase", input.tokenId, input.recipient, data);
}

export function buildDecreaseLiquidity(input: {
  tokenId: bigint;
  recipient: Address;
  liquidity: bigint;
  expected0: bigint;
  expected1: bigint;
  slippageBps: number;
  deadline: bigint;
}): PositionAction {
  if (input.liquidity <= 0n || input.liquidity > maxUint128) {
    throw new Error("Invalid position liquidity");
  }
  if (input.expected0 < 0n || input.expected1 < 0n) {
    throw new Error("Expected position amounts cannot be negative");
  }
  if (input.expected0 === 0n && input.expected1 === 0n) {
    throw new Error("At least one expected position amount must be positive");
  }
  if (input.deadline <= 0n) throw new Error("Invalid position deadline");
  const data = encodeFunctionData({
    abi: managerAbi,
    functionName: "decreaseLiquidity",
    args: [{
      tokenId: input.tokenId,
      liquidity: input.liquidity,
      amount0Min: minimum(input.expected0, input.slippageBps),
      amount1Min: minimum(input.expected1, input.slippageBps),
      deadline: input.deadline,
    }],
  });
  return base("decrease", input.tokenId, input.recipient, data);
}

export function buildCollectAll(input: {
  tokenId: bigint;
  recipient: Address;
}): PositionAction {
  const recipient = getAddress(input.recipient);
  const data = encodeFunctionData({
    abi: managerAbi,
    functionName: "collect",
    args: [{
      tokenId: input.tokenId,
      recipient,
      amount0Max: maxUint128,
      amount1Max: maxUint128,
    }],
  });
  return base("collect", input.tokenId, recipient, data);
}

export function buildFullWithdrawal(input: {
  tokenId: bigint;
  recipient: Address;
  liquidity: bigint;
  expected0: bigint;
  expected1: bigint;
  slippageBps: number;
  deadline: bigint;
}): PositionAction {
  const decrease = buildDecreaseLiquidity(input);
  const collect = buildCollectAll(input);
  const burn = encodeFunctionData({
    abi: managerAbi,
    functionName: "burn",
    args: [input.tokenId],
  });
  const data = encodeFunctionData({
    abi: managerAbi,
    functionName: "multicall",
    args: [[decrease.data, collect.data, burn]],
  });
  return base("withdraw", input.tokenId, input.recipient, data);
}

export type PositionActionClient = {
  call(parameters: {
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
    blockNumber: bigint;
  }): Promise<{ data?: Hex }>;
  estimateGas(parameters: {
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
    blockNumber: bigint;
  }): Promise<bigint>;
};

export async function simulatePositionAction(input: {
  client: PositionActionClient;
  owner: Address;
  action: PositionAction;
  blockNumber: bigint;
}) {
  const call = {
    account: getAddress(input.owner),
    to: input.action.to,
    data: input.action.data,
    value: 0n,
    blockNumber: input.blockNumber,
  };
  const [result, gas] = await Promise.all([
    input.client.call(call),
    input.client.estimateGas(call),
  ]);
  if (!result.data) throw new Error("Position action simulation returned no data");

  let output: unknown;
  if (input.action.kind === "increase") {
    const [liquidity, amount0, amount1] = decodeFunctionResult({
      abi: managerAbi,
      functionName: "increaseLiquidity",
      data: result.data,
    });
    output = {
      liquidity: liquidity.toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
    };
  } else if (input.action.kind === "decrease") {
    const [amount0, amount1] = decodeFunctionResult({
      abi: managerAbi,
      functionName: "decreaseLiquidity",
      data: result.data,
    });
    output = { amount0: amount0.toString(), amount1: amount1.toString() };
  } else if (input.action.kind === "collect") {
    const [amount0, amount1] = decodeFunctionResult({
      abi: managerAbi,
      functionName: "collect",
      data: result.data,
    });
    output = { amount0: amount0.toString(), amount1: amount1.toString() };
  } else {
    const results = decodeFunctionResult({
      abi: managerAbi,
      functionName: "multicall",
      data: result.data,
    });
    if (results.length !== 3) throw new Error("Invalid withdrawal simulation result");
    const [decreased0, decreased1] = decodeFunctionResult({
      abi: managerAbi,
      functionName: "decreaseLiquidity",
      data: results[0],
    });
    const [collected0, collected1] = decodeFunctionResult({
      abi: managerAbi,
      functionName: "collect",
      data: results[1],
    });
    output = {
      decreased0: decreased0.toString(),
      decreased1: decreased1.toString(),
      collected0: collected0.toString(),
      collected1: collected1.toString(),
      burnsPosition: true,
    };
  }
  return {
    blockNumber: input.blockNumber.toString(),
    gasEstimate: gas.toString(),
    output,
  };
}

export function positionActionPayloadHash(action: PositionAction): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes" },
      ],
      [BigInt(action.chainId), action.to, action.recipient, action.data],
    ),
  );
}
