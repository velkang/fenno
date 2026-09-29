import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_CHAIN_ID,
  ARC_TOKENS,
  UNISWAP_V3_ARC,
} from "./arc";
import type { ChainReadClient } from "./reads";

const approveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export type AlphaApprovalToken = keyof Pick<typeof ARC_TOKENS, "USDC" | "cirBTC">;

export type Approval = {
  chainId: typeof ARC_CHAIN_ID;
  tokenSymbol: string;
  tokenAddress: Address;
  spender: Address;
  amount: bigint;
  to: Address;
  data: Hex;
  value: 0n;
};

export type AlphaApproval = Approval & { token: AlphaApprovalToken };

export type ApprovalSimulationClient = ChainReadClient & {
  estimateGas(parameters: {
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
    blockNumber?: bigint;
  }): Promise<bigint>;
};

export function buildApproval(input: {
  tokenAddress: Address;
  tokenSymbol?: string;
  amount: bigint;
  spender?: Address;
}): Approval {
  if (input.amount <= 0n || input.amount > maxUint256) {
    throw new Error("Approval amount is outside uint256 range");
  }
  const tokenAddress = getAddress(input.tokenAddress);
  const spender = input.spender ? getAddress(input.spender) : UNISWAP_V3_ARC.nonfungiblePositionManager.address;
  return {
    chainId: ARC_CHAIN_ID,
    tokenSymbol: input.tokenSymbol ?? "TOKEN",
    tokenAddress,
    spender,
    amount: input.amount,
    to: tokenAddress,
    data: encodeFunctionData({
      abi: approveAbi,
      functionName: "approve",
      args: [spender, input.amount],
    }),
    value: 0n,
  };
}

export function buildAlphaApproval(input: {
  token: AlphaApprovalToken;
  amount: bigint;
}): AlphaApproval {
  return {
    ...buildApproval({
      tokenAddress: ARC_TOKENS[input.token].address,
      tokenSymbol: input.token,
      amount: input.amount,
    }),
    token: input.token,
  };
}

export function approvalPayloadHash(approval: Approval): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes" },
      ],
      [
        BigInt(approval.chainId),
        approval.to,
        approval.spender,
        approval.amount,
        approval.data,
      ],
    ),
  );
}

export const alphaApprovalPayloadHash = approvalPayloadHash;

export async function simulateAlphaApproval(input: {
  client: ApprovalSimulationClient;
  owner: Address;
  approval: Approval;
  blockNumber: bigint;
}): Promise<{ gasEstimate: string; blockNumber: string }> {
  const simulation = await input.client.simulateContract({
    account: input.owner,
    address: input.approval.to,
    abi: approveAbi,
    functionName: "approve",
    args: [input.approval.spender, input.approval.amount],
    blockNumber: input.blockNumber,
  });
  if (simulation.result !== true) {
    throw new Error("Approval simulation did not return true");
  }
  const gasEstimate = await input.client.estimateGas({
    account: input.owner,
    to: input.approval.to,
    data: input.approval.data,
    value: 0n,
    blockNumber: input.blockNumber,
  });
  return {
    gasEstimate: gasEstimate.toString(),
    blockNumber: input.blockNumber.toString(),
  };
}
