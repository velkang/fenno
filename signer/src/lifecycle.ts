import type { Address } from "viem";
import {
  rotateEncryptedWallet,
  type EncryptedWallet,
} from "./crypto";
import type { WalletState } from "./policy";

export type LifecycleWallet = EncryptedWallet & {
  userId: string;
  state: WalletState;
};

export interface WalletLifecycleStore {
  getWallet(userId: string, walletId: string): Promise<LifecycleWallet | null>;
  replaceEncryptedWallet(input: {
    wallet: EncryptedWallet;
    expectedKeyVersion: number;
    now: number;
  }): Promise<boolean>;
}

export class WalletLifecycleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function rotateManagedWalletKey(
  store: WalletLifecycleStore,
  currentWrappingKey: CryptoKey,
  nextWrappingKey: CryptoKey,
  input: {
    userId: string;
    walletId: string;
    currentKeyVersion: number;
    nextKeyVersion: number;
    now: number;
  },
): Promise<{ walletId: string; address: Address; keyVersion: number }> {
  const wallet = await store.getWallet(input.userId, input.walletId);
  if (!wallet) throw new WalletLifecycleError("WALLET_NOT_FOUND");
  if (wallet.state !== "paused") {
    throw new WalletLifecycleError("WALLET_MUST_BE_PAUSED");
  }
  if (
    wallet.keyVersion !== input.currentKeyVersion ||
    input.nextKeyVersion <= input.currentKeyVersion
  ) {
    throw new WalletLifecycleError("KEY_VERSION_NOT_ROTATABLE");
  }

  const rotated = await rotateEncryptedWallet(
    wallet,
    currentWrappingKey,
    nextWrappingKey,
    input.nextKeyVersion,
  );
  if (
    !(await store.replaceEncryptedWallet({
      wallet: rotated,
      expectedKeyVersion: wallet.keyVersion,
      now: input.now,
    }))
  ) {
    throw new WalletLifecycleError("WALLET_ROTATION_RACE");
  }
  return {
    walletId: rotated.walletId,
    address: rotated.address,
    keyVersion: rotated.keyVersion,
  };
}
