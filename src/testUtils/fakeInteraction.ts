import {
  ApplicationCommandType,
  ChannelType,
  ComponentType,
  GuildMemberFlags,
  InteractionType,
  Locale,
  MessageType,
  type APIApplicationCommandInteractionDataOption,
  type APIApplicationCommandAutocompleteInteraction,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionGuildMember,
  type APIMessage,
  type APIMessageComponentInteraction,
  type APIMessageComponentInteractionData,
  type APIModalSubmissionComponent,
  type APIModalSubmitInteraction,
  type APIPingInteraction,
  type APIUser,
} from 'discord-api-types/v10'

// Genuinely-valid fixtures for Discord's interaction payload types — every
// required field the real API always sends is filled in with a sensible
// default, so tests never need `as never`/`as unknown as X`. Overridable
// per test for the handful of fields handlers actually branch on.

export function fakeUser(overrides: Partial<APIUser> = {}): APIUser {
  return {
    id: 'user-1',
    username: 'testuser',
    discriminator: '0',
    global_name: 'Test User',
    avatar: null,
    ...overrides,
  }
}

export function fakeMember(overrides: Partial<APIInteractionGuildMember> = {}): APIInteractionGuildMember {
  return {
    user: fakeUser(),
    roles: [],
    flags: 0 as GuildMemberFlags,
    joined_at: '2026-01-01T00:00:00.000Z',
    deaf: false,
    mute: false,
    permissions: '0',
    ...overrides,
  }
}

export function fakeMessage(overrides: Partial<APIMessage> = {}): APIMessage {
  return {
    id: 'message-1',
    channel_id: 'channel-1',
    author: fakeUser(),
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    ...overrides,
  }
}

// Fields every APIBaseInteraction variant shares (Ping omits `locale`, so
// callers that need it typed exactly can spread and delete as needed).
function baseInteractionFields() {
  return {
    id: 'interaction-1',
    application_id: 'app-1',
    token: 'interaction-token',
    version: 1 as const,
    app_permissions: '0',
    channel: { id: 'channel-1', type: ChannelType.GuildText } as const,
    channel_id: 'channel-1',
    locale: Locale.EnglishUS,
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 25 * 1024 * 1024,
  }
}

export function fakePingInteraction(): APIPingInteraction {
  const { locale: _locale, ...base } = baseInteractionFields()
  return { ...base, type: InteractionType.Ping }
}

interface FakeChatInputInteractionOverrides extends Partial<Omit<APIChatInputApplicationCommandInteraction, 'data'>> {
  name?: string
  options?: APIApplicationCommandInteractionDataOption[]
}

export function fakeChatInputInteraction(
  overrides: FakeChatInputInteractionOverrides = {}
): APIChatInputApplicationCommandInteraction {
  const { name, options, ...rest } = overrides
  return {
    ...baseInteractionFields(),
    type: InteractionType.ApplicationCommand,
    guild_id: 'guild-1',
    member: fakeMember(),
    ...rest,
    data: { id: 'command-1', type: ApplicationCommandType.ChatInput, name: name ?? 'test-command', options },
  }
}

export function fakeAutocompleteInteraction(
  overrides: { name?: string } & Partial<Omit<APIApplicationCommandAutocompleteInteraction, 'data'>> = {}
): APIApplicationCommandAutocompleteInteraction {
  const { name, ...rest } = overrides
  return {
    ...baseInteractionFields(),
    type: InteractionType.ApplicationCommandAutocomplete,
    guild_id: 'guild-1',
    member: fakeMember(),
    ...rest,
    data: { id: 'command-1', type: ApplicationCommandType.ChatInput, name: name ?? 'test-command', options: [] },
  }
}

interface FakeMessageComponentInteractionOverrides extends Partial<Omit<APIMessageComponentInteraction, 'data' | 'message'>> {
  data?: APIMessageComponentInteractionData
  message?: Partial<APIMessage>
}

// Defaults to a plain button's data shape (just custom_id); pass `data`
// explicitly for a select menu (needs component_type + values too).
export function fakeMessageComponentInteraction(
  overrides: FakeMessageComponentInteractionOverrides = {}
): APIMessageComponentInteraction {
  const { data, message, ...rest } = overrides
  return {
    ...baseInteractionFields(),
    type: InteractionType.MessageComponent,
    guild_id: 'guild-1',
    member: fakeMember(),
    message: fakeMessage(message),
    ...rest,
    data: data ?? { custom_id: 'component-1', component_type: ComponentType.Button },
  }
}

interface FakeModalSubmitInteractionOverrides extends Partial<Omit<APIModalSubmitInteraction, 'data'>> {
  customId?: string
  components?: APIModalSubmissionComponent[]
}

export function fakeModalSubmitInteraction(
  overrides: FakeModalSubmitInteractionOverrides = {}
): APIModalSubmitInteraction {
  const { customId, components, ...rest } = overrides
  return {
    ...baseInteractionFields(),
    type: InteractionType.ModalSubmit,
    guild_id: 'guild-1',
    member: fakeMember(),
    ...rest,
    data: { custom_id: customId ?? 'modal-1', components: components ?? [] },
  }
}
