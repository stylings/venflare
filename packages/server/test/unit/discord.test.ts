import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { AppConfig } from "@vencloud/core/config";
import { DiscordClient } from "@vencloud/core/oauth/discord";
import { discordClientLayer } from "#server/discord/client";
import { configuration, userId } from "../../../core/test/support";

const identify = (fetcher: Parameters<typeof discordClientLayer>[0]) =>
  DiscordClient.pipe(
    Effect.flatMap((client) => client.identify("code")),
    Effect.provide(
      discordClientLayer(fetcher).pipe(Layer.provide(Layer.succeed(AppConfig, configuration))),
    ),
    Effect.result,
    Effect.runPromise,
  );

describe("Discord OAuth", () => {
  test("exchanges a code and requests the user with the access token", async () => {
    const urls: string[] = [];
    const result = await identify(async (input, options) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/oauth2/token")) {
        expect(options?.method).toBe("POST");
        const body = new URLSearchParams(String(options?.body));
        expect(body.get("client_id")).toBe(configuration.clientId);
        expect(body.get("redirect_uri")).toBe(configuration.redirectUri);
        expect(body.get("code")).toBe("code");
        return Response.json({ access_token: "access-token" });
      }
      expect(options?.headers).toEqual({ authorization: "Bearer access-token" });
      return Response.json({ id: userId });
    });
    expect(result).toMatchObject({ _tag: "Success", success: userId });
    expect(urls).toEqual([
      "https://discord.com/api/oauth2/token",
      "https://discord.com/api/users/@me",
    ]);
  });

  test("rejects a single-use code without retrying the exchange", async () => {
    let attempts = 0;
    const result = await identify(async () => {
      attempts++;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "RequestRejected", status: 400 },
    });
    expect(attempts).toBe(1);
  });

  test.each([null, {}, { access_token: "" }])(
    "rejects malformed token responses: %j",
    async (body) => {
      const result = await identify(async () => Response.json(body));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DiscordError" } });
    },
  );
});
