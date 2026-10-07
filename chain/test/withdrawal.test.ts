import { decodeFunctionData, parseAbi, recoverTypedDataAddress, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  ARC_TOKENS,
  buildTokenWithdrawal,
  buildUsdcWithdrawal,
  tokenWithdrawalMessage,
  tokenWithdrawalPayloadHash,
  tokenWithdrawalTypes,
  withdrawalDomain,
  withdrawalPayloadHash,
} from "../src";

const wallet = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;
const token = "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0" as const;
const base = { wallet, recipient, amount: 1_234n, nonce: `0x${"11".repeat(32)}` as const, expiresAt: 2_000_000_000n };

describe("token withdrawal", () => {
  it("transfers exactly the signed amount of the signed token to the signed recipient", () => {
    const withdrawal = buildTokenWithdrawal({ ...base, token });
    expect(withdrawal.to).toBe(token);
    expect(withdrawal.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: parseAbi(["function transfer(address, uint256) returns (bool)"]),
      data: withdrawal.data });
    expect(decoded.args).toEqual([recipient, 1_234n]);
  });

  it("refuses USDC (it has its own withdrawal), no token, and the wallet itself as recipient", () => {
    expect(() => buildTokenWithdrawal({ ...base, token: ARC_TOKENS.USDC.address })).toThrow();
    expect(() => buildTokenWithdrawal({ ...base, token: zeroAddress })).toThrow();
    expect(() => buildTokenWithdrawal({ ...base, token, recipient: wallet })).toThrow();
    expect(() => buildTokenWithdrawal({ ...base, token, amount: 0n })).toThrow();
  });

  it("is signed with the token named, so a signature for one token can't move another", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const withdrawal = buildTokenWithdrawal({ ...base, token });
    const signature = await owner.signTypedData({ domain: withdrawalDomain, types: tokenWithdrawalTypes,
      primaryType: "TokenWithdrawal", message: tokenWithdrawalMessage(withdrawal) });
    await expect(recoverTypedDataAddress({ domain: withdrawalDomain, types: tokenWithdrawalTypes,
      primaryType: "TokenWithdrawal", message: tokenWithdrawalMessage(withdrawal), signature })).resolves.toBe(owner.address);
    const other = buildTokenWithdrawal({ ...base, token: "0xDb0274aaEdbE7da2bb9224f8842af342704f0087" });
    await expect(recoverTypedDataAddress({ domain: withdrawalDomain, types: tokenWithdrawalTypes,
      primaryType: "TokenWithdrawal", message: tokenWithdrawalMessage(other), signature })).resolves.not.toBe(owner.address);
    // Its payload never matches a USDC withdrawal's, even with the same amount and nonce.
    expect(tokenWithdrawalPayloadHash(withdrawal, signature))
      .not.toBe(withdrawalPayloadHash(buildUsdcWithdrawal(base), signature));
  });
});
