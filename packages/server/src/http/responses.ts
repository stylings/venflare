const allowedOrigins = new Set([
  "https://discord.com",
  "https://ptb.discord.com",
  "https://canary.discord.com",
  "https://discordapp.com",
  "https://ptb.discordapp.com",
  "https://canary.discordapp.com",
]);

const allowedMethods = ["GET", "HEAD", "PUT", "DELETE"];

export const toResponse = (value: unknown): Response => {
  if (value instanceof Response) return value;
  if (value === undefined) return new Response(null, { status: 204 });
  return Response.json(value);
};

export const preflight = (request: Request): Response | undefined => {
  if (request.method !== "OPTIONS") return undefined;
  const requested = request.headers.get("access-control-request-method");
  if (requested && !allowedMethods.includes(requested)) {
    return new Response(null, { status: 405 });
  }
  return new Response(null, { status: 204 });
};

export const finalizeResponse = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.append("vary", "Origin");
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", "ETag");
    if (request.method === "OPTIONS") {
      headers.set("access-control-allow-methods", [...allowedMethods, "OPTIONS"].join(", "));
      headers.set("access-control-allow-headers", "Authorization, Content-Type, If-None-Match");
      headers.append("vary", "Access-Control-Request-Method, Access-Control-Request-Headers");
    }
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
