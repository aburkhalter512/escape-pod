import { REST } from '@discordjs/rest'
import { Routes } from 'discord-api-types/v10'
import { commandDefinitions } from '../src/commands/definitions.js'

const applicationId = process.env.DISCORD_APPLICATION_ID
const botToken = process.env.DISCORD_BOT_TOKEN

if (!applicationId || !botToken) {
  console.error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must be set (see .env.example)')
  process.exit(1)
}

const rest = new REST({ version: '10' }).setToken(botToken)

const registered = await rest.put(Routes.applicationCommands(applicationId), {
  body: commandDefinitions,
})

console.log(`Registered ${(registered as unknown[]).length} global commands.`)
