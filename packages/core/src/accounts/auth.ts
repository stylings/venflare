import { Effect, Redacted } from "effect";

import { decodeAuthorization, storageKey, verifySecret } from "#core/accounts/crypto";
import { AccountStore } from "#core/accounts/store";
import { AppConfig } from "#core/config";
import { RequestRejected } from "#core/errors";

export const authenticate = Effect.fn("Auth.authenticate")(function* (
  authorization: string | null,
  options: { readonly allowRemovedUser?: boolean } = {},
) {
  if (!authorization) {
    return yield* new RequestRejected({ status: 401, message: "Missing authorization" });
  }
  const token = decodeAuthorization(authorization);
  if (!token) {
    return yield* new RequestRejected({ status: 401, message: "Invalid authorization" });
  }

  const config = yield* AppConfig;
  const store = yield* AccountStore;
  const key = yield* Effect.promise(() =>
    storageKey(Redacted.value(config.secretsPepper), token.userId, "account"),
  );
  const account = yield* store.find(key);
  if (
    !account ||
    !(yield* Effect.promise(() =>
      verifySecret(Redacted.value(config.secretsPepper), account.id, token.secret),
    ))
  ) {
    return yield* new RequestRejected({ status: 401, message: "Invalid authorization" });
  }

  if (
    !options.allowRemovedUser &&
    config.allowedUsers.size > 0 &&
    !config.allowedUsers.has(token.userId)
  ) {
    return yield* new RequestRejected({ status: 403, message: "User is not whitelisted" });
  }
  return { ...account, userId: token.userId };
});
