import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { authenticate } from "#core/accounts/auth";
import { deleteAccount } from "#core/accounts/delete";
import { DatabaseError, RequestRejected, StorageError } from "#core/errors";
import { authorize } from "#core/oauth/authorize";
import { collectGarbage } from "#core/settings/cleanup";
import { deleteSettings, readSettings, writeSettings } from "#core/settings/operations";
import type { Services } from "../support";
import {
  account,
  accountStore,
  authorization,
  secret,
  settingsStore,
  testLayer,
  userId,
} from "../support";

const run = <A, E>(
  program: Effect.Effect<A, E, Services>,
  options: Parameters<typeof testLayer>[0] = {},
) => program.pipe(Effect.provide(testLayer(options)), Effect.runPromise);

const upload = (headers: Record<string, string> = {}) =>
  new Request("https://cloud.example.com/v1/settings", {
    method: "PUT",
    headers: { authorization, "content-type": "application/octet-stream", ...headers },
    body: new Uint8Array([1, 2, 3]),
  });

describe("authentication", () => {
  test("distinguishes missing and malformed tokens", async () => {
    expect(await run(Effect.flip(authenticate(null)))).toMatchObject({
      status: 401,
      message: "Missing authorization",
    });
    expect(await run(Effect.flip(authenticate("bad")))).toMatchObject({
      status: 401,
      message: "Invalid authorization",
    });
  });

  test("rejects a wrong secret or an unknown account", async () => {
    expect(await run(Effect.flip(authenticate(btoa(`wrong:${userId}`))))).toMatchObject({
      status: 401,
    });
    expect(
      await run(Effect.flip(authenticate(authorization)), {
        accounts: accountStore({ find: () => Effect.succeed(undefined) }),
      }),
    ).toMatchObject({ status: 401 });
  });

  test("keeps deletion available to users removed from the allowlist", async () => {
    const options = { config: { allowedUsers: new Set(["999"]) } };
    expect(await run(Effect.flip(authenticate(authorization)), options)).toMatchObject({
      status: 403,
    });
    await run(deleteSettings(authorization), options);
    await run(deleteAccount(authorization), options);
  });

  test("does not disguise database failure as invalid credentials", async () => {
    const failure = new DatabaseError({ operation: "find", cause: new Error("offline") });
    expect(
      await run(Effect.flip(authenticate(authorization)), {
        accounts: accountStore({ find: () => Effect.fail(failure) }),
      }),
    ).toBe(failure);
  });
});

describe("OAuth", () => {
  test("derives the secret from the stored account generation", async () => {
    expect(await run(authorize("code"))).toEqual({ secret });
  });

  test("rejects missing codes and non-allowlisted Discord users", async () => {
    expect(await run(Effect.flip(authorize("")))).toMatchObject({
      status: 400,
      message: "Missing code",
    });
    expect(
      await run(Effect.flip(authorize("code")), {
        config: { allowedUsers: new Set(["999"]) },
      }),
    ).toMatchObject({ status: 403 });
  });
});

describe("settings", () => {
  test("HEAD and matching ETags do not fetch the blob", async () => {
    const options = {
      accounts: accountStore({
        find: () => Effect.succeed(account({ objectKey: "blob", written: 1234 })),
      }),
      settings: settingsStore({
        get: () => {
          throw new Error("Unexpected blob read");
        },
      }),
    };
    const head = await run(
      readSettings(authorization, { headOnly: true, ifNoneMatch: "1234" }),
      options,
    );
    expect(head.status).toBe(204);
    expect(head.headers.get("etag")).toBe("1234");
    const unchanged = await run(readSettings(authorization, { ifNoneMatch: "1234" }), options);
    expect(unchanged.status).toBe(304);
  });

  test("returns 404 when settings are absent", async () => {
    expect((await run(readSettings(authorization))).status).toBe(404);
  });

  test("returns the settings body when the ETag has changed", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const response = await run(readSettings(authorization, { ifNoneMatch: "old" }), {
      accounts: accountStore({
        find: () => Effect.succeed(account({ objectKey: "blob", written: 1234 })),
      }),
      settings: settingsStore({
        get: () => Effect.succeed({ body: new Blob([bytes]).stream(), size: bytes.byteLength }),
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe("1234");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("checks content type and declared length before uploading", async () => {
    expect(
      await run(Effect.flip(writeSettings(upload({ "content-type": "application/json" })))),
    ).toMatchObject({ status: 415 });
    expect(
      await run(Effect.flip(writeSettings(upload({ "content-length": "32000001" })))),
    ).toMatchObject({ status: 413 });
  });

  test("does not publish failed uploads", async () => {
    let published = false;
    const error = await run(Effect.flip(writeSettings(upload())), {
      accounts: accountStore({
        publish: () => {
          published = true;
          return Effect.succeed(1);
        },
      }),
      settings: settingsStore({
        put: () => Effect.fail(new StorageError({ operation: "put", cause: "offline" })),
      }),
    });
    expect(error._tag).toBe("StorageError");
    expect(published).toBe(false);
  });

  test("cleans up a finished upload when deletion invalidates its publication", async () => {
    const removed: string[] = [];
    const error = await run(Effect.flip(writeSettings(upload())), {
      accounts: accountStore({ publish: () => Effect.succeed(undefined) }),
      settings: settingsStore({
        delete: (keys) =>
          Effect.sync(() => {
            removed.push(...keys);
          }),
      }),
    });
    expect(error).toBeInstanceOf(RequestRejected);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toStartWith("settings/settings-key/");
  });

  test("collector never forgets objects when R2 deletion fails", async () => {
    let forgotten = false;
    const error = await run(Effect.flip(collectGarbage()), {
      accounts: accountStore({
        claimGarbage: () => Effect.succeed([{ key: "expired", claimedAt: 1 }]),
        forgetGarbage: () =>
          Effect.sync(() => {
            forgotten = true;
          }),
      }),
      settings: settingsStore({
        delete: () => Effect.fail(new StorageError({ operation: "delete", cause: "offline" })),
      }),
    });
    expect(error._tag).toBe("StorageError");
    expect(forgotten).toBe(false);
  });
});
