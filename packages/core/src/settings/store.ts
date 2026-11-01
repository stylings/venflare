import { Context, Effect } from "effect";

import type { RequestRejected, StorageError } from "#core/errors";

export interface StoredSettings {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface SettingsStoreService {
  readonly get: (key: string) => Effect.Effect<StoredSettings | undefined, StorageError>;
  readonly put: (
    key: string,
    encryptedParts: AsyncIterable<Uint8Array<ArrayBuffer>>,
  ) => Effect.Effect<void, StorageError | RequestRejected>;
  readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void, StorageError>;
}

export class SettingsStore extends Context.Service<SettingsStore, SettingsStoreService>()(
  "vencloud/SettingsStore",
) {}
