import { Clock, Effect } from "effect";

import { authenticate } from "#core/accounts/auth";
import { AccountStore } from "#core/accounts/store";
import { AppConfig } from "#core/config";
import { RequestRejected } from "#core/errors";
import { removeCurrentObject } from "#core/settings/cleanup";
import { SettingsStore } from "#core/settings/store";

export const readSettings = Effect.fn("Settings.read")(function* (
  authorization: string | null,
  ifNoneMatch: string | null,
  head: boolean,
) {
  const account = yield* authenticate(authorization);
  if (!account.objectKey) return new Response(null, { status: 404 });

  const headers = { ETag: String(account.written) };
  if (head) return new Response(null, { status: 204, headers });
  if (ifNoneMatch === String(account.written)) return new Response(null, { status: 304 });

  const store = yield* SettingsStore;
  const settings = yield* store.get(account.objectKey);
  if (!settings) return new Response(null, { status: 404 });
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

  yield* settings.put(objectKey, request.body, config.sizeLimit);
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
  const account = yield* authenticate(authorization, true);
  const accounts = yield* AccountStore;
  yield* accounts.deleteSettings(account);
  yield* removeCurrentObject(account.objectKey);
});
