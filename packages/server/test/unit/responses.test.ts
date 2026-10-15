import { describe, expect, test } from "bun:test";

import { finalizeResponse, preflight, toResponse } from "#server/http/responses";

describe("response encoding", () => {
  test("preserves explicit responses and their bodies", async () => {
    const response = new Response("settings", {
      status: 200,
      headers: { "content-type": "application/octet-stream", etag: "1234" },
    });

    expect(toResponse(response)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(response.headers.get("etag")).toBe("1234");
    expect(await response.text()).toBe("settings");
  });

  test("encodes completed operations without a value as 204", async () => {
    const response = toResponse(undefined);

    expect(response.status).toBe(204);
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
  });

  test.each([
    { value: null },
    { value: false },
    { value: 0 },
    { value: "settings" },
    { value: { written: 1234 } },
  ])("encodes ordinary values as JSON: %j", async ({ value }) => {
    const response = toResponse(value);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(await response.json()).toEqual(value);
  });
});

describe("CORS preflight", () => {
  test.each(["GET", "HEAD", "PUT", "DELETE"])("allows %s and advertises it", (method) => {
    const request = new Request("https://cloud.example.com/v1/settings", {
      method: "OPTIONS",
      headers: {
        origin: "https://discord.com",
        "access-control-request-method": method,
      },
    });

    expect(preflight(request)?.status).toBe(204);
    const response = finalizeResponse(request, new Response(null, { status: 204 }));
    expect(response.headers.get("access-control-allow-methods")?.split(", ")).toContain(method);
  });

  test.each(["POST", "PATCH", "TRACE"])("rejects unsupported methods: %s", (method) => {
    const request = new Request("https://cloud.example.com/v1/settings", {
      method: "OPTIONS",
      headers: { "access-control-request-method": method },
    });

    expect(preflight(request)?.status).toBe(405);
  });

  test("leaves ordinary requests to the router", () => {
    const request = new Request("https://cloud.example.com/v1/settings");

    expect(preflight(request)).toBeUndefined();
  });
});
