// A draft pod always targets a full table of 8 — this is fixed, not
// something an organizer configures. `threshold` (see /start-pod's
// `threshold` option) is a separate, per-round *minimum* used only to
// decide whether a round that hits its deadline short of capacity still
// fires (see services/pods.ts's expireOverdueRounds) rather than getting
// auto-cancelled. Shared between the service layer and the Discord
// presentation layer (podMessage.ts) so both agree on what "full" means
// without importing across that boundary.
export const POD_CAPACITY = 8
