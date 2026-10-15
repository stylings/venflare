import { Layer, Redacted } from "effect";

import { AccountStore, type AccountStoreService } from "#core/accounts/store";
import { AppConfig, type Configuration } from "#core/config";
import { createSecret } from "#core/accounts/crypto";
import type { Account } from "#core/accounts/model";
import { DiscordClient, type DiscordClientService } from "#core/oauth/discord";
import { SettingsStore, type SettingsStoreService } from "#core/settings/store";
import { Effect } from "effect";

export type Services = AppConfig | AccountStore | SettingsStore | DiscordClient;

export const userId = "123456789012345678";
export const generationId = "d2406d84-17cd-4362-b0a1-c78509726193";
export const secret = await createSecret("s".repeat(128), generationId);
export const authorization = btoa(`${secret}:${userId}`);

export const environment = {
  DISCORD_CLIENT_ID: "987654321098765432",
  DISCORD_CLIENT_SECRET: "discord-test-secret",
  DISCORD_REDIRECT_URI: "https://cloud.example.com/v1/oauth/callback",
  SOURCE_URL: "https://github.com/example/vencloud-worker",
  PEPPER_SECRETS: "s".repeat(128),
  PEPPER_SETTINGS: "b".repeat(128),
};

export const configuration: Configuration = {
  clientId: environment.DISCORD_CLIENT_ID,
  clientSecret: Redacted.make(environment.DISCORD_CLIENT_SECRET),
  redirectUri: environment.DISCORD_REDIRECT_URI,
  sourceUrl: environment.SOURCE_URL,
  rootRedirect: environment.SOURCE_URL,
  secretsPepper: Redacted.make(environment.PEPPER_SECRETS),
  settingsPepper: Redacted.make(environment.PEPPER_SETTINGS),
  sizeLimit: 32_000_000,
  allowedUsers: new Set(),
  prometheus: false,
};

export const account = (overrides: Partial<Account> = {}): Account => ({
  key: "account-key",
  id: generationId,
  settingsKey: "settings-key",
  objectKey: null,
  written: 0,
  settingsEpoch: 0,
  ...overrides,
});

export const accountStore = (
  overrides: Partial<AccountStoreService> = {},
): AccountStoreService => ({
  find: () => Effect.succeed(account()),
  getOrCreate: () => Effect.succeed(account()),
  stageUpload: () => Effect.succeed(true),
  publish: () => Effect.succeed(1000),
  deleteSettings: () => Effect.void,
  deleteAccount: () => Effect.void,
  claimGarbage: () => Effect.succeed([]),
  forgetGarbage: () => Effect.void,
  countAccounts: () => Effect.succeed(1),
  ...overrides,
});

export const settingsStore = (
  overrides: Partial<SettingsStoreService> = {},
): SettingsStoreService => ({
  get: () => Effect.succeed(undefined),
  put: () => Effect.void,
  delete: () => Effect.void,
  ...overrides,
});

export const testLayer = (
  options: {
    accounts?: AccountStoreService;
    settings?: SettingsStoreService;
    discord?: DiscordClientService;
    config?: Partial<Configuration>;
  } = {},
) =>
  Layer.mergeAll(
    Layer.succeed(AppConfig, { ...configuration, ...options.config }),
    Layer.succeed(AccountStore, accountStore(options.accounts)),
    Layer.succeed(SettingsStore, settingsStore(options.settings)),
    Layer.succeed(DiscordClient, options.discord ?? { identify: () => Effect.succeed(userId) }),
  );
