import { compatibilityDate } from "../packages/server/platform";

const database = new sst.cloudflare.D1("VencloudData");
const backups = new sst.cloudflare.Bucket("VencloudBackups");
const clientId = new sst.Secret("DiscordClientId");
const clientSecret = new sst.Secret("DiscordClientSecret");
const redirectUri = new sst.Secret("DiscordRedirectUri");
const databaseId = new sst.Secret("VencloudDataId", database.nodes.database.id);
const accountId = new sst.Secret("CloudflareAccountId", sst.cloudflare.DEFAULT_ACCOUNT_ID);
const apiToken = new sst.Secret("CloudflareApiToken", process.env.CLOUDFLARE_API_TOKEN);

const secretsPepper = new random.RandomBytes("SecretsPepper", {
  length: 64,
  keepers: { databaseId: database.nodes.database.id },
});
const settingsPepper = new random.RandomBytes("SettingsPepper", {
  length: 64,
  keepers: { databaseId: database.nodes.database.id },
});
const pepperSecrets = new sst.Secret("PepperSecrets", secretsPepper.hex);
const pepperSettings = new sst.Secret("PepperSettings", settingsPepper.hex);

new sst.x.DevCommand("DrizzleStudio", {
  link: [databaseId, accountId, apiToken],
  dev: { directory: "packages/storage", command: "bun run db:studio", title: "Database" },
});
new sst.x.DevCommand("WorkerBuild", {
  dev: { directory: "packages/server", command: "bun --watch build.ts", title: "Elysia AOT" },
});

export const api = new sst.cloudflare.Worker("Vencloud", {
  handler: "packages/server/dist/index.js",
  domain: $dev ? undefined : process.env.DOMAIN || undefined,
  url: true,
  link: [database, backups, clientId, clientSecret, redirectUri, pepperSecrets, pepperSettings],
  environment: {
    SOURCE_URL: process.env.SOURCE_URL ?? "",
    ROOT_REDIRECT: process.env.ROOT_REDIRECT ?? "",
    ALLOWED_USERS: process.env.ALLOWED_USERS ?? "",
    SIZE_LIMIT: process.env.SIZE_LIMIT ?? "32000000",
    PROMETHEUS: process.env.PROMETHEUS ?? "false",
  },
  compatibility: { date: compatibilityDate, flags: [] },
  transform: {
    worker: (args) => {
      args.limits = { cpuMs: 100 };
      args.observability = {
        enabled: true,
        logs: { enabled: true, invocationLogs: false, headSamplingRate: 1, persist: true },
        traces: { enabled: true, headSamplingRate: 0.1, persist: true },
      };
    },
  },
});

new cloudflare.WorkersCronTrigger("SettingsCleanup", {
  accountId: sst.cloudflare.DEFAULT_ACCOUNT_ID,
  scriptName: api.nodes.worker.scriptName,
  schedules: [{ cron: "17 * * * *" }],
});
