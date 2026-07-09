import { describe, expect, it } from 'vitest'
import { InteractionResponseType, MessageFlags, ComponentType, ButtonStyle } from 'discord-api-types/v10'
import { connectPtp } from './connectPtp.js'
import type { CommandContext } from './types.js'
import { responseData } from '../testUtils/responseData.js'

describe('connectPtp', () => {
  it('responds ephemerally with sign-in/token links and a modal-opening button', async () => {
    const ctx = { interaction: {}, backend: {} } as unknown as CommandContext

    const response = await connectPtp(ctx)

    expect(response.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(responseData(response).flags).toBe(MessageFlags.Ephemeral)
    expect(responseData(response).content).toContain('protectthepod.com/api/auth/signin/discord')
    expect(responseData(response).content).toContain('protectthepod.com/api/auth/token')

    const button = responseData(response).components?.[0] as { type: ComponentType; components: unknown[] }
    expect(button.type).toBe(ComponentType.ActionRow)
    const buttonComponent = button.components[0] as {
      type: ComponentType
      style: ButtonStyle
      custom_id: string
    }
    expect(buttonComponent.type).toBe(ComponentType.Button)
    expect(buttonComponent.custom_id).toBe('connect-ptp:open-modal')
  })

  it('never touches the backend — this step is entirely local', async () => {
    // §8.1: PTP has no third-party OAuth, so this step can't call PTP or
    // our backend yet — it's just instructions. Passing an empty backend
    // object and having the handler still succeed proves it's not called.
    const ctx = { interaction: {}, backend: {} } as unknown as CommandContext
    await expect(connectPtp(ctx)).resolves.toBeDefined()
  })
})
