import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createCircleWallet,
  entitySecretCiphertext,
  signWithCircle,
  type CircleEnv,
} from "../src/circle";

const secret = "ab".repeat(32);
const env: CircleEnv = {
  CIRCLE_API_KEY: "TEST_API_KEY:id:secret",
  CIRCLE_ENTITY_SECRET: secret,
  CIRCLE_WALLET_SET_ID: "wallet-set-1",
};

let keys: CryptoKeyPair;
let pem: string;
type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function decrypt(ciphertext: string): Promise<string> {
  const bytes = Uint8Array.from(atob(ciphertext), (char) => char.charCodeAt(0));
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, keys.privateKey, bytes));
  return Array.from(plain, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stubCircle(respond: (url: string) => { status: number; body: unknown }) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/w3s/config/entity/publicKey")) {
      return Response.json({ data: { publicKey: pem } });
    }
    const { status, body } = respond(url);
    return Response.json(body, { status });
  });
}

function body(call: Call) {
  return JSON.parse(call.init?.body as string) as Record<string, unknown>;
}

beforeAll(async () => {
  keys = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = toBase64(await crypto.subtle.exportKey("spki", keys.publicKey));
  // Circle labels its SPKI key "RSA PUBLIC KEY"; the header must not matter.
  pem = `-----BEGIN RSA PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END RSA PUBLIC KEY-----\n`;
});

afterEach(() => {
  calls = [];
  vi.unstubAllGlobals();
});

describe("Circle client", () => {
  it("encrypts the entity secret freshly for every request", async () => {
    stubCircle(() => ({ status: 404, body: {} }));
    const first = await entitySecretCiphertext(env);
    const second = await entitySecretCiphertext(env);

    expect(first).not.toBe(second);
    expect(await decrypt(first)).toBe(secret);
    expect(await decrypt(second)).toBe(secret);
  });

  it("rejects a malformed entity secret before calling Circle", async () => {
    stubCircle(() => ({ status: 404, body: {} }));
    await expect(entitySecretCiphertext({ ...env, CIRCLE_ENTITY_SECRET: "not-hex" }))
      .rejects.toMatchObject({ code: "CIRCLE_ENTITY_SECRET_INVALID" });
  });

  it("creates one EVM EOA wallet in the wallet set", async () => {
    stubCircle(() => ({
      status: 201,
      body: { data: { wallets: [{ id: "circle-1", address: "0x3333333333333333333333333333333333333333" }] } },
    }));
    const wallet = await createCircleWallet(env, "user-1");

    expect(wallet).toEqual({ circleWalletId: "circle-1", address: "0x3333333333333333333333333333333333333333" });
    const create = calls.find((call) => call.url.endsWith("/v1/w3s/developer/wallets"))!;
    expect(new Headers(create.init?.headers).get("authorization")).toBe(`Bearer ${env.CIRCLE_API_KEY}`);
    const sent = body(create);
    expect(sent).toMatchObject({
      idempotencyKey: "user-1",
      walletSetId: "wallet-set-1",
      blockchains: ["EVM"],
      accountType: "EOA",
      count: 1,
    });
    expect(await decrypt(sent.entitySecretCiphertext as string)).toBe(secret);
  });

  it("sends the transaction with decimal-string quantities and returns the signed hex", async () => {
    stubCircle(() => ({ status: 200, body: { data: { signedTransaction: "0x02abcdef", txHash: "0x00" } } }));
    const signed = await signWithCircle(env, "circle-1", {
      type: "eip1559",
      chainId: 5042,
      nonce: 7,
      to: "0x4444444444444444444444444444444444444444",
      data: "0x1234",
      value: 0n,
      gas: 60_000n,
      maxFeePerGas: 25_000_000_000n,
      maxPriorityFeePerGas: 1n,
    });

    expect(signed).toBe("0x02abcdef");
    const sent = body(calls.find((call) => call.url.endsWith("/v1/w3s/developer/sign/transaction"))!);
    expect(sent.walletId).toBe("circle-1");
    expect(JSON.parse(sent.transaction as string)).toEqual({
      chainId: 5042,
      nonce: "7",
      to: "0x4444444444444444444444444444444444444444",
      data: "0x1234",
      value: "0",
      gas: "60000",
      maxFeePerGas: "25000000000",
      maxPriorityFeePerGas: "1",
    });
  });

  it("maps Circle errors to a typed error without leaking the response", async () => {
    stubCircle(() => ({ status: 401, body: { code: 401, message: "Malformed API key" } }));
    await expect(createCircleWallet(env, "user-1")).rejects.toMatchObject({ code: "CIRCLE_401", status: 401 });
  });
});
