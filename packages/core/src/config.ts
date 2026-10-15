import { Config, ConfigProvider, Context, Effect, Layer, Redacted } from "effect";

import { ConfigurationError } from "#core/errors";

export interface Configuration {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly redirectUri: string;
  readonly secretsPepper: Redacted.Redacted<string>;
  readonly settingsPepper: Redacted.Redacted<string>;
  readonly sizeLimit: number;
  readonly allowedUsers: ReadonlySet<string>;
  readonly sourceUrl: string;
  readonly rootRedirect: string;
  readonly prometheus: boolean;
}

export class AppConfig extends Context.Service<AppConfig, Configuration>()("vencloud/AppConfig") {}

const fields = Config.all({
  clientId: Config.NonEmptyString("DISCORD_CLIENT_ID"),
  clientSecret: Config.Redacted("DISCORD_CLIENT_SECRET"),
  redirectUri: Config.NonEmptyString("DISCORD_REDIRECT_URI"),
  secretsPepper: Config.Redacted("PEPPER_SECRETS"),
  settingsPepper: Config.Redacted("PEPPER_SETTINGS"),
  sizeLimit: Config.Int("SIZE_LIMIT").pipe(Config.withDefault(32_000_000)),
  allowedUsers: Config.String("ALLOWED_USERS").pipe(Config.withDefault("")),
  sourceUrl: Config.String("SOURCE_URL").pipe(Config.withDefault("")),
  rootRedirect: Config.String("ROOT_REDIRECT").pipe(Config.withDefault("")),
  prometheus: Config.Boolean("PROMETHEUS").pipe(Config.withDefault(false)),
});

const isHttps = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export const configurationLayer = (environment: Readonly<Record<string, unknown>>) =>
  Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const values = yield* fields.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        Effect.mapError(() => new ConfigurationError({ message: "Invalid server configuration" })),
      );

      if (
        !/^\d+$/.test(values.clientId) ||
        !isHttps(values.redirectUri) ||
        (values.sourceUrl !== "" && !isHttps(values.sourceUrl)) ||
        (values.rootRedirect !== "" && !isHttps(values.rootRedirect)) ||
        values.sizeLimit < 1 ||
        values.sizeLimit > 32_000_000 ||
        Redacted.value(values.clientSecret).length === 0 ||
        Redacted.value(values.secretsPepper).length < 64 ||
        Redacted.value(values.settingsPepper).length < 64
      ) {
        return yield* new ConfigurationError({ message: "Invalid server configuration" });
      }

      const users = values.allowedUsers
        .split(",")
        .map((user) => user.trim())
        .filter(Boolean);
      if (users.some((user) => !/^\d+$/.test(user))) {
        return yield* new ConfigurationError({ message: "ALLOWED_USERS must contain Discord IDs" });
      }

      return AppConfig.of({
        ...values,
        allowedUsers: new Set(users),
        rootRedirect: values.rootRedirect || values.sourceUrl,
      });
    }),
  );
