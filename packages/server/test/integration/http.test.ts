import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { encryptedPartSize } from "@vencloud/core/settings/crypto";
import { createHarness, type Harness } from "./harness";
import { userId } from "../../../core/test/support";

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(() => harness?.worker.dispose());
beforeEach(async () => {
  await harness.database.batch([
    harness.database.prepare("DELETE FROM accounts"),
    harness.database.prepare("DELETE FROM uploads"),
  ]);
  const objects = await harness.bucket.list();
  if (objects.objects.length > 0)
    await harness.bucket.delete(objects.objects.map((object) => object.key));
});

const request = (path: string, options?: RequestInit) => harness.request(path, options);

const login = async (): Promise<string> => {
  const response = await request("/v1/oauth/callback?code=valid");
  const body = v.parse(v.object({ secret: v.string() }), await response.json());
  expect(response.status).toBe(200);
  expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
  return btoa(`${body.secret}:${userId}`);
};

const put = (authorization: string, body: Uint8Array<ArrayBuffer> | string) =>
  request("/v1/settings", {
    method: "PUT",
    headers: { authorization, "content-type": "application/octet-stream" },
    body,
  });

describe("built Worker protocol", () => {
  test("serves health, OAuth configuration, source link, and root redirect", async () => {
    const health = await request("/v1");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ping: "pong" });
    expect(health.headers.get("link")).toContain('rel="source"');
    const oauth = await request("/v1/oauth/settings");
    expect(await oauth.json()).toMatchObject({ clientId: "987654321098765432" });
    const root = await request("/", { redirect: "manual" });
    expect(root.status).toBe(303);
    expect(root.headers.get("location")).toBe("https://github.com/example/vencloud-worker");
  });

  test("uses Vencloud JSON errors for missing or invalid OAuth codes", async () => {
    const missing = await request("/v1/oauth/callback");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Missing code" });
    const invalid = await request("/v1/oauth/callback?code=invalid");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Invalid code" });
  });

  test("serves health without a source URL or root redirect", async () => {
    const local = await createHarness({ SOURCE_URL: "" });
    try {
      for (const path of ["/", "/v1"]) {
        const response = await local.request(path, { redirect: "manual" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ping: "pong" });
        expect(response.headers.get("link")).toBeNull();
        expect(response.headers.get("location")).toBeNull();
      }
    } finally {
      await local.worker.dispose();
    }
  });

  test("concurrent first logins return one persistent secret", async () => {
    const tokens = await Promise.all(Array.from({ length: 8 }, () => login()));
    expect(new Set(tokens).size).toBe(1);
    const count = await harness.database
      .prepare("SELECT count(*) AS n FROM accounts")
      .first<number>("n");
    expect(count).toBe(1);
  });

  test("does not persist API secrets or accept a forged token", async () => {
    const authorization = await login();
    const [secret] = atob(authorization).split(":");
    const rows = await harness.database.prepare("SELECT * FROM accounts").all();
    expect(JSON.stringify(rows.results)).not.toContain(secret);
    expect(rows.results[0]).not.toHaveProperty("secret");
    const forged = btoa(`${"0".repeat(64)}:${userId}`);
    const response = await request("/v1/settings", { headers: { authorization: forged } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid authorization" });
  });

  test("authenticates before validating upload content", async () => {
    const response = await request("/v1/settings", { method: "PUT", body: "not-json" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Missing authorization" });
  });

  test.each(["/v1/settings", "/v1/settings/"])(
    "round-trips opaque bytes and ETags at %s",
    async (path) => {
      const authorization = await login();
      expect((await request(path, { headers: { authorization } })).status).toBe(404);
      const bytes = new Uint8Array([0, 255, 128, 1, 13, 10]);
      const uploaded = await request(path, {
        method: "PUT",
        headers: { authorization, "content-type": "application/octet-stream" },
        body: bytes,
      });
      expect(uploaded.status).toBe(200);
      const { written } = v.parse(v.object({ written: v.number() }), await uploaded.json());
      expect(Number.isSafeInteger(written)).toBe(true);
      const downloaded = await request(path, { headers: { authorization } });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("etag")).toBe(String(written));
      expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

      const head = await request(path, { method: "HEAD", headers: { authorization } });
      expect(head.status).toBe(204);
      expect(head.headers.get("etag")).toBe(String(written));
      expect(await head.text()).toBe("");
      const unchanged = await request(path, {
        headers: { authorization, "if-none-match": String(written) },
      });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");

      const deleted = await request(path, { method: "DELETE", headers: { authorization } });
      expect(deleted.status).toBe(204);
      expect((await request(path, { headers: { authorization } })).status).toBe(404);
    },
  );

  test("supports empty backups", async () => {
    const authorization = await login();
    expect((await put(authorization, "")).status).toBe(200);
    const response = await request("/v1/settings", { headers: { authorization } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("encrypts objects stored in R2 and rejects tampered ciphertext", async () => {
    const authorization = await login();
    const secretSettings = "super-secret-vencord-settings-payload";
    expect((await put(authorization, secretSettings)).status).toBe(200);

    const listed = await harness.bucket.list();
    expect(listed.objects).toHaveLength(1);
    const key = listed.objects[0]!.key;
    const object = await harness.bucket.get(key);
    expect(object).not.toBeNull();
    const raw = new Uint8Array(await object!.arrayBuffer());
    expect(new TextDecoder().decode(raw)).not.toContain(secretSettings);
    expect(raw.subarray(0, 4)).toEqual(new Uint8Array([0x56, 0x46, 0x4c, 0x01]));

    const tampered = raw.slice();
    tampered[tampered.byteLength - 1]! ^= 0xff;
    await harness.bucket.put(key, tampered);
    const corrupted = await request("/v1/settings", { headers: { authorization } });
    expect(corrupted.status).toBe(500);
    expect(await corrupted.json()).toEqual({ error: "Internal server error" });
  });

  test.each(["second frame", "final frame", "truncated stream"])(
    "fails the download after corruption in a %s",
    async (corruption) => {
      const authorization = await login();
      expect((await put(authorization, new Uint8Array(11 * 1024 * 1024).fill(13))).status).toBe(
        200,
      );

      const listed = await harness.bucket.list();
      const key = listed.objects[0]!.key;
      const object = await harness.bucket.get(key);
      const raw = new Uint8Array(await object!.arrayBuffer());
      if (corruption === "truncated stream") {
        await harness.bucket.put(key, raw.subarray(0, 2 * encryptedPartSize));
      } else {
        const offset = (corruption === "second frame" ? 1 : 2) * encryptedPartSize + 100;
        raw[offset]! ^= 0xff;
        await harness.bucket.put(key, raw);
      }

      const response = await request("/v1/settings", { headers: { authorization } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).not.toBeNull();
      expect(response.arrayBuffer()).rejects.toThrow();
    },
  );

  test("streams a maximum-size backup through multipart R2 storage", async () => {
    const authorization = await login();
    const body = new Uint8Array(32_000_000).fill(173);
    expect((await put(authorization, body)).status).toBe(200);
    const response = await request("/v1/settings", { headers: { authorization } });
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    const result = new Uint8Array(await response.arrayBuffer());
    expect(result.byteLength).toBe(body.byteLength);
    expect(result.every((byte) => byte === 173)).toBe(true);
  });

  test("rejects uploads beyond the limit without replacing existing settings", async () => {
    const authorization = await login();
    await put(authorization, "original");
    const oversized = await put(authorization, new Uint8Array(32_000_001));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "Settings are too large" });
    expect(await (await request("/v1/settings", { headers: { authorization } })).text()).toBe(
      "original",
    );
  });

  test("deletes settings without revoking the account", async () => {
    const authorization = await login();
    await put(authorization, "backup");
    expect(
      (await request("/v1/settings", { method: "DELETE", headers: { authorization } })).status,
    ).toBe(204);
    expect((await request("/v1/settings", { headers: { authorization } })).status).toBe(404);
    expect((await put(authorization, "new backup")).status).toBe(200);
  });

  test("trailing-slash account deletion revokes credentials immediately", async () => {
    const authorization = await login();
    await put(authorization, "backup");
    const response = await request("/v1/", { method: "DELETE", headers: { authorization } });
    expect(response.status).toBe(204);
    expect((await request("/v1/settings", { headers: { authorization } })).status).toBe(401);
    const replacement = await login();
    expect(replacement).not.toBe(authorization);
    expect((await request("/v1/settings", { headers: { authorization } })).status).toBe(401);
    expect((await put(replacement, "new backup")).status).toBe(200);
  });

  test("CORS covers preflight and failure responses without reflecting arbitrary origins", async () => {
    const headers = { origin: "https://discord.com", "access-control-request-method": "PUT" };
    const preflight = await request("/v1/settings", { method: "OPTIONS", headers });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(headers.origin);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    const failure = await request("/v1/settings", { headers });
    expect(failure.status).toBe(401);
    expect(failure.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(failure.headers.get("cache-control")).toBe("no-store");
    const foreign = await request("/v1", { headers: { origin: "https://evil.example" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("keeps metrics opt-in and unknown routes predictable", async () => {
    const metrics = await request("/metrics");
    expect(metrics.status).toBe(404);
    expect(await metrics.json()).toEqual({ error: "Metrics are not enabled" });
    const response = await request("/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  test("exposes the registered-account gauge when metrics are enabled", async () => {
    const local = await createHarness({ PROMETHEUS: "true" });
    try {
      const empty = await local.request("/metrics");
      expect(empty.status).toBe(200);
      expect(empty.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
      expect(await empty.text()).toBe(
        [
          "# HELP vencord_accounts_registered The total number of accounts registered",
          "# TYPE vencord_accounts_registered gauge",
          "vencord_accounts_registered 0",
          "",
        ].join("\n"),
      );

      expect((await local.request("/v1/oauth/callback?code=valid")).status).toBe(200);
      const registered = await local.request("/metrics");
      expect(await registered.text()).toContain("vencord_accounts_registered 1\n");
    } finally {
      await local.worker.dispose();
    }
  });
});
