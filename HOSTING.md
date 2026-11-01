# Hosting

This guide is for hosting your own instance. Want to change the code instead? See [CONTRIBUTING.md](CONTRIBUTING.md).

## What you need

- [Bun](https://bun.sh) 1.4.2 or newer.
- A Cloudflare account with [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/), D1, and R2 enabled. Cloudflare bills you for usage, so keep an eye on it.
- A [Discord application](https://discord.com/developers/applications) for sign-in.

Cloudflare handles HTTPS for you, so there's no reverse proxy or Docker to set up.

## Quick start

### 1. Install

From the project folder:

```sh
bun install
bun sst install
cp .env.example .env
```

### 2. Add your Cloudflare details

Open `.env` and fill in `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_DEFAULT_ACCOUNT_ID`. Don't commit this file. It holds your Cloudflare token.

To make the token, start from Cloudflare's **Edit Cloudflare Workers** template and add **Account → D1 → Edit**. Want a custom domain? Also add **Zone → DNS → Edit** for that zone. The [SST Cloudflare guide](https://sst.dev/docs/cloudflare/#credentials) has the details.

### 3. Create a Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications), make a new application. Copy its **Application ID** and **OAuth2 Client Secret**. No bot needed.

### 4. Set the secrets

```sh
bun sst secret set DiscordClientId
bun sst secret set DiscordClientSecret
bun sst secret set DiscordRedirectUri
```

Leave off the value and SST will ask for it. For `DiscordRedirectUri`, use this placeholder for now:

```text
https://example.com/v1/oauth/callback
```

You'll swap it out in step 8, once you know your API address.

SST also makes two peppers, `PepperSecrets` and `PepperSettings`. A pepper is a random secret the server mixes into its hashes and keys. Nothing to copy over from the Go server, either.

These commands write to your personal stage. A stage is its own copy of the app, with its own resources.

### 5. Start it

```sh
bun dev
```

This creates your Cloudflare resources, generates `sst-env.d.ts`, starts the Worker build watcher, and opens Drizzle Studio, a web app for poking around your database. When the deploy finishes, copy the `api` URL that SST prints. That's your API address.

> [!NOTE]
> `bun dev` uses real Cloudflare resources. It isn't an offline server, and those resources stick around after you stop it. Use your personal stage for development, and leave `production` alone.
>
> No interactive UI in your terminal? Run `bun dev --mode=mono` instead.

### 6. Run the migrations

Leave `bun dev` running. Open another terminal and run:

```sh
bun run db:migrate
```

### 7. Check the API

Let's see if it's alive:

```sh
curl https://your-api-address/v1
```

You should get `{"ping":"pong"}`.

### 8. Set the real redirect URL

In the Developer Portal, open **OAuth2 → Redirects** and add this URL:

```text
https://your-api-address/v1/oauth/callback
```

Then swap the placeholder for the same URL:

```sh
bun sst secret set DiscordRedirectUri
```

Sign-in won't work until both values match exactly. Copy-paste is your friend here.

## Troubleshooting

- **Sign-in fails.** The redirect URL in Discord and `DiscordRedirectUri` have to match exactly.
- **Someone can't sign in.** If `ALLOWED_USERS` is set, their Discord user ID needs to be on the list.
- **Old backups won't download.** Backups from before the encryption change can't be read through the API. Upload your settings again.

## Deploy to production

Production is its own SST stage with its own database, bucket, and secrets. It doesn't copy your dev data, so you start fresh. Run these from the project folder:

```sh
bun sst secret set DiscordClientId --stage production
bun sst secret set DiscordClientSecret --stage production
bun sst secret set DiscordRedirectUri --stage production
bun run deploy --stage production
bun sst shell --stage production -- bun run --cwd packages/storage db:migrate
```

Don't have the production address yet? Use the placeholder from step 4 for `DiscordRedirectUri` for now. After the deploy, set it to `https://your-production-api-address/v1/oauth/callback`, add that same URL to Discord's redirects, and point Vencord at the production API address. [Connect Vencord](README.md#connect-vencord) has the steps.

**Custom domain.** Set `DOMAIN` in `.env` before you deploy. The domain has to live in a zone that Cloudflare manages. With a custom domain, your API address is that domain instead of the Worker URL. `DOMAIN` only matters outside dev mode. Dev always uses the generated Worker URL.

The SST app is named `vencloud-worker`. Keep that name if you already have a deployment. Renaming it creates a brand-new deployment, and your stored settings don't come along.

## Configuration

Secrets live in SST. Set them with `bun sst secret set <name>`. Everything else goes in `.env`.

| Variable        | Default              | What it does                                                                           |
| --------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `DOMAIN`        | Worker URL           | Custom domain for production. Dev mode ignores it.                                     |
| `ALLOWED_USERS` | Everyone             | Comma-separated Discord user IDs that can sign in and sync.                            |
| `SIZE_LIMIT`    | `32000000`           | Largest backup allowed, in bytes. You can lower it, but not above 32 MB.               |
| `PROMETHEUS`    | `false`              | Set to `true` to show a count of registered accounts at `/metrics`.                    |
| `SOURCE_URL`    | Unset                | Public link to your source code, shown on `/v1`. Must use HTTPS.                       |
| `ROOT_REDIRECT` | `SOURCE_URL`, if set | Where `/` redirects. If neither is set, `/` returns `{"ping":"pong"}`. Must use HTTPS. |

`SOURCE_URL` isn't a secret, and the app starts fine without it. If you publish a modified version, point it at your own repository.

Removing someone from `ALLOWED_USERS` blocks their sign-in and sync. They can still delete their settings and account, though.

## Backups

Back up D1, R2, and your SST secrets together. Don't replace a pepper. Changing one can break existing logins or make account records unreachable. Venflare doesn't include a tool for moving data from Redis to D1.
