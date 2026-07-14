import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ComponentType,
  InteractionResponseType,
  type RESTPatchAPIChannelMessageJSONBody,
  type RESTPatchAPIChannelMessageResult,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageResult,
} from 'discord-api-types/v10'
import { handleMessageComponent } from './interactions/components.js'
import { createInMemoryPendingStartPodStore } from './pendingStartPods.js'
import { fakeMember, fakeMessageComponentInteraction, fakeUser } from './testUtils/fakeInteraction.js'
import { createFakeDiscordRest } from './testUtils/fakeDiscordRest.js'
import { stub } from './testUtils/stub.js'
import { createIntegrationPrisma, resetDb } from './testUtils/integrationDb.js'
import { createIntegrationBackend, linkFakeOrganizer } from './testUtils/integrationBackend.js'

// Issue #1: the pod-signup: component handler used to await the entire
// signup — a real backend round-trip plus one Discord REST call per
// target guild — before returning any interaction response at all, risking
// Discord's 3-second response budget. The fix (components.ts) returns a
// DeferredMessageUpdate immediately and does the real work in a detached
// background task, reporting the result back via
// editOriginalInteractionResponse. That fix lives entirely in the
// Discord-interaction layer (interactions/components.ts), which none of
// this repo's other integration tests exercise (they all call
// BackendClient or the HTTP routes directly) — this file closes that gap,
// driving the actual component handler against real Postgres, with
// Discord itself still faked.
const prisma = createIntegrationPrisma()

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetDb(prisma)
})

function succeedingBackend() {
  return createIntegrationBackend(prisma)
}

// createFakeDiscordRest returns the DiscordRestClient interface type,
// which erases each stub's `.calls` log — kept and returned separately,
// alongside the constructed client, for assertions (same pattern as
// podLifecycle.integration.test.ts's noisyFakeDiscordRest).
function noisyFakeDiscordRest() {
  const editMessage = stub(
    async (_channelId: string, _messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) =>
      ({}) as RESTPatchAPIChannelMessageResult
  )
  const editOriginalInteractionResponse = stub(
    async (_applicationId: string, _interactionToken: string, _body: RESTPatchAPIWebhookWithTokenMessageJSONBody) =>
      ({}) as RESTPatchAPIWebhookWithTokenMessageResult
  )
  const discordRest = createFakeDiscordRest({ editMessage, editOriginalInteractionResponse })
  return { discordRest, editMessage, editOriginalInteractionResponse }
}

// handleMessageComponent's 5th parameter is a test-only seam: when passed,
// it's called with the detached background task's own promise, letting a
// test await it deterministically before asserting on its effects — see
// components.ts's doc comment on that parameter. Deliberately does NOT
// await it automatically (unlike components.test.ts's own
// runAndAwaitBackgroundWork) — this file needs to assert on state *before*
// the background work lands too, to prove the response really didn't wait
// for it.
function captureBackgroundWork(): { onBackgroundWork: (work: Promise<void>) => void; get: () => Promise<void> } {
  let backgroundWork: Promise<void> | undefined
  return {
    onBackgroundWork: (work) => {
      backgroundWork = work
    },
    get: () => {
      if (!backgroundWork) throw new Error('background work was never captured — did the branch under test defer?')
      return backgroundWork
    },
  }
}

describe('pod-signup: component handler, end to end against real Postgres', () => {
  it('defers immediately, then completes the real signup and cross-guild fan-out once the detached work finishes', async () => {
    const backend = succeedingBackend()
    const { discordRest, editMessage, editOriginalInteractionResponse } = noisyFakeDiscordRest()
    const pendingStartPods = createInMemoryPendingStartPodStore()

    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'broadcast-1' })
    await backend.subscribeGuild('guild-2', 'organizer-1', { channelId: 'broadcast-2' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: ['guild-1', 'guild-2'],
    })
    // Mirrors the real post-then-record flow (start-pod:confirm: above) so
    // the pod-signup: fan-out below has real target messageIds to edit.
    await backend.recordMessagePosted(podRoundId, 'guild-1', 'message-in-guild-1')
    await backend.recordMessagePosted(podRoundId, 'guild-2', 'message-in-guild-2')

    const interaction = fakeMessageComponentInteraction({
      guild_id: 'guild-1',
      data: { custom_id: `pod-signup:${podRoundId}:in`, component_type: ComponentType.Button },
      member: fakeMember({ user: fakeUser({ id: 'player-1', username: 'PlayerOne' }) }),
    })

    const { onBackgroundWork, get: getBackgroundWork } = captureBackgroundWork()
    const response = await handleMessageComponent(interaction, backend, discordRest, pendingStartPods, onBackgroundWork)

    // The core proof of issue #1's fix: the interaction response comes
    // back as a bare deferred ack, and the real work (a Postgres
    // round-trip plus a REST call per target guild) has provably not
    // landed yet at this point — no followup or fan-out edit has happened.
    expect(response).toEqual({ type: InteractionResponseType.DeferredMessageUpdate })
    expect(editOriginalInteractionResponse.calls).toHaveLength(0)
    expect(editMessage.calls).toHaveLength(0)

    await getBackgroundWork()

    // Now the deferred work has actually completed: the clicking guild's
    // message gets its result via the webhook followup edit...
    expect(editOriginalInteractionResponse.calls).toHaveLength(1)
    const [, , followupBody] = editOriginalInteractionResponse.calls[0]
    expect(followupBody.embeds?.[0]?.description).toContain('1/8 confirmed')
    expect(followupBody.embeds?.[0]?.title).toContain('#1')

    // ...and every *other* target guild's message is synced via a direct
    // edit — this cross-guild fan-out, previously awaited inline before
    // any response went out at all, is the specific behavior issue #1 was
    // about.
    expect(editMessage.calls).toHaveLength(1)
    const [editedChannelId, editedMessageId] = editMessage.calls[0]
    expect(editedChannelId).toBe('broadcast-2')
    expect(editedMessageId).toBe('message-in-guild-2')

    // Proof the signup really landed in real Postgres, not just that a
    // followup edit happened to look right: a second, independent signup
    // for the same round now sees a count of 2.
    const secondSignup = await backend.recordSignup(podRoundId, 'player-2', 'PlayerTwo', 'guild-1', 'in')
    expect(secondSignup.ok).toBe(true)
    if (secondSignup.ok) expect(secondSignup.value.count).toBe(2)
  })

  it('reports a not-found round back through the followup edit rather than throwing', async () => {
    const backend = succeedingBackend()
    const { discordRest, editOriginalInteractionResponse } = noisyFakeDiscordRest()
    const pendingStartPods = createInMemoryPendingStartPodStore()

    const interaction = fakeMessageComponentInteraction({
      guild_id: 'guild-1',
      data: { custom_id: 'pod-signup:no-such-round:in', component_type: ComponentType.Button },
      member: fakeMember({ user: fakeUser({ id: 'player-1', username: 'PlayerOne' }) }),
    })

    const { onBackgroundWork, get: getBackgroundWork } = captureBackgroundWork()
    const response = await handleMessageComponent(interaction, backend, discordRest, pendingStartPods, onBackgroundWork)
    expect(response).toEqual({ type: InteractionResponseType.DeferredMessageUpdate })

    await getBackgroundWork()

    expect(editOriginalInteractionResponse.calls).toHaveLength(1)
    const [, , body] = editOriginalInteractionResponse.calls[0]
    expect(body.content).toBe('Pod round not found')
  })
})
