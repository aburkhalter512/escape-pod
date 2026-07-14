import { describe, expect, it } from 'vitest'
import { ButtonStyle, ComponentType } from 'discord-api-types/v10'
import {
  buildCancelledPodMessage,
  buildConcludedPodMessage,
  buildExpiredPodMessage,
  buildFireFailedPodMessage,
  buildPodRoundMessage,
} from './podMessage.js'

describe('buildPodRoundMessage', () => {
  it('shows the running count and signup buttons while still collecting', () => {
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5 })

    expect(body.embeds[0].description).toContain('5/8 confirmed')
    expect(body.embeds[0].title).not.toContain('Full')

    const buttons = body.components[0].components
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toMatchObject({
      type: ComponentType.Button,
      style: ButtonStyle.Success,
      label: "I'm in",
      custom_id: 'pod-signup:round-1:in',
    })
    expect(buttons[1]).toMatchObject({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: 'Leave',
      custom_id: 'pod-signup:round-1:leave',
    })
  })

  it('embeds the podRoundId into both button custom_ids so the click handler can recover it', () => {
    const body = buildPodRoundMessage({ podRoundId: 'a-different-round', setCode: 'JTL', threshold: 8, count: 0 })
    for (const button of body.components[0].components) {
      expect((button as { custom_id: string }).custom_id).toContain('a-different-round')
    }
  })

  it('switches to a "pod full" embed with a join link once shareUrl is present', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 8,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
    })

    expect(body.embeds[0].title).toContain('Starting')
    expect(body.embeds[0].description).toContain('8 confirmed')

    const buttons = body.components[0].components
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toMatchObject({
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      url: 'https://www.protectthepod.com/draft/share-1',
    })
  })

  it('drops the I\'m in / Leave buttons once the pod is full (no more signups accepted)', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 8,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
    })

    const customIds = body.components[0].components
      .map((c) => (c as { custom_id?: string }).custom_id)
      .filter(Boolean)
    expect(customIds).toHaveLength(0)
  })

  it('mentions no deadline when scheduledFor is absent', () => {
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5 })

    expect(body.embeds[0].description).not.toContain('Fires automatically')
  })

  it('appends a Discord timestamp countdown when scheduledFor is present', () => {
    const scheduledFor = new Date('2026-01-01T12:00:00Z')
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5, scheduledFor })

    expect(body.embeds[0].description).toContain('Fires automatically')
    expect(body.embeds[0].description).toContain(`<t:${Math.floor(scheduledFor.getTime() / 1000)}:R>`)
  })

  it('omits the deadline note once the pod is full, even if scheduledFor was set', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 8,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      scheduledFor: new Date('2026-01-01T12:00:00Z'),
    })

    expect(body.embeds[0].description).not.toContain('Fires automatically')
  })

  it("shows the origin guild's name as an Organizer line in the description when present", () => {
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5, originGuildName: 'Sister Community' })

    expect(body.embeds[0].description).toContain('Organizer: Sister Community')
  })

  it('omits the Organizer line entirely when there is no origin guild name', () => {
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5 })

    expect(body.embeds[0].description).not.toContain('Organizer:')
  })

  it('no longer sets a footer at all (moved into the description body)', () => {
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5, originGuildName: 'Sister Community' })

    expect(body.embeds[0].footer).toBeUndefined()
  })

  it("carries the origin guild's name into the fired/full-table embed too", () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 8,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      originGuildName: 'Sister Community',
    })

    expect(body.embeds[0].description).toContain('Organizer: Sister Community')
  })

  it('adds a "Join the chat" link button alongside "Join the draft" once fired, when chatUrl is present', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 8,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      chatUrl: 'https://discord.com/invite/abc123',
    })

    const buttons = body.components[0].components
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toMatchObject({
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: 'Join the draft',
      url: 'https://www.protectthepod.com/draft/share-1',
    })
    expect(buttons[1]).toMatchObject({
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: 'Join the chat',
      url: 'https://discord.com/invite/abc123',
    })
  })

  it('omits the "Join the chat" button (unchanged current behavior) when chatUrl is absent', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 8,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
    })

    const buttons = body.components[0].components
    expect(buttons).toHaveLength(1)
    expect(buttons.some((b) => (b as { label?: string }).label === 'Join the chat')).toBe(false)
  })

  it('shows a Players line as a bulleted list of mentions for everyone signed up while still collecting', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 2,
      signupDiscordIds: ['p1', 'p2'],
    })

    expect(body.embeds[0].description).toContain('Players:\n- <@p1>\n- <@p2>')
  })

  it('omits the Players line entirely when signupDiscordIds is empty (freshly-posted round)', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 0,
      signupDiscordIds: [],
    })

    expect(body.embeds[0].description).not.toContain('Players:')
  })

  it('omits the Players line entirely when signupDiscordIds is undefined', () => {
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5 })

    expect(body.embeds[0].description).not.toContain('Players:')
  })

  it('shows a Players line as a bulleted list of mentions for everyone signed up once fired/full', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 8,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      signupDiscordIds: ['p1', 'p2', 'p3'],
    })

    expect(body.embeds[0].description).toContain('Players:\n- <@p1>\n- <@p2>\n- <@p3>')
  })

  it('omits the Players line in the fired embed when signupDiscordIds is empty/undefined', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 8,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
    })

    expect(body.embeds[0].description).not.toContain('Players:')
  })

  it('includes both the Organizer and Players lines together, in order, with no stray blank lines', () => {
    const body = buildPodRoundMessage({
      podRoundId: 'round-1',
      setCode: 'JTL',
      threshold: 8,
      count: 2,
      originGuildName: 'Sister Community',
      signupDiscordIds: ['p1', 'p2'],
    })

    const description = body.embeds[0].description ?? ''
    const lines = description.split('\n')
    expect(lines).toEqual([
      '2/8 confirmed.',
      'Organizer: Sister Community',
      'Players:',
      '- <@p1>',
      '- <@p2>',
    ])
  })
})

describe('buildCancelledPodMessage', () => {
  it('shows a cancelled title and no buttons', () => {
    const body = buildCancelledPodMessage('JTL')

    expect(body.embeds[0].title).toContain('Cancelled')
    expect(body.embeds[0].title).toContain('JTL')
    expect(body.components).toHaveLength(0)
  })

  it("shows the origin guild's name as an Organizer line in the description when present", () => {
    const body = buildCancelledPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].description).toContain('Organizer: Sister Community')
  })

  it('omits the Organizer line when there is no origin guild name', () => {
    const body = buildCancelledPodMessage('JTL')

    expect(body.embeds[0].description).not.toContain('Organizer:')
  })

  it('no longer sets a footer at all (moved into the description body)', () => {
    const body = buildCancelledPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].footer).toBeUndefined()
  })

  it('never shows a Players line (cancelled messages do not take signupDiscordIds)', () => {
    const body = buildCancelledPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].description).not.toContain('Players:')
  })
})

describe('buildExpiredPodMessage', () => {
  it('shows an expired title, distinct copy from cancelled, and no buttons', () => {
    const body = buildExpiredPodMessage('JTL')

    expect(body.embeds[0].title).toContain('Expired')
    expect(body.embeds[0].title).toContain('JTL')
    expect(body.embeds[0].description).toMatch(/not enough players/i)
    expect(body.components).toHaveLength(0)
  })

  it('uses a different color than the cancelled message', () => {
    const expired = buildExpiredPodMessage('JTL')
    const cancelled = buildCancelledPodMessage('JTL')

    expect(expired.embeds[0].color).not.toBe(cancelled.embeds[0].color)
  })

  it("shows the origin guild's name as an Organizer line in the description when present", () => {
    const body = buildExpiredPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].description).toContain('Organizer: Sister Community')
  })

  it('omits the Organizer line when there is no origin guild name', () => {
    const body = buildExpiredPodMessage('JTL')

    expect(body.embeds[0].description).not.toContain('Organizer:')
  })

  it('no longer sets a footer at all (moved into the description body)', () => {
    const body = buildExpiredPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].footer).toBeUndefined()
  })

  it('never shows a Players line (expired messages do not take signupDiscordIds)', () => {
    const body = buildExpiredPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].description).not.toContain('Players:')
  })
})

describe('buildConcludedPodMessage', () => {
  it('shows a concluded title, description, and no buttons', () => {
    const body = buildConcludedPodMessage('JTL')

    expect(body.embeds[0].title).toContain('Concluded')
    expect(body.embeds[0].title).toContain('JTL')
    expect(body.embeds[0].description).toMatch(/concluded/i)
    expect(body.components).toHaveLength(0)
  })

  it('uses a color distinct from cancelled, expired, and pod-full', () => {
    const concluded = buildConcludedPodMessage('JTL')
    const cancelled = buildCancelledPodMessage('JTL')
    const expired = buildExpiredPodMessage('JTL')
    const full = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 8, shareUrl: 'https://example.com' })

    expect(concluded.embeds[0].color).not.toBe(cancelled.embeds[0].color)
    expect(concluded.embeds[0].color).not.toBe(expired.embeds[0].color)
    expect(concluded.embeds[0].color).not.toBe(full.embeds[0].color)
  })

  it("shows the origin guild's name as an Organizer line in the description when present", () => {
    const body = buildConcludedPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].description).toContain('Organizer: Sister Community')
  })

  it('omits the Organizer line when there is no origin guild name', () => {
    const body = buildConcludedPodMessage('JTL')

    expect(body.embeds[0].description).not.toContain('Organizer:')
  })

  it('no longer sets a footer at all (moved into the description body)', () => {
    const body = buildConcludedPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].footer).toBeUndefined()
  })
})

describe('buildFireFailedPodMessage', () => {
  it('shows a failed title, actionable copy pointing at /cancel-pod, and no buttons', () => {
    const body = buildFireFailedPodMessage('JTL')

    expect(body.embeds[0].title).toContain('Failed')
    expect(body.embeds[0].title).toContain('JTL')
    expect(body.embeds[0].description).toContain('/cancel-pod')
    expect(body.components).toHaveLength(0)
  })

  it('uses a color distinct from cancelled, expired, concluded, and pod-full', () => {
    const fireFailed = buildFireFailedPodMessage('JTL')
    const cancelled = buildCancelledPodMessage('JTL')
    const expired = buildExpiredPodMessage('JTL')
    const concluded = buildConcludedPodMessage('JTL')
    const full = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 8, shareUrl: 'https://example.com' })

    expect(fireFailed.embeds[0].color).not.toBe(cancelled.embeds[0].color)
    expect(fireFailed.embeds[0].color).not.toBe(expired.embeds[0].color)
    expect(fireFailed.embeds[0].color).not.toBe(concluded.embeds[0].color)
    expect(fireFailed.embeds[0].color).not.toBe(full.embeds[0].color)
  })

  it("shows the origin guild's name as an Organizer line in the description when present", () => {
    const body = buildFireFailedPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].description).toContain('Organizer: Sister Community')
  })

  it('omits the Organizer line when there is no origin guild name', () => {
    const body = buildFireFailedPodMessage('JTL')

    expect(body.embeds[0].description).not.toContain('Organizer:')
  })

  it('no longer sets a footer at all (moved into the description body)', () => {
    const body = buildFireFailedPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].footer).toBeUndefined()
  })

  it('never shows a Players line (fire-failed messages do not take signupDiscordIds)', () => {
    const body = buildFireFailedPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].description).not.toContain('Players:')
  })
})
