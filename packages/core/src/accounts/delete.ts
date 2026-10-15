import { Effect } from "effect";

import { authenticate } from "#core/accounts/auth";
import { AccountStore } from "#core/accounts/store";
import { removeCurrentObject } from "#core/settings/cleanup";

export const deleteAccount = Effect.fn("Account.delete")(function* (authorization: string | null) {
  const account = yield* authenticate(authorization, { allowRemovedUser: true });
  const accounts = yield* AccountStore;
  yield* accounts.deleteAccount(account);
  yield* removeCurrentObject(account.objectKey);
});
