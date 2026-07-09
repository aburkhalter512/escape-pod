import { REST, type RequestData, type RouteLike } from '@discordjs/rest'
import {
  Routes,
  type RESTPostAPIChannelMessageJSONBody,
  type RESTPostAPIChannelMessageResult,
  type RESTPatchAPIChannelMessageJSONBody,
  type RESTPatchAPIChannelMessageResult,
} from 'discord-api-types/v10'

// The contract the app depends on for talking to Discord — scoped to the
// two message operations we actually perform, with real response types
// (no `unknown`). See testUtils/fakeDiscordRest.ts.
export interface DiscordRestClient {
  postMessage(channelId: string, body: RESTPostAPIChannelMessageJSONBody): Promise<RESTPostAPIChannelMessageResult>
  editMessage(
    channelId: string,
    messageId: string,
    body: RESTPatchAPIChannelMessageJSONBody
  ): Promise<RESTPatchAPIChannelMessageResult>
}

// The raw @discordjs/rest surface HttpDiscordRest wraps. A real REST
// instance satisfies this structurally; tests can inject a plain stub
// instead of spinning up a real REST client.
interface RawRestClient {
  post(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
  patch(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
}

// The only place `unknown` gets cast away — every other consumer works
// with DiscordRestClient's real response types directly.
export class HttpDiscordRest implements DiscordRestClient {
  #raw: RawRestClient

  constructor(raw: RawRestClient) {
    this.#raw = raw
  }

  async postMessage(
    channelId: string,
    body: RESTPostAPIChannelMessageJSONBody
  ): Promise<RESTPostAPIChannelMessageResult> {
    return this.#raw.post(Routes.channelMessages(channelId), { body }) as Promise<RESTPostAPIChannelMessageResult>
  }

  async editMessage(
    channelId: string,
    messageId: string,
    body: RESTPatchAPIChannelMessageJSONBody
  ): Promise<RESTPatchAPIChannelMessageResult> {
    return this.#raw.patch(Routes.channelMessage(channelId, messageId), {
      body,
    }) as Promise<RESTPatchAPIChannelMessageResult>
  }
}

// Pure REST client — no gateway connection. Used for anything the
// interaction response itself can't do inline, e.g. editing a message in a
// *different* guild than the one that triggered the interaction (needed for
// the cross-guild shared-counter sync in INTEGRATIONS.md §7.5 step 3).
export function createDiscordRest(botToken: string): DiscordRestClient {
  return new HttpDiscordRest(new REST({ version: '10' }).setToken(botToken))
}
