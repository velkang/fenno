import { recoverMessageAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  generateWrappingKey,
  importWrappingKey,
  provisionEncryptedWallet,
  rotateEncryptedWallet,
  withManagedAccount,
} from "../src/crypto";

describe("managed wallet encryption", () => {
  it("provisions an encrypted wallet that can sign without exporting its key", async () => {
    const wrappingKey = await importWrappingKey(generateWrappingKey());
    const wallet = await provisionEncryptedWallet(wrappingKey, 1, "wallet-1");
    const message = "actora-signer-proof";
    const signature = await withManagedAccount(wallet, wrappingKey, (account) =>
      account.signMessage({ message }),
    );

    expect(
      await recoverMessageAddress({ message, signature }),
    ).toEqual(wallet.address);
    expect(wallet).not.toHaveProperty("privateKey");
  });

  it("rejects tampered ciphertext", async () => {
    const wrappingKey = await importWrappingKey(generateWrappingKey());
    const wallet = await provisionEncryptedWallet(wrappingKey, 1, "wallet-1");
    const tampered = {
      ...wallet,
      ciphertext: `${wallet.ciphertext.slice(0, -2)}AA`,
    };

    await expect(
      withManagedAccount(tampered, wrappingKey, (account) =>
        account.signMessage({ message: "must fail" }),
      ),
    ).rejects.toThrow("WALLET_DECRYPTION_FAILED");
  });

  it("binds ciphertext to its key version", async () => {
    const wrappingKey = await importWrappingKey(generateWrappingKey());
    const wallet = await provisionEncryptedWallet(wrappingKey, 1, "wallet-1");

    await expect(
      withManagedAccount({ ...wallet, keyVersion: 2 }, wrappingKey, (account) =>
        account.signMessage({ message: "must fail" }),
      ),
    ).rejects.toThrow("WALLET_DECRYPTION_FAILED");
  });

  it("binds ciphertext to the wallet record ID", async () => {
    const wrappingKey = await importWrappingKey(generateWrappingKey());
    const wallet = await provisionEncryptedWallet(wrappingKey, 1, "wallet-1");

    await expect(
      withManagedAccount({ ...wallet, walletId: "wallet-2" }, wrappingKey, (account) =>
        account.signMessage({ message: "must fail" }),
      ),
    ).rejects.toThrow("WALLET_DECRYPTION_FAILED");
  });

  it("rotates both encryption layers to a newer wrapping-key version", async () => {
    const currentWrappingKey = await importWrappingKey(generateWrappingKey());
    const nextWrappingKey = await importWrappingKey(generateWrappingKey());
    const wallet = await provisionEncryptedWallet(
      currentWrappingKey,
      1,
      "wallet-rotate",
    );
    const rotated = await rotateEncryptedWallet(
      wallet,
      currentWrappingKey,
      nextWrappingKey,
      2,
    );

    expect(rotated.address).toBe(wallet.address);
    expect(rotated.keyVersion).toBe(2);
    expect(rotated.ciphertext).not.toBe(wallet.ciphertext);
    await expect(
      withManagedAccount(rotated, currentWrappingKey, (account) =>
        account.signMessage({ message: "must fail" }),
      ),
    ).rejects.toThrow("WALLET_DECRYPTION_FAILED");
    await expect(
      withManagedAccount(rotated, nextWrappingKey, (account) =>
        account.signMessage({ message: "rotation works" }),
      ),
    ).resolves.toMatch(/^0x[0-9a-f]+$/i);
  });
});
