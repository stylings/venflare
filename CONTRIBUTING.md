# Contributing

This guide is for changing the code. If you want to host Venflare yourself, see the [README](README.md).

## Setup

Finish the [Quick start](README.md#quick-start) through step 5. On a fresh checkout, `bun dev` has to run once with the secrets set. It generates `sst-env.d.ts`. That file isn't committed, and typechecking needs it. Set the secrets instead of writing that file by hand.

Keep the SST app name, `vencloud-worker`. Renaming it creates a separate deployment, and it doesn't migrate stored settings.

## Layout

Venflare has three Bun workspaces. Infrastructure lives in `infra/`.

```text
packages/
  core/       Accounts, OAuth, crypto, and settings logic
  storage/    D1 queries, R2 uploads, schema, and migrations
  server/     HTTP routes, Discord client, and Worker runtime
infra/        SST resources
```

The API uses Elysia v2 (beta) with a build-time AOT step, Effect v4 (RC), and Drizzle v1 (RC). Their versions are pinned in the workspace `package.json` files. Bun runs builds, scripts, and tests. The deployed API runs in workerd, Cloudflare's runtime, not in Bun.

## Where things live

| To change                                     | Look in                                 |
| --------------------------------------------- | --------------------------------------- |
| Config and environment variables              | `packages/core/src/config.ts`           |
| Sign-in and the Discord OAuth flow            | `packages/core/src/oauth/`              |
| Accounts, API secrets, and auth checks        | `packages/core/src/accounts/`           |
| Settings uploads and downloads                | `packages/core/src/settings/`           |
| The hourly cleanup job                        | `packages/core/src/settings/cleanup.ts` |
| HTTP routes                                   | `packages/server/src/routes/`           |
| Worker entry point and scheduled handler      | `packages/server/src/index.ts`          |
| Discord API calls                             | `packages/server/src/discord/client.ts` |
| D1 schema and queries                         | `packages/storage/src/db/`              |
| R2 uploads                                    | `packages/storage/src/r2/`              |
| SST resources, secrets, and the cron schedule | `infra/api.ts`                          |

## Commands

Run `bun run check` before you push. It runs typecheck, lint, format check, and both test suites. The integration tests build the API first, so `check` builds it too.

```sh
bun run build              # Build the API
bun run test               # Unit tests
bun run test:integration   # Build, then integration tests
bun run typecheck
bun run lint
bun run format:check
bun run check              # Typecheck, lint, format check, and all tests
```

## Tests

Unit tests live in `packages/core/test/unit` and `packages/server/test/unit`.

Integration tests live in `packages/server/test/integration`. They run locally in workerd, with D1 and R2 provided by Miniflare. Discord is mocked. They don't call the real Discord API or need Cloudflare credentials.

## Schema changes

1. Edit `packages/storage/src/db/schema.ts`.
2. Run `bun run db:generate`.
3. Run `bun run db:migrate`.
