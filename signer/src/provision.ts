import type { Address } from "viem";
import {
  provisionEncryptedWallet,
  type EncryptedWallet,
} from "./crypto";

export type StoredManagedWallet = EncryptedWallet & {
  userId: string;
  ownerAddressAtCreation: Address;
  state: "active";
  createdAt: number;
  updatedAt: number;
};

export interface WalletProvisioningStore {
  getOwnerAddress(userId: string): Promise<Address | null>;
  getWalletByUserId(userId: string): Promise<StoredManagedWallet | null>;
  insertWallet(wallet: StoredManagedWallet): Promise<void>;
}

export type ProvisionedWallet = {
  walletId: string;
  address: Address;
  created: boolean;
};

export class ProvisioningError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function provisionWallet(
  store: WalletProvisioningStore,
  wrappingKey: CryptoKey,
  input: { userId: string; walletId: string; keyVersion: number; now: number },
): Promise<ProvisionedWallet> {
  const existing = await store.getWalletByUserId(input.userId);
  if (existing) {
    if (existing.walletId !== input.walletId) {
      throw new ProvisioningError("USER_ALREADY_HAS_WALLET");
    }
    return {
      walletId: existing.walletId,
      address: existing.address,
      created: false,
    };
  }

  const ownerAddress = await store.getOwnerAddress(input.userId);
  if (!ownerAddress) throw new ProvisioningError("VERIFIED_OWNER_NOT_FOUND");

  const encrypted = await provisionEncryptedWallet(
    wrappingKey,
    input.keyVersion,
    input.walletId,
  );
  const wallet: StoredManagedWallet = {
    ...encrypted,
    userId: input.userId,
    ownerAddressAtCreation: ownerAddress,
    state: "active",
    createdAt: input.now,
    updatedAt: input.now,
  };

  try {
    await store.insertWallet(wallet);
  } catch (error) {
    const raced = await store.getWalletByUserId(input.userId);
    if (raced?.walletId === input.walletId) {
      return {
        walletId: raced.walletId,
        address: raced.address,
        created: false,
      };
    }
    throw new ProvisioningError("WALLET_PERSIST_FAILED");
  }

  return {
    walletId: wallet.walletId,
    address: wallet.address,
    created: true,
  };
}

type WalletRow = {
  id: string;
  user_id: string;
  owner_address_at_creation: Address;
  address: Address;
  state: "active";
  key_version: number;
  ciphertext: string;
  ciphertext_iv: string;
  wrapped_data_key: string;
  wrapped_data_key_iv: string;
  created_at: number;
  updated_at: number;
};

function fromRow(row: WalletRow): StoredManagedWallet {
  return {
    walletId: row.id,
    userId: row.user_id,
    ownerAddressAtCreation: row.owner_address_at_creation,
    address: row.address,
    state: row.state,
    keyVersion: row.key_version,
    ciphertext: row.ciphertext,
    ciphertextIv: row.ciphertext_iv,
    wrappedDataKey: row.wrapped_data_key,
    wrappedDataKeyIv: row.wrapped_data_key_iv,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1WalletProvisioningStore implements WalletProvisioningStore {
  constructor(private readonly database: D1Database) {}

  async getOwnerAddress(userId: string): Promise<Address | null> {
    const row = await this.database
      .prepare("SELECT owner_address FROM users WHERE id = ?1")
      .bind(userId)
      .first<{ owner_address: Address }>();
    return row?.owner_address ?? null;
  }

  async getWalletByUserId(userId: string): Promise<StoredManagedWallet | null> {
    const row = await this.database
      .prepare("SELECT * FROM managed_wallets WHERE user_id = ?1")
      .bind(userId)
      .first<WalletRow>();
    return row ? fromRow(row) : null;
  }

  async insertWallet(wallet: StoredManagedWallet): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO managed_wallets (
          id, user_id, owner_address_at_creation, address, state, key_version,
          ciphertext, ciphertext_iv, wrapped_data_key, wrapped_data_key_iv,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        wallet.walletId,
        wallet.userId,
        wallet.ownerAddressAtCreation,
        wallet.address,
        wallet.state,
        wallet.keyVersion,
        wallet.ciphertext,
        wallet.ciphertextIv,
        wallet.wrappedDataKey,
        wallet.wrappedDataKeyIv,
        wallet.createdAt,
        wallet.updatedAt,
      )
      .run();
  }
}
