import { Context, Effect } from "effect";

import type { DiscordError, RequestRejected } from "#core/errors";

export interface DiscordClientService {
  readonly identify: (code: string) => Effect.Effect<string, DiscordError | RequestRejected>;
}

export class DiscordClient extends Context.Service<DiscordClient, DiscordClientService>()(
  "vencloud/DiscordClient",
) {}
