import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Effect } from "effect";

import { createSecret, decodeAuthorization, verifySecret, storageKey } from "#core/accounts/crypto";
import {
  decryptedSize,
  decryptSettings,
  encryptedPartSize,
  encryptSettings,
  type SettingsKeyInput,
} from "#core/settings/crypto";

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

const keyInput: SettingsKeyInput = {
  pepper: "b".repeat(128),
  userId: "123456789012345678",
  accountId: "d2406d84-17cd-4362-b0a1-c78509726193",
  objectKey: "settings/settings-key/object-id",
};

const collectParts = (
  body: Uint8Array<ArrayBuffer>,
  overrides: Partial<SettingsKeyInput> = {},
  sizeLimit = 32_000_000,
): Promise<Uint8Array<ArrayBuffer>[]> =>
  Array.fromAsync(
    encryptSettings({
      ...keyInput,
      ...overrides,
      body: new Blob([body]).stream(),
      sizeLimit,
    }),
  );

const joinParts = (parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
};

const decryptJoined = async (
  encrypted: Uint8Array<ArrayBuffer>,
  overrides: Partial<SettingsKeyInput> = {},
): Promise<Uint8Array<ArrayBuffer>> => {
  const decrypted = await Effect.runPromise(
    decryptSettings({
      ...keyInput,
      ...overrides,
      stored: { body: new Blob([encrypted]).stream(), size: encrypted.byteLength },
    }),
  );
  const bytes = new Uint8Array(await new Response(decrypted.body).arrayBuffer());
  expect(bytes.byteLength).toBe(decrypted.size);
  return bytes;
};

describe("settings encryption", () => {
  test("encrypts empty, single-part, and multi-part streams with 5 MiB non-final parts", async () => {
    const singlePartMax = encryptedPartSize - 36;
    const twoPartMax = 2 * encryptedPartSize - 52;
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
      expect(await decryptJoined(combined)).toEqual(plaintext);
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

    const parts = await Array.fromAsync(
      encryptSettings({ ...keyInput, body, sizeLimit: plaintext.byteLength }),
    );
    const decrypted = await decryptJoined(joinParts(parts));
    expect(decrypted.byteLength).toBe(plaintext.byteLength);
    expect(decrypted.every((byte, index) => byte === plaintext[index])).toBe(true);
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

    const decrypted = await Effect.runPromise(
      decryptSettings({ ...keyInput, stored: { body, size: encrypted.byteLength } }),
    );
    expect(new Uint8Array(await new Response(decrypted.body).arrayBuffer())).toEqual(plaintext);
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
      decryptSettings({
        ...keyInput,
        stored: { body, size: parts.reduce((sum, part) => sum + part.byteLength, 0) },
      }),
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
    for (const overrides of [
      { pepper: "x".repeat(128) },
      { userId: "999999999999999999" },
      { accountId: "00000000-0000-4000-8000-000000000000" },
      { objectKey: "settings/settings-key/other-object" },
    ]) {
      const result = await Effect.runPromise(
        Effect.result(
          decryptSettings({
            ...keyInput,
            ...overrides,
            stored: { body: new Blob([encrypted]).stream(), size: encrypted.byteLength },
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }
  });

  test("rejects corrupted headers, modified frames, and truncated multipart streams", async () => {
    const parts = await collectParts(new Uint8Array(2 * encryptedPartSize).fill(7));
    expect(parts).toHaveLength(3);
    const combined = joinParts(parts);

    const badMagic = combined.slice();
    badMagic[0]! ^= 0xff;
    const badCiphertext = combined.slice();
    badCiphertext[25]! ^= 0xff;
    const badSecondFrame = combined.slice();
    badSecondFrame[encryptedPartSize + 25]! ^= 0xff;
    const badFinalFrame = combined.slice();
    badFinalFrame[badFinalFrame.byteLength - 1]! ^= 0xff;

    for (const invalid of [
      new Uint8Array([1, 2, 3]),
      badMagic,
      badCiphertext,
      badSecondFrame,
      badFinalFrame,
      parts[0]!,
      joinParts(parts.slice(0, -1)),
    ]) {
      expect(decryptJoined(invalid)).rejects.toThrow();
    }
  });

  test("rejects streams that exceed the size limit while encrypting", () => {
    expect(collectParts(new Uint8Array(11), {}, 10)).rejects.toMatchObject({
      _tag: "RequestRejected",
      status: 413,
    });
  });
});
