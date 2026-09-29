import type { Address } from "viem";
import type { EncryptedWallet } from "./crypto";
import type { WalletState } from "./policy";
import type {
  LifecycleWallet,
  WalletLifecycleStore,
} from "./lifecycle";

type LifecycleRow = {
  id: string;
  user_id: string;
  address: Address;
  state: WalletState;
  key_version: number;
  ciphertext: string;
  ciphertext_iv: string;
  wrapped_data_key: string;
  wrapped_data_key_iv: string;
};

export class D1WalletLifecycleStore implements WalletLifecycleStore {
  constructor(private readonly database: D1Database) {}

  async getWallet(userId: string, walletId: string): Promise<LifecycleWallet | null> {
    const row = await this.database
      .prepare(
        `SELECT id, user_id, address, state, key_version, ciphertext,
                ciphertext_iv, wrapped_data_key, wrapped_data_key_iv
         FROM managed_wallets WHERE id = ?1 AND user_id = ?2`,
      )
      .bind(walletId, userId)
      .first<LifecycleRow>();
    if (!row) return null;
    return {
      walletId: row.id,
      userId: row.user_id,
      address: row.address,
      state: row.state,
      keyVersion: row.key_version,
      ciphertext: row.ciphertext,
      ciphertextIv: row.ciphertext_iv,
      wrappedDataKey: row.wrapped_data_key,
      wrappedDataKeyIv: row.wrapped_data_key_iv,
    };
  }

  async replaceEncryptedWallet(input: {
    wallet: EncryptedWallet;
    expectedKeyVersion: number;
    now: number;
  }) {
    const result = await this.database
      .prepare(
        `UPDATE managed_wallets
         SET key_version = ?2, ciphertext = ?3, ciphertext_iv = ?4,
             wrapped_data_key = ?5, wrapped_data_key_iv = ?6, updated_at = ?7
         WHERE id = ?1 AND key_version = ?8 AND state = 'paused'`,
      )
      .bind(
        input.wallet.walletId,
        input.wallet.keyVersion,
        input.wallet.ciphertext,
        input.wallet.ciphertextIv,
        input.wallet.wrappedDataKey,
        input.wallet.wrappedDataKeyIv,
        input.now,
        input.expectedKeyVersion,
      )
      .run();
    return result.meta.changes === 1;
  }
}
