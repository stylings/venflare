import { AsyncLocalStorage } from "node:async_hooks";

interface RequestEvent {
  readonly method: string;
  readonly path: string;
  readonly rayId: string | null;
  operation?: string;
  error?: string;
}

const events = new AsyncLocalStorage<RequestEvent>();

export const recordFailure = (error: {
  readonly _tag: string;
  readonly operation?: string;
}): void => {
  const event = events.getStore();
  if (event) {
    event.error = error._tag;
    event.operation = error.operation;
  }
};

export const instrumentRequest = async (
  request: Request,
  handle: () => Promise<Response>,
): Promise<Response> => {
  const started = performance.now();
  const event: RequestEvent = {
    method: request.method,
    path: new URL(request.url).pathname,
    rayId: request.headers.get("cf-ray"),
  };

  return events.run(event, async () => {
    let status = 500;
    try {
      const response = await handle();
      status = response.status;
      return response;
    } finally {
      console.log({
        event: "request.completed",
        ...event,
        status,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    }
  });
};

export const withSpan = async <A>(name: string, run: () => Promise<A>): Promise<A> => {
  const platform = await import("cloudflare:workers").catch(() => undefined);
  return platform ? platform.tracing.enterSpan(name, run) : run();
};
