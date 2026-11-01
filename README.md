<p align="center">
  <img src=".github/assets/banner.svg" alt="Vencord settings sync through a Worker, D1, and R2" width="960" />
</p>

<h1 align="center">Venflare</h1>

<p align="center">
  An experimental port of <a href="https://github.com/Vencord/Vencloud">Vencloud</a>,
  Vencord's Go cloud-sync API, to a Cloudflare Worker.
</p>

<p align="center">
  <a href="https://github.com/Vencord/Vencloud"><img alt="Experimental port" src="https://img.shields.io/badge/status-experimental-ea9a97?style=flat-square" /></a>
  <a href="https://bun.sh"><img alt="Built with Bun" src="https://img.shields.io/badge/tooling-Bun-c4a7e7?style=flat-square&amp;logo=bun&amp;logoColor=e0def4" /></a>
  <a href="https://developers.cloudflare.com/workers/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/runtime-Cloudflare_Workers-f6c177?style=flat-square&amp;logo=cloudflare&amp;logoColor=f6c177" /></a>
</p>

Venflare keeps your [Vencord](https://github.com/Vendicated/Vencord) settings in sync across devices. It's an experimental port of [Vencloud](https://github.com/Vencord/Vencloud), Vencord's Go sync API, to a Cloudflare Worker. You don't need a Go server or Redis.

> [!WARNING]
> Venflare is experimental. Keep your own exported copy of your settings, and don't rely on this as your only backup.
>
> Encryption happens on the server, not on your device. An operator who knows your Discord user ID and holds `PepperSettings` can decrypt your settings. [How your data is stored](#how-your-data-is-stored) has the details.

Venflare is a separate project, not an official Vencord service. Report problems here, not to the Vencord support server.

Venflare uses four services:

- **Cloudflare Workers** runs the API that Vencord talks to.
- **D1** stores account records.
- **R2** stores your encrypted settings in a private bucket.
- **Discord** signs you in. This API only requests the `identify` scope.

The goal is to work with existing Vencord clients. The tests cover OAuth, uploads, downloads, deletion, and timestamp ETags.

## Connect Vencord

Open Vencord's **Cloud** settings, then:

1. Set **Backend URL** to your API address, without `/v1`.
2. Turn on **Enable Cloud Integrations**, then authorize your Discord application.
3. Turn on **Enable Settings Sync**.

Try **Upload Settings** and **Download Settings** before you rely on automatic sync. Repeat the setup on each device. Desktop Vencord may ask you to restart after you allow the new backend domain.

## Hosting

Want to host your own instance? You'll need a Cloudflare account on the Workers Paid plan and a Discord application. [HOSTING.md](HOSTING.md) walks you through setup, configuration, and deploying to production.

## How your data is stored

Your settings reach the Worker compressed, but not encrypted. The Worker doesn't decompress them. It encrypts them before writing to R2.

| Where       | What it holds                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D1          | Keyed hashes of Discord user IDs, a random account generation ID, a pointer to your current backup, and upload cleanup records |
| R2          | Your settings, one encrypted object per upload                                                                                 |
| SST secrets | The Discord app secrets and the two peppers                                                                                    |

Venflare doesn't store raw Discord user IDs in D1 or R2. It uses your Discord access token once, for sign-in, and doesn't keep it. It derives API secrets with HMAC-SHA-256 instead of storing them.

**Encryption.** Each upload is encrypted in 5 MiB frames with AES-256-GCM before it's written to R2. Each upload gets its own key. HKDF-SHA-256 derives that key from `PepperSettings`, your Discord user ID, your account generation ID, and the R2 object key.

Your Discord user ID only travels in `Authorization` headers. It isn't stored in D1 or R2. So the bucket and the database alone aren't enough to read your settings.

This isn't end-to-end encryption. An operator who knows your Discord user ID and holds `PepperSettings` can derive the key.

Only uploads made after the encryption change are encrypted. Older plaintext backups aren't migrated, and you can't read them through the API. Upload your settings again after you upgrade.

**Deleting.** Deleting your settings or your account cuts off access to your current backup. The Worker also tries to delete the R2 object right away. If that fails, the hourly cleanup job removes it. The cleanup job removes any upload that's no longer current and is more than an hour old.

Cleanup records stay for seven days so the cleanup job can catch delayed uploads. They don't keep old backups. The seven days aren't a recovery window.

## Contributing

Changing the code? See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands, and where things live.

## Credits and license

- [Vencloud](https://github.com/Vencord/Vencloud) provides the original Go API and HTTP protocol.
- [Vencord](https://github.com/Vendicated/Vencord) provides the client and the settings sync feature.

Thanks to their contributors.

Venflare uses the [AGPL-3.0 license](LICENSE), like [Vencloud](https://github.com/Vencord/Vencloud/blob/main/LICENSE). If you run a modified version for other people, you have to make its source available to them. Setting `SOURCE_URL` alone doesn't meet that requirement.

Venflare isn't affiliated with or endorsed by Discord, Cloudflare, or the Vencord project. Their names describe the services and software it works with.
