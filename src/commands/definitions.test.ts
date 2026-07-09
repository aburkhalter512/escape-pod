import { describe, expect, it } from 'vitest'
import { commandDefinitions } from './definitions.js'
import { commandHandlers } from './index.js'

describe('commandDefinitions / commandHandlers alignment', () => {
  it('registers a handler for every defined command', () => {
    for (const definition of commandDefinitions) {
      expect(commandHandlers[definition.name], `missing handler for "${definition.name}"`).toBeDefined()
    }
  })

  it('does not register handlers for commands that are not defined (dead code / typos)', () => {
    const definedNames = new Set(commandDefinitions.map((d) => d.name))
    for (const handlerName of Object.keys(commandHandlers)) {
      expect(definedNames.has(handlerName), `handler "${handlerName}" has no matching definition`).toBe(true)
    }
  })

  it('has no duplicate command names', () => {
    const names = commandDefinitions.map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every command name matches Discord\'s naming constraints (lowercase, 1-32 chars, no spaces)', () => {
    for (const definition of commandDefinitions) {
      expect(definition.name).toMatch(/^[a-z0-9_-]{1,32}$/)
    }
  })

  it('restricts guild-management commands to Manage Guild holders by default', () => {
    const guildAdminCommands = ['subscribe-guild', 'allow-organizer']
    for (const name of guildAdminCommands) {
      const definition = commandDefinitions.find((d) => d.name === name)
      expect(definition?.default_member_permissions, `${name} should restrict by default`).toBeDefined()
    }
  })
})
