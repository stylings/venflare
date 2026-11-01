import { Effect, Layer } from "effect";

import { RequestRejected, StorageError } from "@vencloud/core/errors";
import { encryptedPartSize } from "@vencloud/core/settings/crypto";
import { SettingsStore } from "@vencloud/core/settings/store";

const writeSettings = async (
  bucket: R2Bucket,
  key: string,
  encryptedParts: AsyncIterable<Uint8Array<ArrayBuffer>>,
): Promise<void> => {
  let upload: R2MultipartUpload | undefined;
  const uploadedParts: R2UploadedPart[] = [];

  try {
    for await (const part of encryptedParts) {
      if (!upload && part.byteLength < encryptedPartSize) {
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
      } catch (cause) {
        console.error({
          event: "storage.cleanup_failed",
          operation: "abort multipart upload",
          cause,
        });
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
      put: Effect.fn("SettingsStore.put")((key, encryptedParts) =>
        Effect.tryPromise({
          try: () => writeSettings(bucket, key, encryptedParts),
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
