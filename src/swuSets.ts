// The set codes /start-pod's `set` option offers as a dropdown (Discord
// choices, not free text — see commands/definitions.ts) rather than
// autocomplete, since the list is small and slow-changing (well under
// Discord's 25-choice limit for a String option) and doesn't need to be
// computed live. Listed newest release first (the order organizers most
// often want to draft) — add a new entry at the top when a new set
// releases; no other code needs to change (see register-commands, which
// re-syncs this to Discord).
export const SWU_SETS = [
  { code: 'ASH', name: 'Ashes of the Empire' },
  { code: 'LAW', name: 'A Lawless Time' },
  { code: 'SEC', name: 'Secrets of Power' },
  { code: 'LOF', name: 'Legacy of the Force' },
  { code: 'JTL', name: 'Jump to Lightspeed' },
  { code: 'TWI', name: 'Twilight of the Republic' },
  { code: 'SHD', name: 'Shadows of the Galaxy' },
  { code: 'SOR', name: 'Spark of Rebellion' },
] as const
