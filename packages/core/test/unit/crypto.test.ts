import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Effect } from "effect";

import { createSecret, decodeAuthorization, storageKey, verifySecret } from "#core/accounts/crypto";
import {
  decryptedSize,
  decryptSettings,
  encryptedPartSize,
  encryptSettings,
  type SettingsKeyInput,
} from "#core/settings/crypto";
import type { StoredSettings } from "#core/settings/store";

const userId = "123456789012345678";
const authPepper = "pepper";
const otherPepper = "other-pepper";
const generation = "generation";
const nextGeneration = "next-generation";

const hmac = (secret: string, value: string) =>
  createHmac("sha256", secret).update(value).digest("hex");

describe("Vencloud authorization", () => {
  test("decodes the existing client's raw base64 token", () => {
    expect(decodeAuthorization(btoa(`secret:${userId}`))).toEqual({ secret: "secret", userId });
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
    const key = await storageKey(authPepper, userId, "account");
    expect(key).toBe(hmac(authPepper, `vencloud:account:${userId}`));
    expect(key).not.toBe(await storageKey(authPepper, userId, "settings"));
    expect(key).not.toBe(await storageKey(otherPepper, userId, "account"));
    expect(key).not.toBe(await createSecret(authPepper, userId));
  });

  test("derives a stable token bound to the account generation", async () => {
    const secret = await createSecret(authPepper, generation);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(secret).toBe(hmac(authPepper, `vencloud:secret:${generation}`));
    expect(secret).toBe(await createSecret(authPepper, generation));
    expect(secret).not.toBe(await createSecret(authPepper, nextGeneration));
  });

  test("verifies tokens using the server key and account generation", async () => {
    const secret = await createSecret(authPepper, generation);
    expect(await verifySecret(authPepper, generation, secret)).toBe(true);
    for (const [key, value, candidate] of [
      [otherPepper, generation, secret],
      [authPepper, nextGeneration, secret],
      [authPepper, generation, "0".repeat(64)],
    ] as const) {
      expect(await verifySecret(key, value, candidate)).toBe(false);
    }
  });

  test.each(["", "not-hex", "0".repeat(63), "0".repeat(65), "g".repeat(64)])(
    "rejects malformed secrets: %s",
    async (secret) => {
      expect(await verifySecret(authPepper, generation, secret)).toBe(false);
    },
  );
});

const settingsPepper = "b".repeat(128);
const settingsObjectKey = "settings/settings-key/object-id";
const headerSize = 20;
const tagSize = 16;

const baseAccount = {
  id: "d2406d84-17cd-4362-b0a1-c78509726193",
  userId,
};

const keyInput: SettingsKeyInput = {
  pepper: settingsPepper,
  account: baseAccount,
  objectKey: settingsObjectKey,
};

const asStream = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes]).stream();

const storedBytes = (bytes: Uint8Array<ArrayBuffer>): StoredSettings => ({
  body: asStream(bytes),
  size: bytes.byteLength,
});

const storedStream = (body: ReadableStream<Uint8Array>, size: number): StoredSettings => ({
  body,
  size,
});

const collectParts = (
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
  overrides: Partial<SettingsKeyInput> = {},
  sizeLimit = 32_000_000,
): Promise<Uint8Array<ArrayBuffer>[]> =>
  Array.fromAsync(
    encryptSettings({
      ...keyInput,
      ...overrides,
      body: body instanceof Uint8Array ? asStream(body) : body,
      sizeLimit,
    }),
  );

const byteLength = (parts: ReadonlyArray<Uint8Array>): number =>
  parts.reduce((sum, part) => sum + part.byteLength, 0);

const joinParts = (parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const combined = new Uint8Array(byteLength(parts));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
};

const decryptToBytes = async (
  stored: StoredSettings,
  overrides: Partial<SettingsKeyInput> = {},
): Promise<Uint8Array<ArrayBuffer>> => {
  const decrypted = await Effect.runPromise(decryptSettings({ ...keyInput, ...overrides, stored }));
  const bytes = new Uint8Array(await new Response(decrypted.body).arrayBuffer());
  expect(bytes.byteLength).toBe(decrypted.size);
  return bytes;
};

const decryptBytes = (
  encrypted: Uint8Array<ArrayBuffer>,
  overrides: Partial<SettingsKeyInput> = {},
) => decryptToBytes(storedBytes(encrypted), overrides);

const decryptResult = (stored: StoredSettings, overrides: Partial<SettingsKeyInput> = {}) =>
  Effect.runPromise(Effect.result(decryptSettings({ ...keyInput, ...overrides, stored })));

const flip = (bytes: Uint8Array<ArrayBuffer>, offset: number): Uint8Array<ArrayBuffer> => {
  const copy = bytes.slice();
  copy[offset]! ^= 0xff;
  return copy;
};

describe("settings encryption", () => {
  test("encrypts empty, single-part, and multi-part streams with 5 MiB non-final parts", async () => {
    const singlePartMax = encryptedPartSize - headerSize - tagSize;
    const twoPartMax = 2 * encryptedPartSize - headerSize - 2 * tagSize;
    for (const length of [0, 17, singlePartMax, singlePartMax + 1, twoPartMax, twoPartMax + 1]) {
      const plaintext = new Uint8Array(length);
      if (length > 0) {
        plaintext[0] = 42;
        plaintext[length - 1] = 99;
      }

      const parts = await collectParts(plaintext);
      for (const part of parts.slice(0, -1)) {
        expect(part.byteLength).toBe(encryptedPartSize);
      }

      const combined = joinParts(parts);
      expect(decryptedSize(combined.byteLength)).toBe(length);
      expect(await decryptBytes(combined)).toEqual(plaintext);
    }
  });

  test("copies one-byte upload chunks before reading the next one", async () => {
    const plaintext = Uint8Array.from({ length: 128_000 }, (_, index) => index % 251);
    const chunk = new Uint8Array(1);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === plaintext.byteLength) {
            controller.close();
            return;
          }
          chunk[0] = plaintext[offset++]!;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );

    const parts = await collectParts(body, {}, plaintext.byteLength);
    expect(await decryptBytes(joinParts(parts))).toEqual(plaintext);
  });

  test("decrypts fragmented ciphertext across frame boundaries", async () => {
    const plaintext = new Uint8Array(encryptedPartSize + 17).fill(73);
    const encrypted = joinParts(await collectParts(plaintext));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === encrypted.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 4093, encrypted.byteLength);
        controller.enqueue(encrypted.subarray(offset, end));
        offset = end;
      },
    });

    expect(await decryptToBytes(storedStream(body, encrypted.byteLength))).toEqual(plaintext);
    expect(body.locked).toBe(false);
  });

  test("cancels pending ciphertext reads when the download is canceled", async () => {
    const parts = await collectParts(new Uint8Array(encryptedPartSize));
    const { promise: pendingRead, resolve: readStarted } = Promise.withResolvers<void>();
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(parts[0]!);
          controller.enqueue(parts[1]!.subarray(0, 1));
        },
        pull() {
          readStarted();
        },
        cancel(reason) {
          cancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const decrypted = await Effect.runPromise(
      decryptSettings({ ...keyInput, stored: storedStream(body, byteLength(parts)) }),
    );
    const reader = decrypted.body.getReader();
    await reader.read();
    await pendingRead;

    await reader.cancel("download canceled");
    expect(cancelReason).toBe("download canceled");
    expect(body.locked).toBe(false);
  });

  test("binds ciphertext to the pepper, user ID, account generation, and object key", async () => {
    const encrypted = joinParts(await collectParts(new Uint8Array([1, 2, 3, 4])));
    const otherUser = { ...baseAccount, userId: "999999999999999999" };
    const regenerated = { ...baseAccount, id: "00000000-0000-4000-8000-000000000000" };
    for (const overrides of [
      { pepper: "x".repeat(128) },
      { account: otherUser },
      { account: regenerated },
      { objectKey: "settings/settings-key/other-object" },
    ]) {
      const result = await decryptResult(storedBytes(encrypted), overrides);
      expect(result._tag).toBe("Failure");
    }
  });

  test("rejects corrupted headers, modified frames, and truncated multipart streams", async () => {
    const parts = await collectParts(new Uint8Array(2 * encryptedPartSize).fill(7));
    expect(parts).toHaveLength(3);
    const combined = joinParts(parts);

    const invalid = [
      new Uint8Array([1, 2, 3]),
      flip(combined, 0),
      flip(combined, headerSize),
      flip(combined, encryptedPartSize),
      flip(combined, combined.byteLength - 1),
      parts[0]!,
      joinParts(parts.slice(0, -1)),
    ];
    for (const bytes of invalid) {
      await expect(decryptBytes(bytes)).rejects.toThrow();
    }
  });

  test("rejects streams that exceed the size limit while encrypting", async () => {
    await expect(collectParts(new Uint8Array(11), {}, 10)).rejects.toMatchObject({
      _tag: "RequestRejected",
      status: 413,
    });
  });
});
