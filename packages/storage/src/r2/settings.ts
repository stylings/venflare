import { Effect, Layer } from "effect";

import { RequestRejected, StorageError } from "@vencloud/core/errors";
import { SettingsStore } from "@vencloud/core/settings/store";

const partSize = 5 * 1024 * 1024;

async function* readParts(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) {
    yield new Uint8Array(0);
    return;
  }

  const reader = body.getReader();
  let completed = false;
  let total = 0;
  let buffer = new Uint8Array(partSize);
  let used = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        throw new RequestRejected({ status: 413, message: "Settings are too large" });
      }

      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const length = Math.min(partSize - used, chunk.value.byteLength - offset);
        buffer.set(chunk.value.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        if (used === partSize) {
          yield buffer;
          buffer = new Uint8Array(partSize);
          used = 0;
        }
      }
    }
    if (used > 0 || total === 0) yield buffer.subarray(0, used);
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const writeSettings = async (
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<void> => {
  let multipart: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];

  try {
    for await (const part of readParts(body, limit)) {
      if (!multipart && part.byteLength < partSize) {
        await bucket.put(key, part, { httpMetadata: { contentType: "application/octet-stream" } });
        return;
      }
      multipart ??= await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      parts.push(await multipart.uploadPart(parts.length + 1, part));
    }
    if (multipart) await multipart.complete(parts);
  } catch (error) {
    if (multipart) {
      try {
        await multipart.abort();
      } catch {
        console.error({ event: "storage.cleanup_failed", operation: "abort multipart upload" });
      }
    }
    throw error;
  }
};

export const settingsStoreLayer = (bucket: R2Bucket) =>
  Layer.sync(SettingsStore, () =>
    SettingsStore.of({
      get: Effect.fn("SettingsStore.get")((key) =>
        Effect.tryPromise({
          try: async () => {
            const object = await bucket.get(key);
            return object ? { body: object.body, size: object.size } : undefined;
          },
          catch: (cause) => new StorageError({ operation: "read settings", cause }),
        }),
      ),
      put: Effect.fn("SettingsStore.put")((key, body, limit) =>
        Effect.tryPromise({
          try: () => writeSettings(bucket, key, body, limit),
          catch: (cause) =>
            cause instanceof RequestRejected
              ? cause
              : new StorageError({ operation: "write settings", cause }),
        }),
      ),
      delete: Effect.fn("SettingsStore.delete")((keys) =>
        Effect.tryPromise({
          try: async () => {
            if (keys.length > 0) await bucket.delete([...keys]);
          },
          catch: (cause) => new StorageError({ operation: "delete settings", cause }),
        }),
      ),
    }),
  );
