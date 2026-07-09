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

Core loop implemented and tested (§7.5): `/start-pod` posts the RSVP embed
+ buttons into every eligible target guild (`src/discord/rest.ts`,
`src/discord/podMessage.ts`) and records each message id back to the
backend; a signup click updates the clicking guild's message via the
interaction response itself and fans the same update out to every other
target guild's message via REST edit (skipping any target with no
recorded message id yet).

Known gaps — see `../tasks/` for the full tracked list, most relevant
here:

- `../tasks/002-leave-button-not-wired.md` — the "Leave" button's `action`
  is parsed but not sent to the backend, so it currently behaves the same
  as "I'm in."
- `../tasks/004-optional-chaining-crash-risk.md` — `member?.user.id`
  chaining in a few places doesn't guard against `member.user` itself
  being absent.
- The cross-guild edit fan-out in `handleMessageComponent`'s `pod-signup:`
  branch is awaited inline before the interaction response is returned —
  fine at the scale this is designed for, but doesn't leave much headroom
  against Discord's 3-second response budget if a round ever fans out to
  dozens of guilds (see the comment in `src/interactions/components.ts`).
