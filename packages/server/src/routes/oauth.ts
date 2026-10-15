import { Effect } from "effect";
import { Elysia } from "elysia";

import { AppConfig } from "@vencloud/core/config";
import { authorize } from "@vencloud/core/oauth/authorize";
import { respond } from "#server/runtime/index";

export const oauthRoutes = new Elysia({ prefix: "/v1/oauth" })
  .get("/settings", () =>
    respond(
      "OAuth.settings",
      Effect.gen(function* () {
        const config = yield* AppConfig;
        return { clientId: config.clientId, redirectUri: config.redirectUri };
      }),
    ),
  )
  .get("/callback", ({ request }) =>
    respond("OAuth.callback", authorize(new URL(request.url).searchParams.get("code") ?? "")),
  );
