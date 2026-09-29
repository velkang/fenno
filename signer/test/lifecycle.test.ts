import { describe, expect, it } from "vitest";
import {
  generateWrappingKey,
  importWrappingKey,
  provisionEncryptedWallet,
  withManagedAccount,
  type EncryptedWallet,
} from "../src/crypto";
import {
  closeEmptyTestnetProofWallet,
  rotateManagedWalletKey,
  WalletLifecycleError,
  type LifecycleWallet,
  type WalletLifecycleStore,
} from "../src/lifecycle";

class MemoryLifecycleStore implements WalletLifecycleStore {
  closed = false;

  constructor(public wallet: LifecycleWallet) {}

  async getWallet(userId: string, walletId: string) {
    return this.wallet.userId === userId && this.wallet.walletId === walletId
      ? this.wallet
      : null;
  }

  async replaceEncryptedWallet(input: {
    wallet: EncryptedWallet;
    expectedKeyVersion: number;
  }) {
    if (this.wallet.keyVersion !== input.expectedKeyVersion) return false;
    this.wallet = { ...this.wallet, ...input.wallet };
    return true;
  }

  async closeEmptyWallet() {
    if (this.wallet.state !== "paused") return false;
    this.wallet.state = "closed";
    this.closed = true;
    return true;
  }
}

async function fixture(state: LifecycleWallet["state"] = "paused") {
  const currentWrappingKey = await importWrappingKey(generateWrappingKey());
  const nextWrappingKey = await importWrappingKey(generateWrappingKey());
  const encrypted = await provisionEncryptedWallet(
    currentWrappingKey,
    1,
    "wallet-lifecycle",
  );
  const wallet: LifecycleWallet = { ...encrypted, userId: "user-1", state };
  return {
    store: new MemoryLifecycleStore(wallet),
    currentWrappingKey,
    nextWrappingKey,
  };
}

describe("managed wallet lifecycle", () => {
  it("rotates a paused wallet from wrapping-key version 1 to 2", async () => {
    const { store, currentWrappingKey, nextWrappingKey } = await fixture();
    const result = await rotateManagedWalletKey(
      store,
      currentWrappingKey,
      nextWrappingKey,
      {
        userId: "user-1",
        walletId: "wallet-lifecycle",
        currentKeyVersion: 1,
        nextKeyVersion: 2,
        now: 1_800_000_000_000,
      },
    );

    expect(result.keyVersion).toBe(2);
    await expect(
      withManagedAccount(store.wallet, nextWrappingKey, (account) =>
        account.signMessage({ message: "rotated" }),
      ),
    ).resolves.toMatch(/^0x[0-9a-f]+$/i);
  });

  it("refuses rotation until the wallet is paused", async () => {
    const { store, currentWrappingKey, nextWrappingKey } = await fixture("active");
    await expect(
      rotateManagedWalletKey(store, currentWrappingKey, nextWrappingKey, {
        userId: "user-1",
        walletId: "wallet-lifecycle",
        currentKeyVersion: 1,
        nextKeyVersion: 2,
        now: 1_800_000_000_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WalletLifecycleError>>({
        code: "WALLET_MUST_BE_PAUSED",
      }),
    );
  });

  it("closes only a paused wallet with zero native balance", async () => {
    const { store } = await fixture();
    await expect(
      closeEmptyTestnetProofWallet(store, async () => 1n, {
        userId: "user-1",
        walletId: "wallet-lifecycle",
        now: 1_800_000_000_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WalletLifecycleError>>({
        code: "WALLET_NOT_EMPTY",
      }),
    );
    expect(store.closed).toBe(false);

    await expect(
      closeEmptyTestnetProofWallet(store, async () => 0n, {
        userId: "user-1",
        walletId: "wallet-lifecycle",
        now: 1_800_000_000_001,
      }),
    ).resolves.toEqual({
      walletId: "wallet-lifecycle",
      address: store.wallet.address,
      state: "closed",
    });
    expect(store.closed).toBe(true);
  });
});
