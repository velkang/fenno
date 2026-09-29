import { describe, expect, it } from "vitest";
import { arcTestnetProofPayloadHash } from "../src";

describe("Arc Testnet proof intent", () => {
  it("hashes canonical lowercase wallet semantics", () => {
    const lower = arcTestnetProofPayloadHash({
      walletId: "wallet-1",
      address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    });
    const checksummed = arcTestnetProofPayloadHash({
      walletId: "wallet-1",
      address: "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD",
    });

    expect(lower).toBe(checksummed);
    expect(lower).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
