import { Clock, Effect, Redacted } from "effect";

import { authenticate } from "#core/accounts/auth";
import { AccountStore } from "#core/accounts/store";
import { AppConfig } from "#core/config";
import { RequestRejected } from "#core/errors";
import { removeCurrentObject } from "#core/settings/cleanup";
import { decryptSettings, encryptSettings } from "#core/settings/crypto";
import { SettingsStore } from "#core/settings/store";

interface ReadSettingsOptions {
  readonly headOnly?: boolean;
  readonly ifNoneMatch?: string | null;
}

export const readSettings = Effect.fn("Settings.read")(function* (
  authorization: string | null,
  options: ReadSettingsOptions = {},
) {
  const account = yield* authenticate(authorization);
  const objectKey = account.objectKey;
  if (!objectKey) return new Response(null, { status: 404 });

  const etag = String(account.written);
  const headers = { ETag: etag };
  if (options.headOnly) return new Response(null, { status: 204, headers });
  if (options.ifNoneMatch === etag) return new Response(null, { status: 304 });

  const config = yield* AppConfig;
  const store = yield* SettingsStore;
  const stored = yield* store.get(objectKey);
  if (!stored) return new Response(null, { status: 404 });
  const settings = yield* decryptSettings({
    pepper: Redacted.value(config.settingsPepper),
    userId: account.userId,
    accountId: account.id,
    objectKey,
    stored,
  });
  return new Response(settings.body, {
    headers: {
      ...headers,
      "content-type": "application/octet-stream",
      "content-length": String(settings.size),
    },
  });
});

export const writeSettings = Effect.fn("Settings.write")(function* (request: Request) {
  const account = yield* authenticate(request.headers.get("authorization"));
  const config = yield* AppConfig;
  if (request.headers.get("content-type") !== "application/octet-stream") {
    return yield* new RequestRejected({
      status: 415,
      message: "Content type must be application/octet-stream",
    });
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > config.sizeLimit)) {
    return yield* new RequestRejected({ status: 413, message: "Settings are too large" });
  }

  const accounts = yield* AccountStore;
  const settings = yield* SettingsStore;
  const objectKey = `settings/${account.settingsKey}/${crypto.randomUUID()}`;
  const staged = yield* accounts.stageUpload(account, objectKey, yield* Clock.currentTimeMillis);
  if (!staged)
    return yield* new RequestRejected({ status: 409, message: "Account changed during upload" });

  yield* settings.put(
    objectKey,
    encryptSettings({
      pepper: Redacted.value(config.settingsPepper),
      userId: account.userId,
      accountId: account.id,
      objectKey,
      body: request.body,
      sizeLimit: config.sizeLimit,
    }),
  );
  const written = yield* accounts.publish(account, objectKey, yield* Clock.currentTimeMillis);
  if (written === undefined) {
    yield* settings.delete([objectKey]).pipe(Effect.catch(() => Effect.void));
    return yield* new RequestRejected({ status: 409, message: "Account changed during upload" });
  }
  return { written };
});

export const deleteSettings = Effect.fn("Settings.delete")(function* (
  authorization: string | null,
) {
  const account = yield* authenticate(authorization, { allowRemovedUser: true });
  const accounts = yield* AccountStore;
  yield* accounts.deleteSettings(account);
  yield* removeCurrentObject(account.objectKey);
});
