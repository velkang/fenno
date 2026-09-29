import { recoverTransactionAddress, type TransactionSerializableEIP1559 } from "viem";
import { describe, expect, it } from "vitest";
import {
  generateWrappingKey,
  importWrappingKey,
  provisionEncryptedWallet,
} from "../src/crypto";
import { SigningRejectedError, signAllowedTransaction } from "../src/sign";

const ARC_TESTNET_CHAIN_ID = 5_042_002;

describe("transaction signing boundary", () => {
  it("signs an exact zero-value Arc Testnet self-transfer proof", async () => {
    const wrappingKey = await importWrappingKey(generateWrappingKey());
    const wallet = await provisionEncryptedWallet(
      wrappingKey,
      1,
      "wallet-proof",
    );
    const transaction: TransactionSerializableEIP1559 = {
      type: "eip1559",
      chainId: ARC_TESTNET_CHAIN_ID,
      to: wallet.address,
      data: "0x",
      value: 0n,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 25_000_000_000n,
      maxPriorityFeePerGas: 0n,
    };
    const signed = await signAllowedTransaction(
      wallet,
      wrappingKey,
      {
        intentId: "proof-intent",
        intentStatus: "pending",
        intentExpiresAt: 1_800_000_060,
        chainId: ARC_TESTNET_CHAIN_ID,
        to: wallet.address,
        data: "0x",
        value: 0n,
        walletState: "active",
        verifiedOwnerAddress: wallet.address,
      },
      {
        chainId: ARC_TESTNET_CHAIN_ID,
        allowedCalls: new Map([[wallet.address.toLowerCase(), new Set(["0x"])]]),
        now: 1_800_000_000,
        emergencyStop: false,
      },
      transaction,
    );

    expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(
      wallet.address,
    );
  });

  it("rejects when signed calldata differs from the approved intent", async () => {
    const wrappingKey = await importWrappingKey(generateWrappingKey());
    const wallet = await provisionEncryptedWallet(
      wrappingKey,
      1,
      "wallet-proof",
    );

    await expect(
      signAllowedTransaction(
        wallet,
        wrappingKey,
        {
          intentId: "proof-intent",
          intentStatus: "pending",
          intentExpiresAt: 1_800_000_060,
          chainId: ARC_TESTNET_CHAIN_ID,
          to: wallet.address,
          data: "0x",
          value: 0n,
          walletState: "active",
          verifiedOwnerAddress: wallet.address,
        },
        {
          chainId: ARC_TESTNET_CHAIN_ID,
          allowedCalls: new Map([
            [wallet.address.toLowerCase(), new Set(["0x" as const])],
          ]),
          now: 1_800_000_000,
          emergencyStop: false,
        },
        {
          type: "eip1559",
          chainId: ARC_TESTNET_CHAIN_ID,
          to: wallet.address,
          data: "0x12345678",
          value: 0n,
          nonce: 0,
          gas: 21_000n,
          maxFeePerGas: 25_000_000_000n,
          maxPriorityFeePerGas: 0n,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SigningRejectedError>>({
        reason: "TRANSACTION_INTENT_MISMATCH",
      }),
    );
  });
});
