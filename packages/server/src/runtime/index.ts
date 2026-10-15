import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Layer } from "effect";
import { Resource } from "sst/resource";

import { AccountStore } from "@vencloud/core/accounts/store";
import { AppConfig, configurationLayer } from "@vencloud/core/config";
import type { ApplicationError } from "@vencloud/core/errors";
import { DiscordClient } from "@vencloud/core/oauth/discord";
import { SettingsStore } from "@vencloud/core/settings/store";
import { createDb } from "@vencloud/storage/db";
import { accountStoreLayer } from "@vencloud/storage/db/accounts";
import { settingsStoreLayer } from "@vencloud/storage/r2/settings";
import { discordClientLayer } from "#server/discord/client";
import { toResponse } from "#server/http/responses";
import { recordFailure, withSpan } from "#server/instrumentation/index";

export type Services = AppConfig | AccountStore | SettingsStore | DiscordClient;

export const applicationLayer = (environment: Readonly<Record<string, unknown>>) => {
  const configuration = configurationLayer({
    ...environment,
    DISCORD_CLIENT_ID: Resource.DiscordClientId.value,
    DISCORD_CLIENT_SECRET: Resource.DiscordClientSecret.value,
    DISCORD_REDIRECT_URI: Resource.DiscordRedirectUri.value,
    PEPPER_SECRETS: Resource.PepperSecrets.value,
    PEPPER_SETTINGS: Resource.PepperSettings.value,
  });
  return Layer.mergeAll(
    configuration,
    accountStoreLayer(createDb(Resource.VencloudData)),
    settingsStoreLayer(Resource.VencloudBackups),
    discordClientLayer().pipe(Layer.provide(configuration)),
  );
};

const runtimes = new AsyncLocalStorage<ReturnType<typeof applicationLayer>>();

export const withRuntime = <A>(environment: Readonly<Record<string, unknown>>, run: () => A): A =>
  runtimes.run(applicationLayer(environment), run);

const errorResponse = (error: ApplicationError): Response => {
  if (error._tag === "RequestRejected") {
    return Response.json({ error: error.message }, { status: error.status });
  }
  recordFailure(error);
  const message =
    error._tag === "DiscordError" ? "Failed to request user" : "Internal server error";
  return Response.json({ error: message }, { status: 500 });
};

export const respond = <A>(
  name: string,
  effect: Effect.Effect<A, ApplicationError, Services>,
): Promise<Response> => {
  const layer = runtimes.getStore();
  if (!layer) throw new Error("Request is missing its application runtime");
  return withSpan(name, () =>
    effect.pipe(
      Effect.provide(layer),
      Effect.match({ onFailure: errorResponse, onSuccess: toResponse }),
      Effect.runPromise,
    ),
  );
};
