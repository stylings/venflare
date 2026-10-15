import { Effect } from "effect";
import { Elysia } from "elysia";

import { AccountStore } from "@vencloud/core/accounts/store";
import { AppConfig } from "@vencloud/core/config";
import { respond } from "#server/runtime/index";

export const metricsRoutes = new Elysia().get("/metrics", () =>
  respond(
    "Metrics.accounts",
    Effect.gen(function* () {
      const config = yield* AppConfig;
      if (!config.prometheus) {
        return Response.json({ error: "Metrics are not enabled" }, { status: 404 });
      }

      const accounts = yield* AccountStore;
      const count = yield* accounts.countAccounts();
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
