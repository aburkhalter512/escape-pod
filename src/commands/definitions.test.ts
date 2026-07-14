import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType, PermissionFlagsBits } from 'discord-api-types/v10'
import { commandDefinitions } from './definitions.js'
import { commandHandlers } from './index.js'
import { SWU_SETS } from '../swuSets.js'

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

  // Every command defaults to Manage Guild holders only -- a deliberate
  // choice (2026-07-14) even though organizer-facing commands
  // (connect-ptp/start-pod/cancel-pod/conclude-pod) aren't guild-admin
  // actions: default_member_permissions is only a *default*, individual
  // servers can still open specific commands back up to other roles/users
  // via Discord's own Integrations UI (Server Settings > Integrations >
  // this bot > command permissions) without any code change here.
  it('restricts every command to Manage Guild holders by default', () => {
    for (const definition of commandDefinitions) {
      expect(
        definition.default_member_permissions,
        `${definition.name} should restrict to Manage Guild by default`
      ).toBe(PermissionFlagsBits.ManageGuild.toString())
    }
  })

  it("start-pod's set option offers every SWU_SETS entry as a dropdown choice, newest first, no free text", () => {
    const startPod = commandDefinitions.find((d) => d.name === 'start-pod')
    const setOption = startPod?.options?.find((o) => o.name === 'set') as
      | { type: ApplicationCommandOptionType; choices?: Array<{ name: string; value: string }> }
      | undefined

    expect(setOption?.type).toBe(ApplicationCommandOptionType.String)
    expect(setOption?.choices?.map((c) => c.value)).toEqual(SWU_SETS.map((s) => s.code))
  })
})
