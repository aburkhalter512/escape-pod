import { REST } from '@discordjs/rest'
import {
  Routes,
  type RESTPostAPIChannelMessageJSONBody,
  type RESTPostAPIChannelMessageResult,
  type RESTPatchAPIChannelMessageJSONBody,
  type RESTPatchAPIChannelMessageResult,
} from 'discord-api-types/v10'

// Pure REST client — no gateway connection. Used for anything the
// interaction response itself can't do inline, e.g. editing a message in a
// *different* guild than the one that triggered the interaction (needed for
// the cross-guild shared-counter sync in INTEGRATIONS.md §7.5 step 3).
export function createDiscordRest(botToken: string): REST {
  return new REST({ version: '10' }).setToken(botToken)
}

export async function postMessage(
  rest: REST,
  channelId: string,
  body: RESTPostAPIChannelMessageJSONBody
): Promise<RESTPostAPIChannelMessageResult> {
  return rest.post(Routes.channelMessages(channelId), { body }) as Promise<RESTPostAPIChannelMessageResult>
}

export async function editMessage(
  rest: REST,
  channelId: string,
  messageId: string,
  body: RESTPatchAPIChannelMessageJSONBody
): Promise<RESTPatchAPIChannelMessageResult> {
  return rest.patch(Routes.channelMessage(channelId, messageId), {
    body,
  }) as Promise<RESTPatchAPIChannelMessageResult>
}
