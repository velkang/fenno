import { getAddress, type Address, type Hex, type TransactionSerializableEIP1559 } from "viem";

// Circle developer-controlled wallets hold every Stillwater wallet key. Wallets
// are created on the generic "EVM" chain, which Circle only signs for: the
// executor still picks nonce and gas, broadcasts, and reconciles itself.
export type CircleEnv = {
  CIRCLE_API_KEY: string;
  CIRCLE_ENTITY_SECRET: string;
  CIRCLE_WALLET_SET_ID: string;
};

export class CircleError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

const CIRCLE_API = "https://api.circle.com";

// The entity public key is fixed per Circle account; fetch it once per isolate,
// as Circle's own SDK does.
let publicKey: Promise<CryptoKey> | null = null;

async function circleFetch<T>(env: CircleEnv, path: string, init?: { body: unknown }): Promise<T> {
  const response = await fetch(`${CIRCLE_API}${path}`, {
    method: init ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${env.CIRCLE_API_KEY}`,
      "content-type": "application/json",
    },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const json = await response.json().catch(() => null) as { data?: T; code?: number } | null;
  if (!response.ok || !json?.data) {
    throw new CircleError(`CIRCLE_${json?.code ?? response.status}`, response.status);
  }
  return json.data;
}

function importPublicKey(pem: string): Promise<CryptoKey> {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (char) => char.charCodeAt(0),
  );
  return crypto.subtle.importKey("spki", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
}

function entityPublicKey(env: CircleEnv): Promise<CryptoKey> {
  publicKey ??= circleFetch<{ publicKey: string }>(env, "/v1/w3s/config/entity/publicKey")
    .then(({ publicKey: pem }) => importPublicKey(pem))
    .catch((error: unknown) => {
      publicKey = null;
      throw error;
    });
  return publicKey;
}

/** A fresh ciphertext for every request: Circle rejects reused ones. */
export async function entitySecretCiphertext(env: CircleEnv): Promise<string> {
  const secret = env.CIRCLE_ENTITY_SECRET.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) throw new CircleError("CIRCLE_ENTITY_SECRET_INVALID", 500);
  const bytes = Uint8Array.from(secret.match(/../g)!, (pair) => parseInt(pair, 16));
  const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, await entityPublicKey(env), bytes);
  bytes.fill(0);
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

export async function createCircleWallet(
  env: CircleEnv,
  idempotencyKey: string,
): Promise<{ circleWalletId: string; address: Address }> {
  const data = await circleFetch<{ wallets: { id: string; address: string }[] }>(env, "/v1/w3s/developer/wallets", {
    body: {
      idempotencyKey,
      entitySecretCiphertext: await entitySecretCiphertext(env),
      walletSetId: env.CIRCLE_WALLET_SET_ID,
      blockchains: ["EVM"],
      accountType: "EOA",
      count: 1,
    },
  });
  const wallet = data.wallets[0];
  if (!wallet?.id) throw new CircleError("CIRCLE_WALLET_MISSING", 502);
  return { circleWalletId: wallet.id, address: getAddress(wallet.address) };
}

export async function signWithCircle(
  env: CircleEnv,
  circleWalletId: string,
  transaction: TransactionSerializableEIP1559,
): Promise<Hex> {
  const data = await circleFetch<{ signedTransaction: string }>(env, "/v1/w3s/developer/sign/transaction", {
    body: {
      walletId: circleWalletId,
      entitySecretCiphertext: await entitySecretCiphertext(env),
      // Circle takes the JSON-RPC shape with decimal-string quantities.
      transaction: JSON.stringify({
        chainId: transaction.chainId,
        nonce: String(transaction.nonce),
        to: transaction.to,
        data: transaction.data,
        value: String(transaction.value ?? 0n),
        gas: String(transaction.gas),
        maxFeePerGas: String(transaction.maxFeePerGas),
        maxPriorityFeePerGas: String(transaction.maxPriorityFeePerGas),
      }),
    },
  });
  if (!/^0x[0-9a-fA-F]+$/.test(data.signedTransaction)) throw new CircleError("CIRCLE_SIGNATURE_INVALID", 502);
  return data.signedTransaction as Hex;
}
