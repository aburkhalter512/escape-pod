import { describe, expect, it } from 'vitest'
import { ButtonStyle, ComponentType } from 'discord-api-types/v10'
import { buildCancelledPodMessage, buildPodRoundMessage } from './podMessage.js'

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

    expect(body.embeds[0].title).toContain('Full')
    expect(body.embeds[0].description).toContain('8/8 confirmed')

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
})

describe('buildCancelledPodMessage', () => {
  it('shows a cancelled title and no buttons', () => {
    const body = buildCancelledPodMessage('JTL')

    expect(body.embeds[0].title).toContain('Cancelled')
    expect(body.embeds[0].title).toContain('JTL')
    expect(body.components).toHaveLength(0)
  })
})
