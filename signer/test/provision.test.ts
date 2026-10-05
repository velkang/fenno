import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  type CreateCustodyWallet,
  ProvisioningError,
  provisionWallet,
  type StoredManagedWallet,
  type WalletProvisioningStore,
} from "../src/provision";

const owner = "0x2222222222222222222222222222222222222222" as Address;

const custodyAddress = "0x3333333333333333333333333333333333333333" as Address;

function circle() {
  const keys: string[] = [];
  const createWallet: CreateCustodyWallet = async (idempotencyKey) => {
    keys.push(idempotencyKey);
    return { circleWalletId: "circle-wallet-1", address: custodyAddress };
  };
  return { keys, createWallet };
}

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
  it("creates one Circle wallet keyed by the user id and is idempotent", async () => {
    const store = new MemoryStore();
    const { keys, createWallet } = circle();
    const input = { userId: "user-1", walletId: "wallet-1", now: 1_800_000_000 };

    const first = await provisionWallet(store, createWallet, input);
    const second = await provisionWallet(store, createWallet, input);

    expect(first).toEqual({ walletId: "wallet-1", address: custodyAddress, created: true });
    expect(second).toEqual({ ...first, created: false });
    expect(keys).toEqual(["user-1"]);
    expect(store.insertCount).toBe(1);
    expect(store.wallet).toEqual(expect.objectContaining({
      circleWalletId: "circle-wallet-1",
      address: custodyAddress,
      ownerAddressAtCreation: owner,
    }));
  });

  it("returns the raced wallet when a concurrent provision inserted first", async () => {
    const store = new MemoryStore();
    const { createWallet } = circle();
    const raced = { walletId: "wallet-1", address: custodyAddress, circleWalletId: "circle-wallet-1",
      userId: "user-1", ownerAddressAtCreation: owner, state: "active" as const, createdAt: 1, updatedAt: 1 };
    let reads = 0;
    store.getWalletByUserId = async () => (reads++ === 0 ? null : raced);
    store.insertWallet = async () => { throw new Error("UNIQUE constraint failed"); };

    await expect(provisionWallet(store, createWallet, { userId: "user-1", walletId: "wallet-1", now: 2 }))
      .resolves.toEqual({ walletId: "wallet-1", address: custodyAddress, created: false });
  });

  it("reports a Circle failure without storing anything, and logs Circle's reason", async () => {
    const store = new MemoryStore();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(provisionWallet(store, async () => { throw new Error("CIRCLE_401"); },
      { userId: "user-1", walletId: "wallet-1", now: 1 }))
      .rejects.toMatchObject({ code: "CUSTODY_WALLET_CREATE_FAILED" });
    expect(store.insertCount).toBe(0);
    expect(logged).toHaveBeenCalledWith("Circle wallet creation failed", "user-1", "CIRCLE_401");
    logged.mockRestore();
  });

  it("requires a verified owner before generating a managed wallet", async () => {
    const store = new MemoryStore();
    store.ownerAddress = null;
    const { keys, createWallet } = circle();

    await expect(
      provisionWallet(store, createWallet, {
        userId: "user-1",
        walletId: "wallet-1",
        now: 1_800_000_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProvisioningError>>({
        code: "VERIFIED_OWNER_NOT_FOUND",
      }),
    );
    expect(store.insertCount).toBe(0);
    expect(keys).toEqual([]);
  });

  it("does not replace an existing user's wallet", async () => {
    const store = new MemoryStore();
    const { createWallet } = circle();
    await provisionWallet(store, createWallet, {
      userId: "user-1",
      walletId: "wallet-1",
      now: 1_800_000_000,
    });

    await expect(
      provisionWallet(store, createWallet, {
        userId: "user-1",
        walletId: "wallet-2",
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
