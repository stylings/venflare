import { Elysia } from "elysia";

import { deleteSettings, readSettings, writeSettings } from "@vencloud/core/settings/operations";
import { respond } from "#server/runtime/index";

export const settingsRoutes = new Elysia({ prefix: "/v1/settings" })
  .head("/", ({ request }) =>
    respond(
      "Settings.head",
      readSettings(request.headers.get("authorization"), { headOnly: true }),
    ),
  )
  .get("/", ({ request }) =>
    respond(
      "Settings.get",
      readSettings(request.headers.get("authorization"), {
        ifNoneMatch: request.headers.get("if-none-match"),
      }),
    ),
  )
  .put("/", { parse: "none" }, ({ request }) => respond("Settings.put", writeSettings(request)))
  .delete("/", ({ request }) =>
    respond("Settings.delete", deleteSettings(request.headers.get("authorization"))),
  );
