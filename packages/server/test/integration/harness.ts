import { resolve } from "node:path";
import {
  Log,
  LogLevel,
  Miniflare,
  Request as LocalRequest,
  Response as LocalResponse,
} from "miniflare";

import { compatibilityDate } from "../../platform";
import { environment, userId } from "../../../core/test/support";

const server = resolve(import.meta.dir, "../..");
const migrations = resolve(server, "../storage/migrations");

const links = {
  DISCORD_CLIENT_ID: "DiscordClientId",
  DISCORD_CLIENT_SECRET: "DiscordClientSecret",
  DISCORD_REDIRECT_URI: "DiscordRedirectUri",
  PEPPER_SECRETS: "PepperSecrets",
  PEPPER_SETTINGS: "PepperSettings",
};

export const createHarness = async (overrides: Record<string, string> = {}) => {
  const script = await Bun.file(resolve(server, "dist/index.js")).text();
  const logs: unknown[] = [];
  const values: Record<string, string> = { ...environment, ...overrides };
  const worker = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    log: new Log(LogLevel.NONE),
    unsafeTriggerHandlers: true,
    handleStructuredLogs: (event: unknown) => {
      logs.push(event);
    },
    workers: [
      {
        config: {
          name: "vencloud-test",
          compatibilityDate,
          triggers: [{ type: "fetch", pattern: "cloud.example.com/*" }],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: script } },
          },
          env: {
            ...Object.fromEntries(
              Object.entries(values).map(([key, value]) => [key, { type: "text" as const, value }]),
            ),
            ...Object.fromEntries(
              Object.entries(links).map(([key, name]) => [
                `SST_RESOURCE_${name}`,
                { type: "text" as const, value: JSON.stringify({ value: values[key] }) },
              ]),
            ),
            VencloudData: { type: "d1", name: "vencloud-test" },
            VencloudBackups: { type: "r2", name: "vencloud-test" },
          },
        },
        dev: {
          unsafeDirectSockets: [{ host: "127.0.0.1", port: 0 }],
          outboundService: {
            type: "fetcher",
            handler: async (request: LocalRequest) => {
              const url = new URL(request.url);
              if (url.origin !== "https://discord.com")
                throw new Error("Unexpected external request");
              if (url.pathname === "/api/oauth2/token") {
                const body = new URLSearchParams(await request.text());
                if (body.get("code") === "invalid")
                  return LocalResponse.json({ error: "invalid_grant" }, { status: 400 });
                return LocalResponse.json({ access_token: "discord-test-token" });
              }
              if (url.pathname === "/api/users/@me") return LocalResponse.json({ id: userId });
              throw new Error("Unexpected Discord endpoint");
            },
          },
        },
      },
    ],
  });

  try {
    const database = await worker.getD1Database("VencloudData");
    const paths = await Array.fromAsync(new Bun.Glob("*/migration.sql").scan(migrations));
    for (const path of paths.sort()) {
      const migration = await Bun.file(resolve(migrations, path)).text();
      const statements = migration
        .split("--> statement-breakpoint")
        .map((sql) => database.prepare(sql));
      await database.batch(statements);
    }
    const bucket = await worker.getR2Bucket("VencloudBackups");
    const url = await worker.unsafeGetDirectURL("vencloud-test");
    const request = (path: string, options?: RequestInit) => fetch(new URL(path, url), options);
    return { worker, database, bucket, logs, request };
  } catch (error) {
    await worker.dispose();
    throw error;
  }
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;
