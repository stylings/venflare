import { Elysia } from "elysia";

import { deleteSettings, readSettings, writeSettings } from "@vencloud/core/settings/operations";
import { respond } from "#server/runtime/index";

export const settingsRoutes = new Elysia()
  .head("/v1/settings", ({ request }) =>
    respond(
      "Settings.head",
      readSettings(request.headers.get("authorization"), null, true),
      (value) => value,
    ),
  )
  .get("/v1/settings", ({ request }) =>
    respond(
      "Settings.get",
      readSettings(
        request.headers.get("authorization"),
        request.headers.get("if-none-match"),
        false,
      ),
      (value) => value,
    ),
  )
  .put("/v1/settings", { parse: "none" }, ({ request }) =>
    respond("Settings.put", writeSettings(request)),
  )
  .delete("/v1/settings", ({ request }) =>
    respond(
      "Settings.delete",
      deleteSettings(request.headers.get("authorization")),
      () => new Response(null, { status: 204 }),
    ),
  );
