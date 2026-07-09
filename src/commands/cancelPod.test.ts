import { describe, expect, it } from 'vitest'
import { cancelPod } from './cancelPod.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { fakeChatInputInteraction, fakeMember, fakeUser } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'

describe('cancelPod', () => {
  it('resolves the organizer id from member.user.id when present', async () => {
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient(),
    }

    const response = await cancelPod(ctx)

    // Not wired to the backend yet (see TODO in source) — this pins the
    // current stub behavior so a future implementation change is a
    // deliberate, visible diff here rather than a silent regression.
    expect(responseData(response).content).toMatch(/not wired up yet/i)
  })

  it('rejects when neither member nor user is present', async () => {
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient(),
    }

    const response = await cancelPod(ctx)

    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })
})
