import { bytesToHex, hexToBytes, type Address } from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type LocalAccount,
} from "viem/accounts";

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;

export type EncryptedWallet = {
  walletId: string;
  address: Address;
  keyVersion: number;
  ciphertext: string;
  ciphertextIv: string;
  wrappedDataKey: string;
  wrappedDataKeyIv: string;
};

const utf8 = new TextEncoder();

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function additionalData(
  walletId: string,
  address: Address,
  keyVersion: number,
): Uint8Array {
  // Keeps the pre-rename "actora" prefix: existing wallet keys were encrypted with it.
  return utf8.encode(
    `actora-wallet-v1:${walletId}:${keyVersion}:${address.toLowerCase()}`,
  );
}

async function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.byteLength !== AES_KEY_BYTES) {
    throw new Error("AES_KEY_LENGTH_INVALID");
  }

  return crypto.subtle.importKey("raw", webCryptoBytes(bytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function importWrappingKey(encodedKey: string): Promise<CryptoKey> {
  const bytes = decodeBase64(encodedKey);
  try {
    return await importAesKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function generateWrappingKey(): string {
  const bytes = randomBytes(AES_KEY_BYTES);
  try {
    return encodeBase64(bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function provisionEncryptedWallet(
  wrappingKey: CryptoKey,
  keyVersion: number,
  walletId: string,
): Promise<EncryptedWallet> {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error("KEY_VERSION_INVALID");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(walletId)) {
    throw new Error("WALLET_ID_INVALID");
  }

  const privateKey = generatePrivateKey();
  const privateKeyBytes = hexToBytes(privateKey);
  const address = privateKeyToAccount(privateKey).address;
  const dataKeyBytes = randomBytes(AES_KEY_BYTES);
  const ciphertextIv = randomBytes(IV_BYTES);
  const wrappedDataKeyIv = randomBytes(IV_BYTES);

  try {
    const dataKey = await importAesKey(dataKeyBytes);
    const aad = additionalData(walletId, address, keyVersion);
    const [ciphertext, wrappedDataKey] = await Promise.all([
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(ciphertextIv),
          additionalData: webCryptoBytes(aad),
        },
        dataKey,
        webCryptoBytes(privateKeyBytes),
      ),
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(wrappedDataKeyIv),
          additionalData: webCryptoBytes(aad),
        },
        wrappingKey,
        webCryptoBytes(dataKeyBytes),
      ),
    ]);

    return {
      walletId,
      address,
      keyVersion,
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      ciphertextIv: encodeBase64(ciphertextIv),
      wrappedDataKey: encodeBase64(new Uint8Array(wrappedDataKey)),
      wrappedDataKeyIv: encodeBase64(wrappedDataKeyIv),
    };
  } finally {
    privateKeyBytes.fill(0);
    dataKeyBytes.fill(0);
    ciphertextIv.fill(0);
    wrappedDataKeyIv.fill(0);
  }
}

export async function rotateEncryptedWallet(
  record: EncryptedWallet,
  currentWrappingKey: CryptoKey,
  nextWrappingKey: CryptoKey,
  nextKeyVersion: number,
): Promise<EncryptedWallet> {
  if (
    !Number.isSafeInteger(nextKeyVersion) ||
    nextKeyVersion <= record.keyVersion
  ) {
    throw new Error("KEY_VERSION_INVALID");
  }

  const currentAad = additionalData(
    record.walletId,
    record.address,
    record.keyVersion,
  );
  const nextAad = additionalData(
    record.walletId,
    record.address,
    nextKeyVersion,
  );
  const currentWrappedDataKey = decodeBase64(record.wrappedDataKey);
  const currentWrappedDataKeyIv = decodeBase64(record.wrappedDataKeyIv);
  const nextCiphertextIv = randomBytes(IV_BYTES);
  const nextWrappedDataKeyIv = randomBytes(IV_BYTES);
  let dataKeyBytes: Uint8Array | undefined;
  let privateKeyBytes: Uint8Array | undefined;

  try {
    dataKeyBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(currentWrappedDataKeyIv),
          additionalData: webCryptoBytes(currentAad),
        },
        currentWrappingKey,
        webCryptoBytes(currentWrappedDataKey),
      ),
    );
    const dataKey = await importAesKey(dataKeyBytes);
    privateKeyBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(decodeBase64(record.ciphertextIv)),
          additionalData: webCryptoBytes(currentAad),
        },
        dataKey,
        webCryptoBytes(decodeBase64(record.ciphertext)),
      ),
    );
    if (
      privateKeyToAccount(bytesToHex(privateKeyBytes)).address.toLowerCase() !==
      record.address.toLowerCase()
    ) {
      throw new Error("WALLET_ADDRESS_MISMATCH");
    }

    const [ciphertext, wrappedDataKey] = await Promise.all([
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(nextCiphertextIv),
          additionalData: webCryptoBytes(nextAad),
        },
        dataKey,
        webCryptoBytes(privateKeyBytes),
      ),
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(nextWrappedDataKeyIv),
          additionalData: webCryptoBytes(nextAad),
        },
        nextWrappingKey,
        webCryptoBytes(dataKeyBytes),
      ),
    ]);

    return {
      walletId: record.walletId,
      address: record.address,
      keyVersion: nextKeyVersion,
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      ciphertextIv: encodeBase64(nextCiphertextIv),
      wrappedDataKey: encodeBase64(new Uint8Array(wrappedDataKey)),
      wrappedDataKeyIv: encodeBase64(nextWrappedDataKeyIv),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "KEY_VERSION_INVALID") {
      throw error;
    }
    throw new Error("WALLET_ROTATION_FAILED", { cause: error });
  } finally {
    currentWrappedDataKey.fill(0);
    currentWrappedDataKeyIv.fill(0);
    nextCiphertextIv.fill(0);
    nextWrappedDataKeyIv.fill(0);
    dataKeyBytes?.fill(0);
    privateKeyBytes?.fill(0);
  }
}

export async function withManagedAccount<T>(
  record: EncryptedWallet,
  wrappingKey: CryptoKey,
  operation: (account: LocalAccount) => Promise<T>,
): Promise<T> {
  const aad = additionalData(record.walletId, record.address, record.keyVersion);
  const wrappedDataKey = decodeBase64(record.wrappedDataKey);
  const wrappedDataKeyIv = decodeBase64(record.wrappedDataKeyIv);
  let dataKeyBytes: Uint8Array | undefined;
  let privateKeyBytes: Uint8Array | undefined;

  try {
    dataKeyBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(wrappedDataKeyIv),
          additionalData: webCryptoBytes(aad),
        },
        wrappingKey,
        webCryptoBytes(wrappedDataKey),
      ),
    );

    const dataKey = await importAesKey(dataKeyBytes);
    privateKeyBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(decodeBase64(record.ciphertextIv)),
          additionalData: webCryptoBytes(aad),
        },
        dataKey,
        webCryptoBytes(decodeBase64(record.ciphertext)),
      ),
    );

    const account = privateKeyToAccount(bytesToHex(privateKeyBytes));
    if (account.address.toLowerCase() !== record.address.toLowerCase()) {
      throw new Error("WALLET_ADDRESS_MISMATCH");
    }

    return await operation(account);
  } catch (error) {
    if (error instanceof Error && error.message === "WALLET_ADDRESS_MISMATCH") {
      throw error;
    }
    throw new Error("WALLET_DECRYPTION_FAILED", { cause: error });
  } finally {
    wrappedDataKey.fill(0);
    wrappedDataKeyIv.fill(0);
    dataKeyBytes?.fill(0);
    privateKeyBytes?.fill(0);
  }
}
