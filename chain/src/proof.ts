import { keccak256, stringToHex, type Address, type Hex } from "viem";

export const ARC_TESTNET_PROOF_KIND = "arc_testnet_self_transfer";

export function arcTestnetProofPayloadHash(input: {
  walletId: string;
  address: Address;
}): Hex {
  return keccak256(
    stringToHex(
      `actora-proof-v1:${input.walletId}:${input.address.toLowerCase()}:self:0`,
    ),
  );
}
