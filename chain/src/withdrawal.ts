import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { ARC_CHAIN_ID, ARC_TOKENS } from "./arc";

export const withdrawalTypes = {
  UsdcWithdrawal: [
    { name: "wallet", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const withdrawalDomain = {
  name: "Stillwater",
  version: "1",
  chainId: ARC_CHAIN_ID,
  verifyingContract: ARC_TOKENS.USDC.address,
} as const;

export const usdcTransferAbi = parseAbi([
  "function transfer(address recipient, uint256 amount) returns (bool)",
]);

export type UsdcWithdrawal = {
  chainId: typeof ARC_CHAIN_ID;
  wallet: Address;
  recipient: Address;
  amount: bigint;
  nonce: Hex;
  expiresAt: bigint;
  to: Address;
  data: Hex;
  value: 0n;
};

type WithdrawalInput = {
  wallet: Address;
  recipient: Address;
  amount: bigint;
  nonce: Hex;
  expiresAt: bigint;
};

/** A plain ERC-20 transfer of `amount` of `token` from the wallet to the recipient. */
function transferFromWallet(input: WithdrawalInput, token: Address): UsdcWithdrawal {
  const wallet = getAddress(input.wallet);
  const recipient = getAddress(input.recipient);
  if (recipient === zeroAddress || recipient === wallet) throw new Error("Invalid withdrawal recipient");
  if (input.amount <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(input.nonce)) {
    throw new Error("Invalid withdrawal amount or nonce");
  }
  return {
    chainId: ARC_CHAIN_ID,
    wallet,
    recipient,
    amount: input.amount,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
    to: token,
    data: encodeFunctionData({
      abi: usdcTransferAbi,
      functionName: "transfer",
      args: [recipient, input.amount],
    }),
    value: 0n,
  };
}

export function buildUsdcWithdrawal(input: WithdrawalInput): UsdcWithdrawal {
  return transferFromWallet(input, ARC_TOKENS.USDC.address);
}

export function withdrawalMessage(withdrawal: UsdcWithdrawal) {
  return {
    wallet: withdrawal.wallet,
    recipient: withdrawal.recipient,
    amount: withdrawal.amount,
    nonce: withdrawal.nonce,
    expiresAt: withdrawal.expiresAt,
  };
}

export function withdrawalPayloadHash(withdrawal: UsdcWithdrawal, signature: Hex): Hex {
  const authorizationHash = hashTypedData({
    domain: withdrawalDomain,
    types: withdrawalTypes,
    primaryType: "UsdcWithdrawal",
    message: withdrawalMessage(withdrawal),
  });
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes" }],
    [withdrawal.to, withdrawal.data, authorizationHash, signature],
  ));
}

// Any other token: the owner signs which token too, so a signature for one token can't move another.
export const tokenWithdrawalTypes = {
  TokenWithdrawal: [
    { name: "wallet", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export type TokenWithdrawal = Omit<UsdcWithdrawal, "to"> & { token: Address; to: Address };

export function buildTokenWithdrawal(input: WithdrawalInput & { token: Address }): TokenWithdrawal {
  const token = getAddress(input.token);
  // USDC has its own withdrawal, which also keeps back what the network fees need.
  if (token === zeroAddress || token === ARC_TOKENS.USDC.address) throw new Error("Invalid withdrawal token");
  return { ...transferFromWallet(input, token), token };
}

export function tokenWithdrawalMessage(withdrawal: TokenWithdrawal) {
  return {
    wallet: withdrawal.wallet,
    token: withdrawal.token,
    recipient: withdrawal.recipient,
    amount: withdrawal.amount,
    nonce: withdrawal.nonce,
    expiresAt: withdrawal.expiresAt,
  };
}

export function tokenWithdrawalPayloadHash(withdrawal: TokenWithdrawal, signature: Hex): Hex {
  const authorizationHash = hashTypedData({
    domain: withdrawalDomain,
    types: tokenWithdrawalTypes,
    primaryType: "TokenWithdrawal",
    message: tokenWithdrawalMessage(withdrawal),
  });
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes" }],
    [withdrawal.to, withdrawal.data, authorizationHash, signature],
  ));
}
