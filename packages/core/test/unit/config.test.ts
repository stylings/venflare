import { expect, test } from "bun:test";
import { Effect } from "effect";

import { AppConfig, configurationLayer } from "#core/config";
import { environment } from "../support";

const read = (overrides: Record<string, unknown> = {}) =>
  AppConfig.pipe(
    Effect.provide(configurationLayer({ ...environment, ...overrides })),
    Effect.result,
    Effect.runPromise,
  );

test("configuration applies defaults and trims the allowlist", async () => {
  const config = await Effect.runPromise(
    AppConfig.pipe(
      Effect.provide(
        configurationLayer({
          ...environment,
          ALLOWED_USERS: "123, 456,",
        }),
      ),
    ),
  );
  expect(config.sizeLimit).toBe(32_000_000);
  expect([...config.allowedUsers]).toEqual(["123", "456"]);
  expect(config.rootRedirect).toBe(environment.SOURCE_URL);
});

test.each([undefined, ""])("source URL is optional: %s", async (sourceUrl) => {
  const config = await Effect.runPromise(
    AppConfig.pipe(Effect.provide(configurationLayer({ ...environment, SOURCE_URL: sourceUrl }))),
  );
  expect(config.sourceUrl).toBe("");
  expect(config.rootRedirect).toBe("");
});

test("root redirect can be configured without a source URL", async () => {
  const config = await Effect.runPromise(
    AppConfig.pipe(
      Effect.provide(
        configurationLayer({
          ...environment,
          SOURCE_URL: "",
          ROOT_REDIRECT: "https://example.com",
        }),
      ),
    ),
  );
  expect(config.rootRedirect).toBe("https://example.com");
});

test.each([
  { SIZE_LIMIT: "0" },
  { SIZE_LIMIT: "32000001" },
  { SIZE_LIMIT: "garbage" },
  { PEPPER_SECRETS: "short" },
  { DISCORD_CLIENT_SECRET: "" },
  { SOURCE_URL: "http://example.com" },
  { DISCORD_REDIRECT_URI: "invalid" },
  { ALLOWED_USERS: "not-a-user" },
])("rejects invalid configuration without echoing credentials: %j", async (overrides) => {
  const result = await read(overrides);
  expect(result._tag).toBe("Failure");
  expect(JSON.stringify(result)).not.toContain(environment.DISCORD_CLIENT_SECRET);
});
