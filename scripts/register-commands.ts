import { REST } from '@discordjs/rest'
import { Routes, type RESTPutAPIApplicationCommandsResult } from 'discord-api-types/v10'
import { commandDefinitions } from '../src/commands/definitions.js'

const applicationId = process.env.DISCORD_APPLICATION_ID
const botToken = process.env.DISCORD_BOT_TOKEN

if (!applicationId || !botToken) {
  console.error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must be set (see .env.example)')
  process.exit(1)
}

const rest = new REST({ version: '10' }).setToken(botToken)

// rest.put() itself returns bare Promise<unknown> (@discordjs/rest's generic
// methods aren't tied to endpoint response types), but discord-api-types
// documents exactly what this endpoint returns — cast to that real type
// instead of a throwaway `unknown[]`.
const registered = (await rest.put(Routes.applicationCommands(applicationId), {
  body: commandDefinitions,
})) as RESTPutAPIApplicationCommandsResult

console.log(`Registered ${registered.length} global commands.`)
