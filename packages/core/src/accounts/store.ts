import { Context, Effect } from "effect";

import type { Account } from "#core/accounts/model";
import type { DatabaseError } from "#core/errors";

export interface AccountStoreService {
  readonly find: (key: string) => Effect.Effect<Account | undefined, DatabaseError>;
  readonly getOrCreate: (input: {
    key: string;
    settingsKey: string;
  }) => Effect.Effect<Account, DatabaseError>;
  readonly stageUpload: (
    account: Account,
    objectKey: string,
    now: number,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly publish: (
    account: Account,
    objectKey: string,
    now: number,
  ) => Effect.Effect<number | undefined, DatabaseError>;
  readonly deleteSettings: (account: Account) => Effect.Effect<void, DatabaseError>;
  readonly deleteAccount: (account: Account) => Effect.Effect<void, DatabaseError>;
  readonly claimGarbage: (
    now: number,
  ) => Effect.Effect<ReadonlyArray<{ key: string; claimedAt: number }>, DatabaseError>;
  readonly forgetGarbage: (
    keys: ReadonlyArray<string>,
    now: number,
  ) => Effect.Effect<void, DatabaseError>;
  readonly countAccounts: () => Effect.Effect<number, DatabaseError>;
}

export class AccountStore extends Context.Service<AccountStore, AccountStoreService>()(
  "vencloud/AccountStore",
) {}
