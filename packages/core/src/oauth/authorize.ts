import { Effect, Redacted } from "effect";

import { createSecret, storageKey } from "#core/accounts/crypto";
import { AccountStore } from "#core/accounts/store";
import { AppConfig } from "#core/config";
import { RequestRejected } from "#core/errors";
import { DiscordClient } from "#core/oauth/discord";

export const authorize = Effect.fn("OAuth.authorize")(function* (code: string) {
  if (!code) return yield* new RequestRejected({ status: 400, message: "Missing code" });
  const config = yield* AppConfig;
  const discord = yield* DiscordClient;
  const accounts = yield* AccountStore;
  const userId = yield* discord.identify(code);

  if (config.allowedUsers.size > 0 && !config.allowedUsers.has(userId)) {
    return yield* new RequestRejected({ status: 403, message: "User is not whitelisted" });
  }
  const [key, settingsKey] = yield* Effect.promise(() =>
    Promise.all([
      storageKey(Redacted.value(config.secretsPepper), userId, "account"),
      storageKey(Redacted.value(config.settingsPepper), userId, "settings"),
    ]),
  );
  const account = yield* accounts.getOrCreate({ key, settingsKey });
  const secret = yield* Effect.promise(() =>
    createSecret(Redacted.value(config.secretsPepper), account.id),
  );
  return { secret };
});
