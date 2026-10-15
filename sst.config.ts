// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "vencloud-worker",
      home: "cloudflare",
      removal: input.stage === "production" ? "retain" : "remove",
      protect: input.stage === "production",
      providers: { random: { package: "@pulumi/random", version: "4.21.1" } },
    };
  },
  async run() {
    const { api } = await import("./infra/api");
    return { api: api.url };
  },
});
