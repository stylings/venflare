import { Clock, Effect } from "effect";

import { AccountStore } from "#core/accounts/store";
import { SettingsStore } from "#core/settings/store";

export const removeCurrentObject = Effect.fn("Settings.removeCurrentObject")(function* (
  key: string | null,
) {
  if (!key) return;
  const store = yield* SettingsStore;
  yield* store.delete([key]).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        console.error({ event: "storage.cleanup_failed", operation: "delete settings" });
      }),
    ),
  );
});

export const collectGarbage = Effect.fn("Settings.collectGarbage")(function* () {
  const accounts = yield* AccountStore;
  const settings = yield* SettingsStore;
  const now = yield* Clock.currentTimeMillis;
  let deleted = 0;

  for (let batch = 0; batch < 20; batch++) {
    const garbage = yield* accounts.claimGarbage(now);
    if (garbage.length === 0) break;
    const keys = garbage.map((upload) => upload.key);
    yield* settings.delete(keys);
    yield* accounts.forgetGarbage(keys, now);
    deleted += keys.length;
  }
  return { deleted };
});
