import { Effect, Layer, Redacted } from "effect";
import * as v from "valibot";

import { AppConfig } from "@vencloud/core/config";
import { DiscordError, RequestRejected } from "@vencloud/core/errors";
import { DiscordClient } from "@vencloud/core/oauth/discord";

const tokenSchema = v.object({ access_token: v.pipe(v.string(), v.minLength(1)) });
const userSchema = v.object({ id: v.pipe(v.string(), v.regex(/^\d+$/)) });

export const discordClientLayer = (
  fetcher: (url: string, options?: RequestInit) => Promise<Response> = fetch,
) =>
  Layer.effect(
    DiscordClient,
    Effect.gen(function* () {
      const config = yield* AppConfig;

      return DiscordClient.of({
        identify: Effect.fn("DiscordClient.identify")((code) =>
          Effect.tryPromise({
            try: async (signal) => {
              const response = await fetcher("https://discord.com/api/oauth2/token", {
                method: "POST",
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  client_id: config.clientId,
                  client_secret: Redacted.value(config.clientSecret),
                  grant_type: "authorization_code",
                  code,
                  redirect_uri: config.redirectUri,
                  scope: "identify",
                }),
              });

              if (!response.ok) {
                await response.body?.cancel();
                if (response.status === 400 || response.status === 401) {
                  throw new RequestRejected({ status: 400, message: "Invalid code" });
                }
                throw new Error(`Discord token exchange returned ${response.status}`);
              }

              const token = v.parse(tokenSchema, await response.json());
              const userResponse = await fetcher("https://discord.com/api/users/@me", {
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                headers: { authorization: `Bearer ${token.access_token}` },
              });

              if (!userResponse.ok) {
                await userResponse.body?.cancel();
                throw new Error(`Discord identification returned ${userResponse.status}`);
              }
              return v.parse(userSchema, await userResponse.json()).id;
            },
            catch: (cause) =>
              cause instanceof RequestRejected
                ? cause
                : new DiscordError({ operation: "identify Discord user", cause }),
          }),
        ),
      });
    }),
  );
