import {
  InteractionResponseType,
  type APIApplicationCommandAutocompleteInteraction,
  type APIInteractionResponse,
} from 'discord-api-types/v10'
import type { BackendClient } from '../backendClient.js'
import { roundLabel } from '../commands/helpers.js'

// Backs the `round` option's live suggestions on /cancel-pod and
// /conclude-pod (GitHub issue #6) — the first interaction type this
// codebase handles (router.ts previously had no case for
// InteractionType.ApplicationCommandAutocomplete at all). Resolves the
// calling organizer's currently-cancellable or currently-concludable
// rounds via the same listActiveRounds read path the command handlers
// themselves use for ambiguity detection, so what an organizer sees in
// the dropdown matches what they'd see in the disambiguation message if
// they ignored it. No per-keystroke filtering here — Discord's own
// client does substring matching against each choice's `name` — and
// realistic concurrent-round counts per organizer are nowhere near
// Discord's 25-choice cap on autocomplete responses.
// Only these two commands register an autocomplete-enabled `round` option
// today (see commands/definitions.ts) — an explicit map with a fail-safe
// default (rather than an if/else that treats "anything but conclude-pod"
// as cancellable) means a future command that also adds an
// autocomplete-enabled option can't silently inherit the wrong kind here;
// it gets an empty choice list instead until this map is updated for it.
const KIND_BY_COMMAND: Record<string, 'cancellable' | 'concludable'> = {
  'cancel-pod': 'cancellable',
  'conclude-pod': 'concludable',
}

export async function handleAutocomplete(
  interaction: APIApplicationCommandAutocompleteInteraction,
  backend: BackendClient
): Promise<APIInteractionResponse> {
  const organizerId = interaction.member?.user.id ?? interaction.user?.id
  const kind = KIND_BY_COMMAND[interaction.data.name]
  if (!organizerId || !kind) {
    return { type: InteractionResponseType.ApplicationCommandAutocompleteResult, data: { choices: [] } }
  }

  const candidates = await backend.listActiveRounds(organizerId, kind)

  return {
    type: InteractionResponseType.ApplicationCommandAutocompleteResult,
    data: {
      choices: candidates.map((candidate) => ({ name: roundLabel(candidate), value: candidate.organizerRoundNumber })),
    },
  }
}
