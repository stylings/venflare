import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  key: text("key").primaryKey(),
  id: text("id").notNull().unique(),
  settingsKey: text("settings_key").notNull(),
  objectKey: text("object_key"),
  written: integer("written").notNull().default(0),
  settingsEpoch: integer("settings_epoch").notNull().default(0),
});

export const uploads = sqliteTable(
  "uploads",
  {
    key: text("key").primaryKey(),
    accountId: text("account_id").notNull(),
    createdAt: integer("created_at").notNull(),
    claimedAt: integer("claimed_at"),
    checkedAt: integer("checked_at"),
  },
  (table) => [index("uploads_created_at_idx").on(table.createdAt)],
);
