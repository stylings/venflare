import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { createSecret, decodeAuthorization, verifySecret, storageKey } from "#core/accounts/crypto";

describe("Vencloud authorization", () => {
  test("decodes the existing client's raw base64 token", () => {
    expect(decodeAuthorization(btoa("secret:123456789012345678"))).toEqual({
      secret: "secret",
      userId: "123456789012345678",
    });
  });

  test.each([
    "",
    "Bearer token",
    "!!!",
    "YWJj=",
    btoa("a:1:2"),
    btoa("a:"),
    btoa(":1"),
    btoa("a:NaN"),
  ])("rejects malformed authorization: %s", (token) => {
    expect(decodeAuthorization(token)).toBeUndefined();
  });

  test("uses HMAC-SHA-256 with explicit purpose separation", async () => {
    const key = await storageKey("pepper", "123", "account");
    expect(key).toBe(createHmac("sha256", "pepper").update("vencloud:account:123").digest("hex"));
    expect(key).not.toBe(await storageKey("pepper", "123", "settings"));
    expect(key).not.toBe(await storageKey("other-pepper", "123", "account"));
    expect(key).not.toBe(await createSecret("pepper", "123"));
  });

  test("derives a stable token bound to the account generation", async () => {
    const first = await createSecret("pepper", "generation");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(
      createHmac("sha256", "pepper").update("vencloud:secret:generation").digest("hex"),
    );
    expect(first).toBe(await createSecret("pepper", "generation"));
    expect(first).not.toBe(await createSecret("pepper", "next-generation"));
  });

  test("verifies tokens using the server key and account generation", async () => {
    const secret = await createSecret("pepper", "generation");
    expect(await verifySecret("pepper", "generation", secret)).toBe(true);
    expect(await verifySecret("other-pepper", "generation", secret)).toBe(false);
    expect(await verifySecret("pepper", "next-generation", secret)).toBe(false);
    expect(await verifySecret("pepper", "generation", "0".repeat(64))).toBe(false);
  });

  test.each(["", "not-hex", "0".repeat(63), "0".repeat(65), "g".repeat(64)])(
    "rejects malformed secrets: %s",
    async (secret) => {
      expect(await verifySecret("pepper", "generation", secret)).toBe(false);
    },
  );
});
