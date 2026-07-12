import { describe, expect, it } from 'vitest'
import { ButtonStyle, ComponentType } from 'discord-api-types/v10'
import { buildCancelledPodMessage, buildExpiredPodMessage, buildPodRoundMessage } from './podMessage.js'

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

  it("shows the origin guild's name in the footer when present", () => {
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5, originGuildName: 'Sister Community' })

    expect(body.embeds[0].footer?.text).toContain('Sister Community')
  })

  it('omits the footer entirely when there is no origin guild name', () => {
    const body = buildPodRoundMessage({ podRoundId: 'round-1', setCode: 'JTL', threshold: 8, count: 5 })

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

    expect(body.embeds[0].footer?.text).toContain('Sister Community')
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
})

describe('buildCancelledPodMessage', () => {
  it('shows a cancelled title and no buttons', () => {
    const body = buildCancelledPodMessage('JTL')

    expect(body.embeds[0].title).toContain('Cancelled')
    expect(body.embeds[0].title).toContain('JTL')
    expect(body.components).toHaveLength(0)
  })

  it("shows the origin guild's name in the footer when present", () => {
    const body = buildCancelledPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].footer?.text).toContain('Sister Community')
  })

  it('omits the footer when there is no origin guild name', () => {
    const body = buildCancelledPodMessage('JTL')

    expect(body.embeds[0].footer).toBeUndefined()
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

  it("shows the origin guild's name in the footer when present", () => {
    const body = buildExpiredPodMessage('JTL', 'Sister Community')

    expect(body.embeds[0].footer?.text).toContain('Sister Community')
  })
})
