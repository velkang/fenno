import { describe, expect, it } from "vitest";
import app from "../src";

describe("API health", () => {
  it("reports readiness without exposing configuration", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
