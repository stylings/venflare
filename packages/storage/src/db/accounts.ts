import { and, eq, exists, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { AccountStore, type AccountStoreService } from "@vencloud/core/accounts/store";
import { DatabaseError } from "@vencloud/core/errors";
import type { Database } from "#storage/db/index";
import { accounts, uploads } from "#storage/db/schema";

const uploadLifetimeMs = 60 * 60 * 1000;
const garbageBatchSize = 80;

// Retain deletion records to catch uploads that finish after their objects were removed.
const tombstoneLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export const accountStoreLayer = (database: Database) =>
  Layer.sync(AccountStore, () => AccountStore.of(accountQueries(database)));

const query = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DatabaseError({ operation, cause }) });

export const accountQueries = (database: Database): AccountStoreService => ({
  find: Effect.fn("AccountStore.find")((key) =>
    query(
      "find account",
      async () => (await database.select().from(accounts).where(eq(accounts.key, key)).limit(1))[0],
    ),
  ),

  getOrCreate: Effect.fn("AccountStore.getOrCreate")((input) =>
    query("create account", async () => {
      const [account] = await database
        .insert(accounts)
        .values({ ...input, id: crypto.randomUUID() })
        // Concurrent logins must reuse the existing generation and its derived secret.
        .onConflictDoUpdate({ target: accounts.key, set: { key: sql`${accounts.key}` } })
        .returning();
      if (!account) throw new Error("Account insert returned no row");
      return account;
    }),
  ),

  stageUpload: Effect.fn("AccountStore.stageUpload")((account, objectKey, now) =>
    query("stage upload", async () => {
      const rows = await database
        .insert(uploads)
        .select(
          database
            .select({
              key: sql<string>`${objectKey}`.as("key"),
              accountId: accounts.id,
              createdAt: sql<number>`${now}`.as("created_at"),
              claimedAt: sql<null>`null`.as("claimed_at"),
              checkedAt: sql<null>`null`.as("checked_at"),
            })
            .from(accounts)
            .where(
              and(eq(accounts.id, account.id), eq(accounts.settingsEpoch, account.settingsEpoch)),
            ),
        )
        .returning({ key: uploads.key });
      return rows.length === 1;
    }),
  ),

  publish: Effect.fn("AccountStore.publish")((account, objectKey, now) =>
    query("publish settings", async () => {
      const pending = database
        .select({ key: uploads.key })
        .from(uploads)
        .where(
          and(
            eq(uploads.key, objectKey),
            eq(uploads.accountId, account.id),
            isNull(uploads.claimedAt),
          ),
        );
      const [updated] = await database
        .update(accounts)
        .set({
          objectKey,
          // ETags must increase even when uploads finish in the same millisecond.
          written: sql`max(${accounts.written} + 1, ${now})`,
        })
        // Deleting settings advances the epoch so a late upload cannot restore them.
        .where(
          and(
            eq(accounts.id, account.id),
            eq(accounts.settingsEpoch, account.settingsEpoch),
            exists(pending),
          ),
        )
        .returning({ written: accounts.written });
      return updated?.written;
    }),
  ),

  deleteSettings: Effect.fn("AccountStore.deleteSettings")((account) =>
    query("delete settings", async () => {
      await database
        .update(accounts)
        .set({
          objectKey: null,
          settingsEpoch: sql`${accounts.settingsEpoch} + 1`,
        })
        .where(eq(accounts.id, account.id));
    }),
  ),

  deleteAccount: Effect.fn("AccountStore.deleteAccount")((account) =>
    query("delete account", async () => {
      await database.delete(accounts).where(eq(accounts.id, account.id));
    }),
  ),

  claimGarbage: Effect.fn("AccountStore.claimGarbage")((now) =>
    query("claim expired uploads", async () => {
      const active = database
        .select({ key: accounts.key })
        .from(accounts)
        .where(eq(accounts.objectKey, uploads.key));
      const candidates = database
        .select({ key: uploads.key })
        .from(uploads)
        .where(
          and(
            lt(uploads.createdAt, now - uploadLifetimeMs),
            notExists(active),
            or(isNull(uploads.checkedAt), lt(uploads.checkedAt, now)),
          ),
        )
        .orderBy(sql`coalesce(${uploads.checkedAt}, 0)`, uploads.createdAt)
        .limit(garbageBatchSize);
      return database
        .update(uploads)
        .set({ claimedAt: sql`coalesce(${uploads.claimedAt}, ${now})`, checkedAt: now })
        .where(inArray(uploads.key, candidates))
        .returning({ key: uploads.key, claimedAt: sql<number>`${uploads.claimedAt}` });
    }),
  ),

  forgetGarbage: Effect.fn("AccountStore.forgetGarbage")((keys, now) =>
    query("prune deleted uploads", async () => {
      if (keys.length === 0) return;
      await database
        .delete(uploads)
        .where(
          and(inArray(uploads.key, [...keys]), lt(uploads.claimedAt, now - tombstoneLifetimeMs)),
        );
    }),
  ),

  countAccounts: Effect.fn("AccountStore.countAccounts")(() =>
    query("count accounts", async () => {
      const [row] = await database.select({ count: sql<number>`count(*)` }).from(accounts);
      return row?.count ?? 0;
    }),
  ),
});
