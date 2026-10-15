import { Effect } from "effect";
import { Elysia } from "elysia";

import { deleteAccount } from "@vencloud/core/accounts/delete";
import { AppConfig } from "@vencloud/core/config";
import { respond } from "#server/runtime/index";

export const rootRoutes = new Elysia()
  .get("/", () =>
    respond(
      "Root.redirect",
      Effect.gen(function* () {
        const config = yield* AppConfig;
        return config.rootRedirect
          ? Response.redirect(config.rootRedirect, 303)
          : Response.json({ ping: "pong" });
      }),
    ),
  )
  .get("/v1", () =>
    respond(
      "Root.health",
      Effect.gen(function* () {
        const config = yield* AppConfig;
        return Response.json(
          { ping: "pong" },
          {
            headers: config.sourceUrl ? { Link: `<${config.sourceUrl}>; rel="source"` } : {},
          },
        );
      }),
    ),
  )
  .delete("/v1", ({ request }) =>
    respond("Account.delete", deleteAccount(request.headers.get("authorization"))),
  );
