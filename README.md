<p align="center">
  <img src=".github/assets/banner.svg" alt="Vencord settings sync through a Worker, D1, and R2" width="960" />
</p>

<h1 align="center">Venflare</h1>

<p align="center">
  <a href="https://github.com/Vencord/Vencloud">Vencloud</a>, Vencord's Go cloud-sync API,
  but running on a Cloudflare Worker.
</p>

<p align="center">
  <a href="https://github.com/Vencord/Vencloud"><img alt="Experimental port" src="https://img.shields.io/badge/status-experimental-ea9a97?style=flat-square" /></a>
  <a href="https://bun.sh"><img alt="Built with Bun" src="https://img.shields.io/badge/tooling-Bun-c4a7e7?style=flat-square&amp;logo=bun&amp;logoColor=e0def4" /></a>
  <a href="https://developers.cloudflare.com/workers/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/runtime-Cloudflare_Workers-f6c177?style=flat-square&amp;logo=cloudflare&amp;logoColor=f6c177" /></a>
</p>

Venflare keeps your [Vencord](https://github.com/Vendicated/Vencord) settings in sync across your devices. It's an experimental port of [Vencloud](https://github.com/Vencord/Vencloud), Vencord's Go sync API, that runs on a Cloudflare Worker. No Go server or Redis to babysit.

> [!WARNING]
> Venflare is experimental. Keep your own exported copy of your settings. Please don't rely on this as your only backup.
>
> Encryption happens on the server, not on your device. Whoever runs the server can decrypt your settings if they know your Discord user ID and hold `PepperSettings`. [How your data is stored](#how-your-data-is-stored) has the details.

Venflare is a separate project, not an official Vencord service. So please report problems here, not in the Vencord support server.

Venflare uses four services:

- **Cloudflare Workers** runs the API that Vencord talks to.
- **D1** stores account records.
- **R2** stores your encrypted settings in a private bucket.
- **Discord** signs you in. Venflare only asks for the `identify` scope, which is the basic one.

We're aiming for existing Vencord clients to work as-is. The test suite covers every endpoint the original Vencloud has.

## Connect Vencord

Open Vencord's **Cloud** settings and do this:

1. Set **Backend URL** to your API address, without `/v1`.
2. Turn on **Enable Cloud Integrations**, then authorize your Discord application.
3. Turn on **Enable Settings Sync**.

Before you trust automatic sync, click **Upload Settings** and **Download Settings** and make sure both work. Then repeat the setup on each device. Desktop Vencord might ask you to restart after you allow the new backend domain. That's normal.

## Hosting

Want to host your own instance? You'll need a Cloudflare account on the Workers Paid plan and a Discord application. [HOSTING.md](HOSTING.md) walks you through setup, configuration, and deploying to production.

## How your data is stored

Here's where things live:

- **D1** holds account records: a keyed hash of your Discord user ID, a random account ID, a pointer to your current backup, and cleanup records for old uploads.
- **R2** holds your settings, one encrypted file per upload.

A pepper is a random secret the server mixes into its hashes and encryption keys, so copying the database and bucket isn't enough to read anything. Venflare uses two, one for accounts and one for settings.

**Encryption.** Your settings reach the Worker compressed but not encrypted. The Worker encrypts them before saving to R2, in 5 MiB chunks with AES-256-GCM. Every upload gets its own key, derived with HKDF-SHA-256 from:

- `PepperSettings`
- Your Discord user ID
- Your account ID
- The file's name in R2
- A random salt

**Discord IDs and tokens.** Venflare never writes your raw Discord user ID to D1 or R2. It stores HMAC-SHA-256 hashes of it instead. Your user ID only travels in the `Authorization` header that Vencord sends with each request, so someone holding just the storage and the database still can't read your settings.

Your Discord access token gets used once, to confirm who you are when you sign in. Venflare doesn't keep it. API secrets are derived from your account ID rather than stored.

**Deleting.** In Vencord's **Cloud** settings, under **Reset Cloud Data**, you can delete your settings or your whole account. Your backup is removed right away, or within a couple of hours if something goes wrong.

## Contributing

Want to change the code? [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the commands, and a map of where things live.

## Credits and license

- [Vencloud](https://github.com/Vencord/Vencloud) provides the original Go API and HTTP protocol.
- [Vencord](https://github.com/Vendicated/Vencord) provides the client and the settings sync feature.

Huge thanks to their contributors.

Venflare uses the [AGPL-3.0 license](LICENSE), like [Vencloud](https://github.com/Vencord/Vencloud/blob/main/LICENSE). If you run a modified version for other people, you have to make its source available to them. Setting `SOURCE_URL` alone doesn't meet that requirement.

Venflare isn't affiliated with or endorsed by Discord, Cloudflare, or the Vencord project. Those names are only there to say what Venflare works with.
