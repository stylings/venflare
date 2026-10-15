import { Effect } from "effect";
import { Elysia, NotFound, ParseError, ValidationError } from "elysia";

import { collectGarbage } from "@vencloud/core/settings/cleanup";
import { finalizeResponse, preflight } from "#server/http/responses";
import { instrumentRequest } from "#server/instrumentation/index";
import { oauthRoutes } from "#server/routes/oauth";
import { rootRoutes } from "#server/routes/root";
import { settingsRoutes } from "#server/routes/settings";
import { applicationLayer, withRuntime } from "#server/runtime/index";

export const app = new Elysia()
  .onError(NotFound, () => Response.json({ error: "Not found" }, { status: 404 }))
  .onError(ValidationError, () => Response.json({ error: "Invalid request" }, { status: 400 }))
  .onError(ParseError, () => Response.json({ error: "Invalid request" }, { status: 400 }))
  .onError(() => {
    console.error({ event: "request.failed", error: "UnhandledError" });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  })
  .use(rootRoutes)
  .use(oauthRoutes)
  .use(settingsRoutes)
  .compile();

export default {
  fetch: (request: Request, env: Readonly<Record<string, unknown>>): Promise<Response> =>
    instrumentRequest(request, async () => {
      let response: Response;
      try {
        response = preflight(request) ?? (await withRuntime(env, () => app.fetch(request)));
      } catch {
        console.error({ event: "request.failed", error: "RuntimeError" });
        response = Response.json({ error: "Internal server error" }, { status: 500 });
      }
      return finalizeResponse(request, response);
    }),

  scheduled: (
    _event: ScheduledController,
    env: Readonly<Record<string, unknown>>,
    context: ExecutionContext,
  ): void => {
    context.waitUntil(
      collectGarbage().pipe(
        Effect.provide(applicationLayer(env)),
        Effect.match({
          onFailure: (error) => {
            console.error({ event: "cleanup.failed", error: error._tag });
            throw new Error("Settings cleanup failed");
          },
          onSuccess: (result) => console.log({ event: "cleanup.completed", ...result }),
        }),
        Effect.runPromise,
      ),
    );
  },
};
