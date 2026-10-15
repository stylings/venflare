import { aot } from "elysia/plugin/aot/bun";

const entry = "src/index.ts";
const result = await Bun.build({
  entrypoints: [entry],
  outdir: "dist",
  naming: "index.js",
  format: "esm",
  target: "browser",
  conditions: ["workerd"],
  external: ["cloudflare:workers", "node:*"],
  sourcemap: "linked",
  plugins: [aot(entry, { target: "workerd" })],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const output = result.outputs[0];
if (!output) throw new Error("Build produced no Worker entrypoint");
console.log(`Built Worker (${Math.ceil(output.size / 1024)} KiB)`);
