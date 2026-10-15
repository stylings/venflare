import { Effect } from "effect";
import { Elysia } from "elysia";

import { deleteAccount } from "@vencloud/core/accounts/delete";
import { AccountStore } from "@vencloud/core/accounts/store";
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
  )
  .get("/metrics", () =>
    respond(
      "Metrics.accounts",
      Effect.gen(function* () {
        const config = yield* AppConfig;
        if (!config.prometheus) return new Response(null, { status: 404 });
        const store = yield* AccountStore;
        const count = yield* store.countAccounts();
        return new Response(
          [
            "# HELP vencord_accounts_registered The total number of accounts registered",
            "# TYPE vencord_accounts_registered gauge",
            `vencord_accounts_registered ${count}`,
            "",
          ].join("\n"),
          { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } },
        );
      }),
    ),
  );
