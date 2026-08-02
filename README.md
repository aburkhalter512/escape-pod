# escape-pod

Escape Pod, a Star Wars: Unlimited draft pod notifier. Runs on Cloudflare
Workers + Durable Objects (`escape-pod-cf`) — a single Worker, stateless
HTTP in front, with one globally-singleton Durable Object owning all
durable state (organizers, guild subscriptions, pod rounds/targets/
signups) in its own embedded SQLite storage.

## Invite the bot

[Add escape-pod to your server](https://discord.com/oauth2/authorize?client_id=1524918902373744650&permissions=3089&scope=bot%20applications.commands)

Requests both the `bot` and `applications.commands` scopes (see
Troubleshooting below for why a guild missing either one silently breaks)
and the minimum permissions it actually uses: View Channels, Send
Messages, Create Instant Invite, and Manage Channels (the last one for
the temporary per-round chat channel, `src/discord/podChat.ts`) —
`permissions=3089` in the link above. After inviting, a server admin
still needs to run `/escape-pod-setup` there (§7.2 in `INTEGRATIONS.md`)
before organizers can actually post draft rounds into it.

## Commands

All 9 commands default to **"Manage Guild"** holders only, even the
organizer-facing ones below that aren't inherently admin actions — a
deliberate, restrictive-by-default choice so a fresh install starts
locked down rather than open. A server admin can open any individual
command back up to other roles/users via Discord's own Server Settings →
Integrations → this bot → command permissions; no code change or redeploy
needed, and it's scoped per-server.

### Server setup

- **`/escape-pod-setup [channel]`** — one-stop setup: opts this server in
  to receive draft-pod broadcasts (`channel`, where rounds get posted, is
  required the first time; omit it on a re-run to just leave it
  unchanged) and, the first time only, offers a button to link this
  server's Niamos token (see `/connect-niamos` below — same flow, shown
  inline so setup is one command instead of two). Re-run anytime to
  change the channel; also reactivates a server that previously ran
  `/unsubscribe-guild`. There's no posting-policy choice — every server
  trusts its own organizers automatically (self-trust), and trusting
  organizers from another server is always explicit, via `/allow-guild`.
- **`/unsubscribe-guild`** — stops this server from receiving broadcasts.
  A soft-delete, not a hard removal — round history is preserved, and
  running `/escape-pod-setup` again reactivates it.
- **`/allow-guild <origin-server-id>`** — trusts an entire other server's
  organizers to post draft-pod rounds here. If this server hasn't run
  `/escape-pod-setup` yet, this offers a live channel picker right in the
  response — picking a channel subscribes the server and grants the
  trust in one step, no separate `/escape-pod-setup` call needed.
  Replaces the older per-organizer `/allow-organizer` (deprecated, now a
  no-op — kept registered only so it still resolves gracefully for
  anyone who runs it out of habit).
- **`/request-trust`** — generates the exact `/allow-guild` invocation
  another server's admin needs to run to trust organizers from this one
  — saves hunting down this server's own ID.
- **`/connect-niamos`** — links (or re-links) this server's Niamos bot
  token on its own, without touching the broadcast subscription — useful
  if a token needs to be regenerated later. `/escape-pod-setup` already
  offers this inline the first time a server is set up; this command
  exists for every time after that. Walks an admin through generating a
  token at niamos.net/settings and pasting it back via a modal. Only one
  token is allowed per server at a time; re-running replaces it. Unlike
  the old Protect the Pod integration this replaced, the token is scoped
  to the server, not to whichever admin happens to paste it in — any
  eligible organizer can `/start-pod` here once it's linked, with no
  individual account-linking step of their own.

### Organizer commands

- **`/start-pod set:<code> [threshold] [deadline]`** — starts a new RSVP
  round for the given set across every server you're eligible to post
  into (the server you ran this from, automatically, plus any other
  server that's specifically trusted it via `/allow-guild`). Must be run
  from inside a server, not a DM
  — the origin server is what resolves which linked Niamos token
  actually creates the draft. Pick which server(s) to post into from a
  menu, review the summary, then confirm to actually post — nothing is
  created until you do. `threshold` (2-8, default 8) is the minimum
  signups still needed to fire at the deadline if the table isn't full by
  then; `deadline` (e.g. `2h`, `90m`, `1d`) auto-fires (if `threshold`
  was reached) or expires the round once it passes. Omit `deadline` and
  the round only ever fires by filling all 8 seats.
- **`/cancel-pod [round]`** — cancels one of your in-progress rounds, as
  long as it hasn't fired yet (still collecting signups, or just past its
  threshold but not yet turned into a real pod). `round` disambiguates
  when you have more than one active round at once (autocompletes your
  own cancellable rounds live) — omit it when you only have one.
- **`/conclude-pod [round]`** — marks one of your *fired* rounds as
  finished: updates its broadcast message and deletes the round's
  temporary chat channel (`src/discord/podChat.ts`). Works the instant
  you run it — there's no check that the draft itself actually finished
  on Niamos, this is fully organizer-trust by design. Same `round`
  disambiguation as `/cancel-pod`.

## Setup

```bash
npm install
cp .env.example .env   # fill in DISCORD_APPLICATION_ID/DISCORD_BOT_TOKEN,
                        # only used by register-commands below
npm run register-commands   # registers all 9 slash commands globally
                             # with Discord
```

Local Worker dev (`npm run dev:cloudflare`, i.e. `wrangler dev`) needs a
`.dev.vars` file (wrangler's own convention, not `.env`) with the two
real secrets `wrangler.toml` doesn't hold in plain text:

```
DISCORD_BOT_TOKEN=...
TOKEN_ENCRYPTION_KEY=...   # generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `NIAMOS_API_BASE_URL`, and
`NIAMOS_SHARE_BASE_URL` are already in `wrangler.toml`'s `[vars]` — meant
to be public, safe to commit (`DISCORD_PUBLIC_KEY` only verifies webhook
signatures, it doesn't authenticate as the bot).

The interactions endpoint URL (`POST /interactions` on wherever this is
deployed) needs to be registered in the Discord Developer Portal under
"Interactions Endpoint URL" for the application — Discord requires a
real, CA-signed HTTPS endpoint here, which a `*.workers.dev` subdomain
already satisfies with zero extra setup.

## Testing

`npm test` runs the regular unit suite — hand-rolled fakes/stubs only
(`src/testUtils/`), no real network I/O, safe to run anywhere including
CI.

`npm run test:workers` runs a separate suite (`*.workers.test.ts`)
against a real local Durable Object via `@cloudflare/vitest-pool-workers`
(real DO SQLite storage, real bindings, `cloudflare:test`), with
Discord/Niamos still faked. This exists to catch bugs fakes structurally
can't — real transactional/concurrency behavior (the atomic-claim
compare-and-swap guarantees `services/pods.ts` relies on, re-proven under
genuinely concurrent HTTP requests dispatched into the real DO) and real
Worker/DO wiring (Cron Trigger dispatch, request-serialization through
the singleton DO instance), as opposed to only the service logic itself.

## Deployment

`wrangler.toml` declares the Worker (`escape-pod-cf`), the Durable Object
binding (`ESCAPE_POD_DO` → `EscapePodDurableObject`, SQLite-backed), and
two Cron Triggers (`*/1 * * * *` for the pod-round sweep, `0 0 * * *` for
the daily token-refresh sweep — see `src/durableObject.ts`'s
`runScheduledJob`). `npm run deploy:cloudflare` (`wrangler deploy`) ships
it manually; in practice this only ever runs via CI (below).

## CI/CD

`.github/workflows/ci.yml` runs on every push to `main` and every PR:
`npm ci` (also runs `prisma generate` via `postinstall` — `@prisma/client`
is kept only as a type source for the storage layer's domain types, no
real database anywhere), both `typecheck` configs, lint, `npm test`,
`npm run test:workers`, then `wrangler deploy --dry-run` (validates the
Worker bundles and every binding resolves, no real Cloudflare credentials
needed).

`.github/workflows/deploy-cloudflare.yml` handles the actual deploy —
triggered by `ci.yml` succeeding on `main`, via `cloudflare/wrangler-action@v3`.
Syncs the two real secrets (`DISCORD_BOT_TOKEN`, `TOKEN_ENCRYPTION_KEY`,
via `wrangler secret put`) and deploys.

## Troubleshooting

**`/start-pod` fails to post into a subscribed guild, and/or that guild's
name shows up as a raw ID instead of its display name in the picker.**
Look for these in the Worker's logs (`wrangler tail`):

```
start-pod origin guild lookup failed for <guildId>: DiscordAPIError[10004]: Unknown Guild
start-pod post failed for guild <guildId>: DiscordAPIError[50001]: Missing Access
```

Root cause: that guild's `GuildSubscription` row is stale — the bot was
only ever authorized there with the `applications.commands` OAuth scope
(enough to receive slash-command interactions, which is why
`/escape-pod-setup` and `/unsubscribe-guild` still work fine — neither
calls `discordRest`, see `src/commands/escapePodSetup.ts` /
`unsubscribeGuild.ts`), but never with the `bot` scope, so it has no
actual membership in that server. Anything that needs real presence —
`getGuild`, `postMessage`, and creating the round's chat channel
(`src/discord/podChat.ts`) — fails, while the slash commands themselves
keep working. This is why running `/unsubscribe-guild` then
`/escape-pod-setup` again does **not** fix it: both are pure storage
writes, neither touches Discord's REST API.

There's no automatic detection for this — the bot is REST-only with no
gateway connection (see `src/discord/rest.ts`), so it has no
`GUILD_DELETE`-style signal when it's removed or was never fully added.

Fix: have an admin of that guild re-invite the bot using the same link at
the top of this README ("Invite the bot") — it already requests both
scopes and the right permissions. Safe to run even if slash commands are
already installed there — it only adds the missing `bot`-scope membership
on top. If one guild hit this, it's worth checking whether other
subscribed guilds were added the same (commands-only) way.

## Architecture

A single Worker: verifies and routes Discord interactions (slash
commands, buttons, modals) over a stateless HTTP endpoint
(`src/worker.ts` → the singleton Durable Object's `fetch()`), which hosts
a Hono app (`src/honoApp.ts`) owning all durable state and the Niamos
draft-creation integration. Hosting the Hono app *inside* the DO (not just
storage) is what serializes each entire request — not just the final SQL
write — through the one DO instance, which the atomic signup/round-
numbering compare-and-swap guarantees actually need.

Design rationale lives in [`INTEGRATIONS.md`](https://github.com/aburkhalter512/escape-pod/blob/main/INTEGRATIONS.md) —
start with the "Summary" section at the top, then §7 (bot install & RSVP
flow), §7.3 (data model), §4.1/§4.1.1 (PTP's own API surface and its auth
boundaries — PTP itself has since been dropped entirely in favor of
Niamos, see `src/niamos/client.ts`), and §8 (the account-linking flow,
also since replaced by guild-scoped linking — see `/connect-niamos`
above). Written across this project's earlier history (including an
AWS-hosted, Postgres-backed period before the Cloudflare migration, and
the PTP integration before the Niamos cutover) — treat it as a record of
design reasoning, not a guarantee that every detail matches today's code.

`src/backendClient.ts`'s `BackendClient` interface is what's left of an
even earlier two-service split (a thin Discord-facing edge plus a
separate backend) — Discord command/component handlers call it, and
`LocalBackendClient` satisfies it by calling `src/services/*` directly,
in-process.

## Status

Open work is tracked as [GitHub Issues](https://github.com/aburkhalter512/escape-pod/issues),
not in this README.
