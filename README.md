# draft-pod-discord-bot

Discord-facing edge service for the draft pod notifier. Verifies and routes
Discord interactions (slash commands, buttons, modals) over a stateless HTTP
endpoint, and forwards all business logic and state to the
[backend](../backend) service.

Design rationale lives in [`../INTEGRATIONS.md`](../INTEGRATIONS.md) — start
with the "Summary" section at the top, then §7 (bot install & RSVP flow) and
§8 (PTP account-linking flow) for the details this repo implements.

## Why a separate repo from the backend

This service is deliberately kept thin: signature verification, command/
component routing, and talking to Discord's REST API. It holds no durable
state and no PTP integration logic — that all lives in the backend, reached
over its internal API (`src/backendClient.ts`). See INTEGRATIONS.md §3.4 for
why this is a standalone system rather than a PTP feature, and §7.1 for why
the interaction layer is intentionally stateless (HTTP interactions
endpoint, not a gateway connection).

## Setup

```bash
npm install
cp .env.example .env   # fill in Discord app credentials + backend URL
npm run register-commands   # registers the /connect-ptp, /subscribe-guild,
                             # /allow-organizer, /start-pod, /cancel-pod
                             # commands globally with Discord
npm run dev
```

The interactions endpoint URL (`POST /interactions` on wherever this is
deployed) needs to be registered in the Discord Developer Portal under
"Interactions Endpoint URL" for the application.

## Status

Scaffolding only — command/component handlers are wired to a
`BackendClient` whose methods currently point at backend routes that are
themselves stubs. See TODO comments in `src/commands/` and
`src/interactions/components.ts` for what's not yet implemented, most
notably the cross-guild message-sync step described in INTEGRATIONS.md
§7.5 step 3.
