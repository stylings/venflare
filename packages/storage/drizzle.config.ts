import { defineConfig } from "drizzle-kit";
import { Resource } from "sst/resource";

export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    accountId: Resource.CloudflareAccountId.value,
    databaseId: Resource.VencloudDataId.value,
    token: Resource.CloudflareApiToken.value,
  },
});
