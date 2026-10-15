import { Effect, Layer } from "effect";

import { RequestRejected, StorageError } from "@vencloud/core/errors";
import { SettingsStore } from "@vencloud/core/settings/store";

// R2 requires at least 5 MiB per multipart part, except for the final part.
const multipartPartSize = 5 * 1024 * 1024;

async function* readUploadParts(body: ReadableStream<Uint8Array> | null, sizeLimit: number) {
  if (!body) {
    yield new Uint8Array(0);
    return;
  }

  const reader = body.getReader();
  let completed = false;
  let totalBytes = 0;
  let buffer = new Uint8Array(multipartPartSize);
  let bufferedBytes = 0;

  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      totalBytes += chunk.byteLength;
      if (totalBytes > sizeLimit) {
        throw new RequestRejected({ status: 413, message: "Settings are too large" });
      }

      let offset = 0;
      while (offset < chunk.byteLength) {
        const bytesToCopy = Math.min(multipartPartSize - bufferedBytes, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + bytesToCopy), bufferedBytes);
        bufferedBytes += bytesToCopy;
        offset += bytesToCopy;
        if (bufferedBytes === multipartPartSize) {
          yield buffer;
          // The consumer owns the yielded part; later chunks need a fresh buffer.
          buffer = new Uint8Array(multipartPartSize);
          bufferedBytes = 0;
        }
      }
    }
    if (bufferedBytes > 0 || totalBytes === 0) yield buffer.subarray(0, bufferedBytes);
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
  sizeLimit: number,
): Promise<void> => {
  let upload: R2MultipartUpload | undefined;
  const uploadedParts: R2UploadedPart[] = [];

  try {
    for await (const part of readUploadParts(body, sizeLimit)) {
      if (!upload && part.byteLength < multipartPartSize) {
        await bucket.put(key, part, { httpMetadata: { contentType: "application/octet-stream" } });
        return;
      }
      upload ??= await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      uploadedParts.push(await upload.uploadPart(uploadedParts.length + 1, part));
    }
    if (upload) await upload.complete(uploadedParts);
  } catch (error) {
    if (upload) {
      try {
        await upload.abort();
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
      put: Effect.fn("SettingsStore.put")((key, body, sizeLimit) =>
        Effect.tryPromise({
          try: () => writeSettings(bucket, key, body, sizeLimit),
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
