# escape-pod

Escape Pod, a Star Wars: Unlimited draft pod notifier. A single service:
verifies and routes Discord interactions (slash commands, buttons, modals)
over a stateless HTTP endpoint, and owns all durable state (organizers,
guild subscriptions, pod rounds/targets/signups) and the Protect the Pod
(PTP) integration.

Design rationale lives in [`INTEGRATIONS.md`](https://github.com/aburkhalter512/escape-pod/blob/main/INTEGRATIONS.md) —
start with the "Summary" section at the top, then §7 (bot install & RSVP
flow), §7.3 (data model), §4.1/§4.1.1 (PTP's own API surface and its auth
boundaries), and §8 (the account-linking flow).

This used to be two separately-deployed services (a thin Discord-facing
edge plus a separate backend), merged into one to eliminate a redundant
ALB. `src/backendClient.ts`'s `BackendClient` interface is what's left of
that boundary — Discord command/component handlers call it, and
`LocalBackendClient` satisfies it by calling `src/services/*` directly,
in-process (no HTTP, no separate deploy).

## Setup

```bash
npm install
cp .env.example .env   # fill in Discord app credentials, TOKEN_ENCRYPTION_KEY, BOT_API_KEY
npm run register-commands   # registers the /connect-ptp, /subscribe-guild,
                             # /allow-organizer, /start-pod, /cancel-pod
                             # commands globally with Discord
npm run dev
```

`npm run dev` (`scripts/dev.sh`) brings up a local Postgres container
(`scripts/db.sh`, needs a working `docker` or `podman`), applies any
pending migrations, and starts the server in watch mode. The DB container
is left running after you Ctrl+C the server (fast restarts); `npm run
db:down` stops it, `npm run db:destroy` also drops its data.

The interactions endpoint URL (`POST /interactions` on wherever this is
deployed) needs to be registered in the Discord Developer Portal under
"Interactions Endpoint URL" for the application — Discord requires a
real, CA-signed HTTPS endpoint here (no self-signed certs, and no AWS
default `*.elb.amazonaws.com` hostname, since ACM can't issue a cert for
a domain this account doesn't own). See `infra/README.md` for how that
constraint shapes the AWS setup.

The internal HTTP API (`/organizers/*`, `/guilds/*`, `/pods/*`) — kept as
a bearer-protected debug/admin surface even though nothing external calls
it anymore — requires `Authorization: Bearer <BOT_API_KEY>` (see
`src/auth.ts`); `/healthz` and `/interactions` don't.

### Local Postgres

`scripts/db.sh` manages a single `postgres:16` container (`escape-pod-db`,
named volume for persistence) — auto-detects whichever of `docker` or
`podman` is actually running, so it works the same whether you have
Docker Desktop or set up Podman instead (`brew install podman && podman
machine init && podman machine start` — no GUI app required):

```bash
npm run db:up       # create (first time) or start the container, wait until ready
npm run db:down      # stop it, keep its data
npm run db:destroy   # remove the container and its data volume
```

### Migrations

Schema changes are tracked as versioned SQL files in `prisma/migrations/`,
generated from `prisma/schema.prisma`. Two different commands, for two
different situations:

- `npm run prisma:migrate` (`prisma migrate dev`) — local development.
  Diffs your schema against the DB, generates a new migration file for any
  change, and applies it. Never run this against a production database —
  it can prompt to reset the DB if it detects drift.
- `npm run prisma:deploy` (`prisma migrate deploy`) — production/CI, and
  what `npm run dev` applies automatically on startup. Applies whatever
  migrations exist in `prisma/migrations/` that haven't run yet. Never
  generates new migrations or touches existing data beyond what the SQL
  says.

## Container

`Dockerfile` is a two-stage build: the `build` stage installs full deps,
generates the Prisma client, and compiles TypeScript; the `runtime` stage
copies over only the pruned (`--omit=dev`) `node_modules`, `dist/`, and
`prisma/`, and runs as the image's built-in non-root `node` user.
Migrations are **not** run automatically on container start — run `npm
run prisma:deploy` as its own step against whatever `DATABASE_URL` the
target environment provides.

```bash
docker build -t escape-pod .
docker run --rm -p 3000:3000 \
  -e DISCORD_APPLICATION_ID=... -e DISCORD_PUBLIC_KEY=... -e DISCORD_BOT_TOKEN=... \
  -e DATABASE_URL=... -e TOKEN_ENCRYPTION_KEY=... -e PTP_BASE_URL=... -e BOT_API_KEY=... \
  escape-pod
```

## Infrastructure

`infra/` has the OpenTofu (Terraform-compatible) configuration for
running this on AWS — ECS Fargate, an ALB, ECR, RDS Postgres, SSM
Parameter Store for secrets. See `infra/README.md` for the full picture,
including why `domain_name` is currently unset (no domain registered yet,
so the HTTPS listener/ACM cert/Route53 record don't exist until it is).

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR:
`npm ci` (also runs `prisma generate` via `postinstall`), typecheck,
lint, test, build, `npm run prisma:deploy` against a throwaway Postgres
service container (catching a schema change that never got a migration,
or a migration that doesn't actually apply cleanly), then a Docker build
of the image above (build-only — no registry configured, nothing pushed).
No live Discord/PTP calls — same checks as running them locally,
automated.

## Status

Core loop implemented and tested (§7.5): `/start-pod` posts the RSVP embed
+ buttons into every eligible target guild (`src/discord/rest.ts`,
`src/discord/podMessage.ts`) and records each message id; a signup click
updates the clicking guild's message via the interaction response itself
and fans the same update out to every other target guild's message via
REST edit (skipping any target with no recorded message id yet). Account
linking (§8.2-§8.3), guild subscriptions/allowlisting (§7.2), and the full
pod-round lifecycle (§7.5) are implemented and tested; every internal API
route validates its body/params against a Zod schema
(`src/validation.ts`) and 400s on malformed input before touching Prisma
or PTP.

Known gaps — see `../tasks/` for the full tracked list, most relevant
here:

- The cross-guild edit fan-out in `handleMessageComponent`'s `pod-signup:`
  branch is awaited inline before the interaction response is returned —
  fine at the scale this is designed for, but doesn't leave much headroom
  against Discord's 3-second response budget if a round ever fans out to
  dozens of guilds (see the comment in `src/interactions/components.ts`).
- `/organizers/:discordId/eligible-guilds` returns `guildId` as a
  placeholder `name` — guild display names aren't threaded through from
  Discord yet (`src/services/organizers.ts`).
- `src/jobs/refreshTokens.ts` is a job body only — not yet attached to a
  scheduler, and has no way to notify an organizer when refresh fails
  (§8.3's DM fallback).
- `src/commands/cancelPod.ts` is stubbed — doesn't yet call
  `backend.cancelPod`.
