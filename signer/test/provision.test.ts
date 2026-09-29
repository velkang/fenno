import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { generateWrappingKey, importWrappingKey } from "../src/crypto";
import {
  ProvisioningError,
  provisionWallet,
  type StoredManagedWallet,
  type WalletProvisioningStore,
} from "../src/provision";

const owner = "0x2222222222222222222222222222222222222222" as Address;

class MemoryStore implements WalletProvisioningStore {
  ownerAddress: Address | null = owner;
  wallet: StoredManagedWallet | null = null;
  insertCount = 0;

  async getOwnerAddress(): Promise<Address | null> {
    return this.ownerAddress;
  }

  async getWalletByUserId(): Promise<StoredManagedWallet | null> {
    return this.wallet;
  }

  async insertWallet(wallet: StoredManagedWallet): Promise<void> {
    this.insertCount += 1;
    this.wallet = wallet;
  }
}

describe("wallet provisioning", () => {
  it("creates one encrypted wallet and is idempotent", async () => {
    const store = new MemoryStore();
    const wrappingKey = await importWrappingKey(generateWrappingKey());
    const input = {
      userId: "user-1",
      walletId: "wallet-1",
      keyVersion: 1,
      now: 1_800_000_000,
    };

    const first = await provisionWallet(store, wrappingKey, input);
    const second = await provisionWallet(store, wrappingKey, input);

    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(store.insertCount).toBe(1);
    expect(store.wallet).not.toHaveProperty("privateKey");
    expect(store.wallet?.ownerAddressAtCreation).toBe(owner);
  });

  it("requires a verified owner before generating a managed wallet", async () => {
    const store = new MemoryStore();
    store.ownerAddress = null;
    const wrappingKey = await importWrappingKey(generateWrappingKey());

    await expect(
      provisionWallet(store, wrappingKey, {
        userId: "user-1",
        walletId: "wallet-1",
        keyVersion: 1,
        now: 1_800_000_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProvisioningError>>({
        code: "VERIFIED_OWNER_NOT_FOUND",
      }),
    );
    expect(store.insertCount).toBe(0);
  });

  it("does not replace an existing user's wallet", async () => {
    const store = new MemoryStore();
    const wrappingKey = await importWrappingKey(generateWrappingKey());
    await provisionWallet(store, wrappingKey, {
      userId: "user-1",
      walletId: "wallet-1",
      keyVersion: 1,
      now: 1_800_000_000,
    });

    await expect(
      provisionWallet(store, wrappingKey, {
        userId: "user-1",
        walletId: "wallet-2",
        keyVersion: 1,
        now: 1_800_000_001,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProvisioningError>>({
        code: "USER_ALREADY_HAS_WALLET",
      }),
    );
    expect(store.insertCount).toBe(1);
  });
});
