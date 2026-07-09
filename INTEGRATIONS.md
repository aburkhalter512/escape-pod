# Draft Pod Notifier — Integration Research

Status: **Core loop implemented.** `discord-bot/` and `backend/` (sibling
repos, see §3.4) both exist with the RSVP → cross-guild sync → PTP
pod-creation flow built and unit-tested (§6 item 4) — not yet live-tested
against real Discord/PTP. Known gaps from here are tracked as individual
files in `../tasks/`, not in this document; check `tasks/README.md` before
assuming this doc's "next steps" (§6) are the full picture. This document
itself remains the record of *why* things are built the way they are —
research findings and design rationale, not a live status board.

## Summary: the technical approach this document builds toward

Everything below converges on one architecture. This section is the
short version; each claim links to the section that works out *why*.

**What we're building:** a standalone Discord bot service — not a feature
merged into Protect the Pod (PTP) — that collects RSVPs for a draft pod
entirely inside Discord, and only talks to PTP at the very end, to create
the real pod once enough people have committed (§3.4).

**The end-to-end flow:**

1. An **organizer** links their own PTP account to the bot once, via a
   copy/paste token flow (Option B, §8) — not a shared bot account, so pods
   stay correctly attributed to the human who ran them (§3.1).
2. Separately, **guilds opt in independently of any organizer** — a guild's
   own admins install the bot and mark it as accepting LFG broadcasts,
   optionally allow-listing specific organizers (§7.2). This is what lets an
   organizer reach communities they don't personally administer, which is
   the actual pain point being solved (§1).
3. To start a round, the organizer picks one or more guilds they're
   eligible to post to. The bot fans one RSVP post out to all of them at
   once, each with "I'm in" / "Leave" buttons (§7.5).
4. Signups are **deduplicated by Discord user ID across every target
   guild** into one shared counter — clicking in two servers only counts
   once, and all target messages update together (§7.3, §7.5).
5. The moment the shared count hits the organizer's threshold, the bot
   calls PTP's own `POST /api/draft` using the organizer's linked
   credential from step 1, then edits every message with the live pod link
   (§7.5, §4.1.1).

**How it's built technically:** a stateless service reachable only via
Discord's HTTP interactions endpoint (no gateway connection, no privileged
intents needed) — buttons instead of emoji reactions specifically because
that's what makes the stateless design possible (§7.1).

**Where PTP fits, and its rough edges:** PTP has no third-party OAuth flow,
so the organizer-linking step in v1 is manual copy/paste, not a one-click
connect button (§8.1) — a real but bounded piece of friction. Everything
about that friction (manual linking, broad-privilege token custody) is
being intentionally recorded so it becomes the evidence for a later,
better-scoped ask to PTP's maintainer — a purpose-built endpoint the bot
could use instead of per-organizer tokens (Option C, §3.1, §6).

**Explicitly out of scope for v1:** talking to Karabast directly (§4.2) and
melee.gg (§4.3) — neither is required to prove the core loop above.

## 1. Product concept

A Discord bot that lets independent **organizers** rally interest in a Star
Wars: Unlimited draft pod by fanning a single round out across **multiple
Discord servers at once**, with signups aggregated toward one shared
threshold — not one organizer per server. This is core to the problem being
solved: getting a full 6-8 person pod from one community alone is often
hard, so organizers routinely reach beyond their own server into sister
communities they don't necessarily administer. Signups happen **inside
Discord** (click a button to say "I'm in," not a link out to a website), and
once a round hits its threshold, the pod is created and every target server
is notified. Supporting tools: **Protect the Pod** (draft/pod orchestration)
and **melee.gg** (tournament tracking). Karabast is also in the picture as
the actual 1v1 gameplay client used downstream of a draft.

## 2. The ecosystem, as it actually exists

Three independent projects are relevant, each with a distinct role. None of
this was previously documented anywhere we could find outside their source —
it was reconstructed by reading each project's repo directly.

| Project | Role | Repo |
|---|---|---|
| **Protect the Pod (PTP)** | Owns the draft pod itself: pod creation, roster, Swiss rounds/pairings, game slots, lobby lifecycle, results, standings | github.com/ledwards/swupod |
| **Wayfinder Companion** | Browser extension that owns Karabast automation: opens Karabast, creates/joins the private lobby, reports match lifecycle/results back to PTP | sibling repo, not public in `swupod` (referenced as `wayfinder.news` / `plugin.wayfinder.news`) |
| **Karabast** | The actual 1v1 gameplay client (leader/base decks, Bo1/Bo3). Where a match is physically played once two drafted players are paired | github.com/SWU-Karabast/forceteki (backend), forceteki-client (web) |
| **melee.gg** | Tournament/results platform, used for organized play tracking outside the draft-pod flow | melee.gg (closed source) |

Key relationship: **a draft pod lives entirely in PTP.** PTP hands off to
Karabast only for the moment-to-moment gameplay of an individual paired
match, via Wayfinder as the automation glue in between.

## 3. Product shape and the build-vs-standalone decision

This section works through *where this thing should live* — as a feature
merged into PTP, or as its own bot — now that the product shape is more
specific than "post a notification."

### 3.1 Organizer identity model — decided: phased B → C

Each organizer brings their own Discord server(s); PTP (or our bot) doesn't
hardcode a guild list. That means the bot needs, per organizer, a notion of
*who the organizer is on PTP* — because the thing being created at the end
(a PTP pod) belongs to a PTP user account, not a Discord identity. Three
options were evaluated:

**Option A — one shared bot/service PTP account.** The bot logs in once as
its own dedicated account and creates every pod under that identity.
Simplest to build, zero per-organizer friction, but every bot-created pod
shows the *same* host on PTP — the real organizer loses host-only powers
(cancel, settings — `DELETE /api/draft/:shareId` checks
`host_id === session.id`) on PTP's own site unless they route everything
through the bot. Also concentrates risk: one account/token controls pods
for every organizer across every server. **Ruled out** — breaks host-side
control for organizers, which is core to the multi-organizer premise.

**Option B — each organizer links their own PTP account (chosen for now).**
PTP already has a **self-serve token-exchange flow that requires no
maintainer involvement**: `GET /api/auth/token` mints a 30-day `Bearer` JWT
for whoever is logged in (`app/api/auth/token/route.ts`, "requires cookie
session... for API usage"), and PTP already supports Discord OAuth login
(`app/api/auth/signin/discord`, `app/api/auth/callback/discord`). So an
organizer can log into protectthepod.com with the same Discord identity
they already use, hit `/api/auth/token`, and hand that token to our bot
during a one-time setup step. The pod's `host_id` is then genuinely the
organizer's own account — correct attribution, full host powers retained on
PTP directly. Cost: the token is a **general-purpose account credential**
(same scope as `requireAuth()` everywhere, not limited to pod creation) and
expires in 30 days, so our bot ends up custodying a broad-privilege secret
per organizer — a real liability if our storage is ever compromised — and
needs a re-linking/refresh story for expiry.

**Option C — a scoped private endpoint (the target end state).** Pitch
`ledwards` on something like `POST /api/private/create-pod`, gated by
`requireServiceKey()`, taking a `discord_id` parameter — mirroring the
existing `GET /api/private/user-data?discord_id=` pattern, auto-provisioning
a PTP account for that Discord user if one doesn't exist yet. Best security
posture (one narrowly-scoped service key, no per-organizer credential
custody) and best organizer UX (they never touch protectthepod.com at all).
Same correct attribution as B. The catch: doesn't exist today, so it's
entirely dependent on the maintainer building and shipping it.

**Decision: build against Option B first, then pitch Option C.** B is the
only option we can start on immediately without waiting on anyone, since
the token-exchange flow is already self-serve — it lets us prove the actual
RSVP → create-pod flow end to end before asking `ledwards` for anything. If
the bot gets real usage, take a concrete "here's what we built, here's the
credential-custody problem B creates for our users, would you support a
scoped endpoint instead" pitch to `ledwards` for Option C — a much stronger,
evidence-backed ask than requesting it speculatively up front.

### 3.2 In-Discord RSVP is a bigger build than "post and link out"

We initially assumed Discord's role was just an announcement with a link
back to PTP to join. The actual requirement is **RSVP inside Discord** —
users react or click a button without leaving the app. That changes what
kind of thing this is:

- It requires a **real Discord bot installed into each organizer's server**
  via the OAuth "Add to Server" flow (not just a webhook URL an organizer
  pastes in) — webhooks are send-only and cannot receive interactions.
- It requires a live **interactions endpoint or gateway connection** to
  receive and respond to button clicks/reactions within Discord's ~3-second
  response window.
- It requires **per-guild install/config state** (which channel, which
  role(s) to ping, per-organizer settings) tracked over time, including
  handling install/uninstall and Discord's bot-verification requirements
  once past 100 servers.
- It needs the same result stated differently: this is a distinct **runtime
  and operational surface** from PTP's existing Discord integration.
  `lib/discordLfg.ts` (§4.1.2) only ever *sends* — one bot token, one fixed
  server, no interaction handling, no per-guild anything. Interactive,
  multi-tenant RSVP is a different capability class, not a bigger version of
  what's already there.

### 3.3 A data-model wrinkle: RSVP happens upstream of anything PTP models today

PTP's `pods` table represents an **already-active** draft lobby — created
with a host and at least one player the moment `POST /api/draft` succeeds
(§4.1.1). There is no PTP concept of "still gauging interest, nothing
committed yet." But that pre-commitment phase — reactions trickling in
toward a threshold, with no pod yet — is the actual core of this product.

So the bot's real loop is: **collect reactions → hit the organizer's
threshold → only then call `POST /api/draft` to create the pod.** The
interest-gathering state lives entirely outside PTP (in the bot's own
storage) right up until the threshold is hit. PTP only enters the picture at
the very last step.

### 3.4 Recommendation

Given §3.2 and §3.3, this leans back toward being **its own bot service**,
regardless of who ends up maintaining or hosting it long-term:

- The interest-gathering/RSVP layer has no PTP equivalent to merge into —
  there's no existing multi-tenant, interactive Discord surface in `swupod`
  to extend, unlike the (wrong, earlier) assumption that this could ride on
  `discordLfg.ts`.
- Discord bot installation, interaction handling, and per-guild state are a
  different engineering surface (a persistent service handling Discord's
  gateway/interactions API) than PTP's Next.js request/response app — even
  if the same team built both, they're not naturally the same deployable.
- It's still worth raising with PTP's maintainer (`ledwards`) — not to ask
  "can I merge this into your app," but "would you grant a separate bot
  service the ability to create a pod on a user's behalf once our threshold
  is hit," which is a much smaller ask than before and doesn't require them
  to take on Discord bot-install/verification scope themselves.

## 4. Integration points, by system

### 4.1 Protect the Pod — primary integration target

PTP already has a **server-to-server Private API**, separate from normal
user login, that looks purpose-built for exactly this kind of bot:

- Auth: `Authorization: Bearer <PTP_SERVICE_KEY>` (shared service key, not
  OAuth, not user sessions).
- `GET /api/private/user-data?discord_id=<snowflake>` — PTP accounts are
  **already linked to Discord IDs**. Returns a user's pools, built decks,
  and draft-pick history, including pod metadata: `shareId`, `status`,
  `playerCount`, `setCode`, `name`.
- Response shape returns `{success, data: {user, pools, builtDecks,
  draftPicks}, message}`. If the Discord user has no PTP account, it's a
  200 with null/empty fields, not a 404.
- Documented in `docs/PRIVATE_API.md` in the `swupod` repo, including how to
  add new private endpoints — implying the maintainer is open to extending
  this surface for new trusted integrations.

**Gap:** this endpoint answers "what has this Discord user done on PTP,"
not "notify me when pod X reaches N players." No push/webhook mechanism was
found.

**Access model:** the Private API is currently scoped to one approved
consumer ("SWUTeam"). It is **not self-serve** — a new service key has to be
issued by the maintainer (GitHub user `ledwards`).

#### 4.1.1 The service key does NOT unlock the normal pod CRUD routes

PTP has a second, separate route family under `app/api/draft/` (`POST
/api/draft` to create a pod, `GET /api/draft/:shareId` to read one, plus
`join`/`leave`/`start`/`state`/etc. under `[shareId]/`). Read directly from
`lib/auth.ts` and the route handlers to confirm which auth applies where:

| Endpoint | Auth function | What it accepts |
|---|---|---|
| `POST /api/draft` (create pod) | `requireAuth()` | `swupod_session` cookie, or `Bearer <token>` where `<token>` must be a **JWT signed with the app's `JWT_SECRET`** (minted only at real user login) |
| `DELETE /api/draft/:shareId` | `requireAuth()` | same as above |
| `GET /api/draft/:shareId` (read pod) | `getSession()` (optional — not enforced) | same JWT/cookie check, but **falls through to an anonymous read if absent** — see below |
| `app/api/private/*` (e.g. `user-data`) | `requireServiceKey()` | `Bearer <PTP_SERVICE_KEY>` only, a completely separate secret |

`requireAuth`'s Bearer-token branch and `requireServiceKey` are two
different functions checking two different secrets. **A `PTP_SERVICE_KEY`
would not pass `requireAuth`** — `verifyToken()` would reject it as an
invalid JWT and the call would 401. So: **a private API key would let us
call the private endpoints, but would not let us create, join, or delete
pods via `app/api/draft/*`.** Doing that programmatically would require
either a real logged-in bot/service PTP account (JWTs are minted through
actual login; `discord_id` is a first-class field on PTP's `User` type, so
Discord OAuth login is presumably how a bot account would authenticate), or
the maintainer adding a new service-key-gated pod-creation endpoint — which
does not currently exist. This is exactly the capability §3.4 proposes
asking `ledwards` to grant.

**Notable exception found by reading the code:** `GET /api/draft/:shareId`
calls the *optional* `getSession()`, not `requireAuth()`. An anonymous
request (no cookie, no Bearer token) still gets a 200 with full pod state —
`status`, `currentPlayers`, `maxPlayers`, the full player roster, etc. —
just with `isHost`/`isPlayer`/`myPlayer` coming back `false`/`null`. In
other words, **querying a specific pod's live status currently requires no
credentials at all**, service key or otherwise, as long as the `shareId` is
known. This is useful for confirming a pod was created successfully after
our bot calls create, but it's not documented as a stable public contract —
it's just how the route happens to be written today, and could be locked
down without notice. Don't build a production dependency on it without
asking the maintainer to confirm it's intended to stay open.

#### 4.1.2 PTP already has a single-server Discord LFG bot — not a conflict, but relevant prior art

`lib/discordLfg.ts` shows PTP runs its own Discord bot today: when a public
pod is created, `postPodCreated()` posts an embed to fixed channels
(`DISCORD_DRAFT_NOW_CHANNEL_ID`, `DISCORD_SEALED_NOW_CHANNEL_ID`, etc., read
from env vars) using one hardcoded `DISCORD_BOT_TOKEN`, and later calls
`markPodCancelled()` / `deletePodMessage()` to keep that message in sync as
the pod's state changes. The `pods` table even stores
`discord_message_id` / `discord_thread_id` / `discord_webhook_id` /
`discord_webhook_token` columns per pod.

This is **single-tenant and send-only** — no per-guild configuration, no
interaction handling, no loop over multiple Discord servers anywhere in the
file. It always posts to one fixed server. This confirms multi-organizer,
interactive RSVP is a genuine product gap PTP doesn't fill (and, per §3.4,
isn't natural to retrofit into this particular code path either — it's a
different capability class, not a config change on this bot).

### 4.2 Karabast — likely not a direct dependency

Karabast (`forceteki`) exposes a real Express + Socket.IO API
(`POST /api/create-lobby`, `GET /api/available-lobbies`, `POST
/api/join-lobby`, `POST /api/enter-queue`, `GET /api/ongoing-games`) with
auth that falls back to an auto-created anonymous user when no session
cookie is present.

However, per PTP's own `WAYFINDER_PLUGIN_LIVE_SWISS.md`, **Karabast lobby
creation is explicitly Wayfinder's responsibility, not something PTP or
third parties are expected to drive directly** — PTP posts a
`window.postMessage` intent, Wayfinder's browser extension does the actual
Karabast automation, then reports back. There's no evidence PTP or any
sanctioned integration calls Karabast's API server-to-server.

**Implication:** the Discord bot almost certainly should not talk to
Karabast directly. If a notification needs to include a game/lobby link,
that link should come from PTP's pod state (which Wayfinder has already
written into it), not from the bot creating a Karabast lobby itself.

No documented public base URL, rate limits, or third-party bot policy exist
for Karabast's production instance — another reason to stay one layer above
it.

### 4.3 melee.gg — secondary, currently deferred

melee.gg has a documented REST API (Swagger UI at
`melee.gg/swagger/ui/index`), but:

- Access is granted per-organization, not self-serve — requires emailing
  `contact@melee.gg` and being issued a client ID/secret.
- No confirmed webhook support was found; integration would likely mean
  polling the tournament-list endpoint.

Given the pod-notification use case doesn't strictly need melee.gg (it's a
post-draft tournament-tracking tool), this integration can reasonably be
deferred to a v2, after the core PTP-driven flow is validated.

### 4.4 Discord — no open questions on capability, but real scope

Discord itself isn't a blocker technically — bot install (OAuth), slash
commands, interactive components (buttons/reactions) for RSVP are all
well-documented, standard capabilities (discord.js or discord.py). The open
questions are the ones raised in §3: whose PTP account creates the pod, and
how organizer-to-guild config is stored and managed.

## 5. Current blockers

1. **No PTP Private API access.** Hard blocker for the `user-data`
   Discord-ID lookup and, later, for pitching Option C (§3.1) — a
   `PTP_SERVICE_KEY` has to be issued by `ledwards`. Not required to start
   building against Option B.
2. **Per-organizer PTP account linking (Option B) isn't built yet.** Not
   blocked on anyone — the underlying `/api/auth/signin/discord` +
   `/api/auth/token` flow is self-serve today (§3.1) — but our bot still
   needs the setup UX (organizer connects their account) and secure storage
   for the resulting 30-day tokens, plus a re-linking/refresh story for
   expiry.
3. **Token custody is a real security surface for v1 (Option B).** Tokens
   from `/api/auth/token` carry full `requireAuth()` account privileges, not
   just pod-creation — our bot's storage becomes a high-value target for as
   long as we're on Option B. This is the main reason Option C is the
   target end state, not just a nice-to-have.
4. **No confirmed *stable* way to query "did pod creation succeed."**
   `GET /api/draft/:shareId` currently answers this with zero auth, but
   it's undocumented as a public contract (§4.1.1).
5. **melee.gg access is also gated** (org approval + manual key issuance),
   should the roadmap later require it.
6. **No production Karabast API policy documented** — irrelevant if we stay
   above Karabast per §4.2, but worth flagging in case that assumption
   changes.

## 6. Next steps

1. ~~Build the Option B account-linking flow~~ — **designed, see §8.**
   `/connect-ptp` → modal paste → structural + anti-mistake + live
   validation (`GET /api/me/drafts`) → encrypted storage. No permission
   from `ledwards` needed; can be implemented immediately.
2. ~~Design secure token storage~~ — **designed, see §8.5** (encryption at
   rest) **and §8.3** (background refresh via `/api/auth/refresh`'s
   `Set-Cookie` response, sweeping tokens nearing `expires_at`, with a DM
   fallback if refresh fails).
3. ~~Design the RSVP/interest-gathering data model~~ — **built**, in
   `backend/prisma/schema.prisma`, mirroring §7.3 field-for-field.
4. ~~Ship and validate the full loop on Option B~~ — **implemented and
   unit-tested end to end**: `/connect-ptp` → `/start-pod` (posts the RSVP
   embed to every target guild, records each message id) → signup clicks
   (dedupe, cross-guild count sync, `POST /api/draft` on threshold) →
   pod-full embed with a join link. 87 discord-bot + 64 backend tests,
   both repos typecheck and build clean. **Not yet done:** an actual live
   run against real Discord and real PTP — everything so far is unit-level
   with mocked Discord/PTP/Prisma, deliberately (see `tasks/` for what's
   still open, notably `tasks/001` — a real concurrency gap only a live or
   integration test would catch).
5. **Once there's real usage to point to, take the Option C pitch to
   `ledwards`**: a scoped `POST /api/private/create-pod`-style endpoint
   keyed by `discord_id`, framed around the token-custody problem Option B
   creates for organizers (§3.1, §3.4) — not a request to merge Discord
   multi-tenancy into their app.
6. **Scope melee.gg out of v1** — revisit after the core RSVP → create-pod
   flow is validated.
7. ~~Design the Discord bot install flow itself~~ — **done, see §7**, and
   the `GuildSubscription`/`PodRound` schema is built. Still outstanding,
   as actual deployment/ops steps rather than code: compute the real
   OAuth2 install-link permission integer, and register the interactions
   endpoint URL + Ed25519 public key in the Discord Developer Portal.

## 7. Discord bot install & RSVP flow design

### 7.1 Interaction architecture: HTTP endpoint, no gateway, buttons not reactions

Discord delivers interactions (slash commands, button clicks) one of two
ways: a persistent WebSocket gateway connection, or a stateless HTTP
endpoint Discord POSTs to directly (verified via `X-Signature-Ed25519` /
`X-Signature-Timestamp` headers, must respond within 3 seconds or use a
deferred response + follow-up webhook, valid for 15 minutes). The two are
mutually exclusive per app — whichever is configured handles all
interactions.

Gateway is only required for things we don't need: reading raw message
content, presence, or **raw emoji reaction events** (`MESSAGE_REACTION_ADD`
is gateway-only). **Decision: use the HTTP interactions endpoint, and use
message-component buttons ("I'm in" / "Leave") instead of emoji reactions**
for RSVP. This means the whole bot can be a stateless service with no
long-running process, and — since we touch none of the three privileged
intents (message content, server members, presence) — we never need
privileged-intent review at all, regardless of scale (confirmed against
Discord's 2026 developer docs: privileged intents now gate at 10,000 *users*,
but that's moot here since we don't request any).

One real scale milestone regardless: **bot verification still triggers at
100 servers** (unchanged in 2026) — not a v1 concern given organizer
onboarding will be gradual, but worth planning for once the guild-opt-in
network (§7.2) grows.

### 7.2 Fan-out model: guild opt-in network, decoupled from organizer identity

Decided: a guild's participation is **independent of any specific
organizer**. A guild's own admins install the bot and opt their server in
once ("we accept LFG broadcasts here"); any organizer who has linked their
PTP account (§3.1, Option B) can then choose, per round, which eligible
guilds to fan out to. This deliberately decouples "who installed the bot in
guild X" from "who can post rounds into guild X" — it's what makes
reaching sister communities an organizer doesn't administer actually work,
rather than requiring them to personally hold Manage Server everywhere they
want to post.

That decoupling needs a trust guardrail, since it otherwise lets a stranger
post into a server they don't run. Each guild subscription carries a
**posting policy**:

- **`allowlist` (default)** — the guild's admin explicitly approves specific
  organizers (via `/allow-organizer`) before their rounds can post there.
  Safer default for a niche community where most guilds won't want
  unmoderated third parties posting on day one.
- **`open`** — any organizer with a linked PTP account may target this
  guild. An opt-in for high-trust hub servers (e.g. a general SWU-community
  server that explicitly wants to maximize reach).

### 7.3 Data model

- **Organizer** — `discord_id`, encrypted PTP token (§3.1 Option B), linked
  at.
- **GuildSubscription** — one row per guild that has installed the bot and
  opted in: `guild_id`, `installed_by_discord_id` (the guild's own admin who
  ran setup — not necessarily an organizer), `broadcast_channel_id`,
  `posting_policy` (`allowlist` default, or `open`), `installed_at`.
- **GuildOrganizerAllowlist** — `guild_id`, `organizer_discord_id`,
  `approved_by`, `approved_at`. Only consulted when the guild's policy is
  `allowlist`.
- **PodRound** — one RSVP round: `id`, `organizer_discord_id`, `set_code`,
  `threshold`, `status` (`collecting` / `threshold_reached` / `pod_created`
  / `cancelled` / `expired`), `ptp_pod_share_id` (set once created),
  `created_at`.
- **PodRoundTarget** — which guilds a round was fanned out to, one row per
  (round, guild): `pod_round_id`, `guild_id`, `channel_id`, `message_id`,
  `posted_at`. If the guild required approval, also tracks
  `approval_status`.
- **PodRoundSignup** — the actual RSVP records: `pod_round_id`,
  `discord_id`, `username_snapshot`, `source_guild_id` (which server's
  button they clicked, for stats only — not authoritative for identity),
  `status` (`in` / `left`), `signed_up_at`.

**Key invariant:** the threshold check counts **distinct `discord_id`s with
status `in` across the entire round**, not per guild. Someone who sees the
post in two different servers and clicks both still counts once. This is
the mechanic that makes "fan out to multiple guilds toward one shared goal"
actually work as described in §1.

### 7.4 Commands

| Command | Run by | Effect |
|---|---|---|
| `/connect-ptp` | Any organizer | Option B account-link flow (§3.1) |
| `/subscribe-guild` | A guild's own admin, in their guild | Installs this guild as a broadcast target: picks channel, sets `posting_policy` (default `allowlist`) |
| `/allow-organizer <user>` | A guild's own admin | Adds an organizer to this guild's allowlist |
| `/start-pod <set> [threshold]` | A linked organizer | Presents a select menu of guilds this organizer is eligible to target (open-policy guilds + guilds where they're allow-listed), then fans the round out to the chosen guilds |
| `/cancel-pod` | The round's organizer | Cancels an in-progress round across every target guild's message |

**Scale note:** Discord string-select components cap at 25 options. If an
organizer becomes eligible for more than 25 guilds, `/start-pod`'s guild
picker needs pagination or a "target all" shortcut rather than a flat list
— not a v1 concern, but worth remembering before hardcoding a single select
menu.

### 7.5 Round lifecycle

1. Organizer runs `/start-pod`, picks target guilds from the eligible list.
2. Bot posts one RSVP embed + "I'm in"/"Leave" buttons per target guild's
   configured channel, recording a `PodRoundTarget` row (and message ID)
   for each.
3. Each button click is an interaction handled over HTTP: record/update a
   `PodRoundSignup`, recompute the distinct-signup count for the whole
   round, then **edit every target message across every guild** to show the
   updated shared count (e.g. "5/8 confirmed") — this is the cross-guild
   sync work implied by §7.3's shared counter.
4. When distinct signups hit `threshold`: call PTP's `POST /api/draft`
   using the organizer's Option B token (§3.1), store the resulting
   `shareId` as `ptp_pod_share_id`, edit every target message to show "Pod
   full — draft starting: `<link>`", and lock further signups.
5. If the organizer cancels first, edit every target message to reflect
   that instead and mark the round `cancelled`.

### 7.6 What's deliberately deferred

- Waitlist/overflow handling once threshold is hit but more people click.
- Guild discovery UX beyond a flat eligible-guilds list (e.g. browsing
  `open`-policy guilds before being allow-listed anywhere).
- Anything requiring the DM/user-install interaction context — the design
  above works entirely within standard per-guild interaction context, so it
  doesn't depend on that surface at all.

## 8. PTP account-linking (Option B) setup flow

### 8.1 Why this can't be a slick "Connect account" button

PTP has first-party Discord login (`/api/auth/signin/discord`) and a
cookie-gated token export (`/api/auth/token`), but **no OAuth/consent flow
for third-party applications** — no client registration, no redirect_uri
allow-list, no consent screen that could hand a token straight to our bot.
That kind of integration is what Option C (§3.1) would eventually look
like. Today, Option B is necessarily **organizer-driven copy/paste**: they
retrieve a token from their own PTP browser session and manually give it to
our bot. Worth setting that expectation honestly rather than designing
around a redirect flow that doesn't exist yet.

### 8.2 Step-by-step flow

1. Organizer runs `/connect-ptp`. Bot responds **ephemerally** with:
   - A link to sign in if needed: `https://www.protectthepod.com/api/auth/signin/discord`
     (same Discord identity they're already using — low friction if they're
     already logged into Discord in-browser).
   - A link to fetch the token: `https://www.protectthepod.com/api/auth/token`
     (returns raw JSON: `{token, expiresIn: '30d', usage: ...}`).
   - A **"Paste your token" button** that opens a Discord **modal** (a
     private text-input dialog) rather than asking them to paste it as a
     visible slash-command argument — keeps the token out of channel/command
     history.
2. Organizer copies the `token` value from the JSON response, returns to
   Discord, clicks the button, pastes into the modal, submits.
3. Bot validates the submitted token in layers, **before** storing anything:
   a. **Structural** — is it a well-formed 3-segment JWT?
   b. **Decode (unverified)** — read the payload for `discord_id`,
      `username`, `exp`. This is *not* cryptographic verification (we don't
      have PTP's `JWT_SECRET` and shouldn't try to obtain it) — it's only
      for the next check and for display.
   c. **Anti-mistake check** — the decoded `discord_id` must equal the
      Discord user ID of whoever ran `/connect-ptp`. Reject with a clear
      message ("this token belongs to a different Discord account")
      otherwise. Cheap and catches the obvious failure mode of someone
      pasting the wrong token.
   d. **Live check** — call `GET /api/me/drafts?limit=1` with
      `Authorization: Bearer <token>`. This route exists in `swupod`
      (`app/api/me/drafts/route.ts`), is `requireAuth()`-gated (accepts
      Bearer), read-only, and returns the caller's own pods — a genuinely
      low-stakes way to confirm PTP actually accepts the token right now,
      catching anything the structural/decode checks can't (revoked,
      tampered, or already-invalidated tokens).
4. On success: encrypt the token at rest, store an `Organizer` row
   (`discord_id`, encrypted token, `username`, `expires_at` from the
   decoded `exp`, `linked_at`), and confirm ephemerally: "Linked as
   **{username}** ✅ — you can now run `/start-pod`."
5. On any failure: ephemeral error naming exactly what to fix. Nothing is
   stored on a failed attempt.

### 8.3 Keeping the link alive without monthly manual re-linking

Tokens expire in 30 days. Making organizers manually repeat §8.2 every
month would be a real retention risk (silent failures at the worst possible
moment — pod-creation time, in front of everyone who just signed up).
`app/api/auth/refresh/route.ts` offers a way around this:
`POST /api/auth/refresh` accepts `Authorization: Bearer <token>` (via the
same `getSession()` used everywhere), re-reads fresh user data, and mints a
new token via `setSession()` — **but delivers it only as a `Set-Cookie`
header**, not in the JSON body (which just returns `{success, data: {user}}`).
Our bot isn't a browser, but it can still read response headers directly, so
it can call this endpoint with the organizer's current token shortly before
`expires_at` and pull the new JWT out of `Set-Cookie` to rotate the stored
credential — no organizer action needed.

**Caveat, stated plainly:** this route's name and JSON response describe it
as session-cookie refresh, not a documented Bearer-token-refresh API. Using
it this way works based on reading the current code, but it isn't a
published contract PTP has committed to — same category of caveat as the
unauthenticated `GET /api/draft/:shareId` read in §4.1.1. Treat scheduled
refresh as a bot-side background job (e.g. daily sweep for tokens expiring
within the next few days), and keep a DM-based "please run `/connect-ptp`
again" fallback for the cases where refresh fails (token already expired,
account state changed, or PTP changes this behavior).

### 8.4 Operational note: rate limiting

`GET /api/me/drafts` runs through `applyRateLimit()` in PTP's own code —
other endpoints likely do too. The link-time validation call and the
periodic refresh sweep are the only places §8 calls PTP proactively; keep
both infrequent and batched sensibly (link time once, refresh once per
organizer per expiry cycle) rather than any kind of polling. This matters
more than usual under Option B, since we're operating without `ledwards`'s
explicit awareness of our traffic.

### 8.5 Security posture recap

- Token encrypted at rest (required v1 scope per §5, blocker 3 — this
  design is what actually implements that requirement).
- The `discord_id` cross-check in §8.2(c) is a mistake-guard, not a security
  boundary — the real boundary is that the token only works because PTP
  itself accepts it.
- We never attempt to verify the JWT signature ourselves; trust is
  established solely by the token succeeding against PTP's live API, both
  at link time (§8.2d) and at actual use time (pod creation).
- Every piece of friction and risk in this section — manual copy/paste,
  broad-privilege token custody, an unofficial refresh-via-cookie-header
  technique — is concrete ammunition for the Option C pitch in §3.1/§6.

## 9. Sources

- Protect the Pod: github.com/ledwards/swupod (`docs/PRIVATE_API.md`,
  `docs/WAYFINDER_PLUGIN.md`, `docs/WAYFINDER_PLUGIN_LIVE_SWISS.md`,
  `docs/DRAFT_BOT_STRATEGIES.md`, `lib/auth.ts`, `lib/discordLfg.ts`,
  `app/api/draft/route.ts`, `app/api/draft/[shareId]/route.ts`,
  `app/api/auth/token/route.ts`, `app/api/auth/refresh/route.ts`,
  `app/api/me/drafts/route.ts`), live at protectthepod.com
- Karabast backend: github.com/SWU-Karabast/forceteki
  (`server/gamenode/GameServer.ts`, `server/middleware/AuthMiddleWare.ts`)
- melee.gg API docs: melee.gg/swagger/ui/index, melee.gg/Policy/Api,
  help.melee.gg/docs/api-use
- Discord developer docs: docs.discord.com/developers/topics/oauth2 (bot
  authorization flow), docs.discord.com/developers/docs/interactions/overview
  (HTTP vs gateway interactions), support-dev.discord.com articles on
  privileged-intent and bot-verification thresholds (confirmed current as
  of 2026: privileged intents gate at 10,000 users, bot verification
  unchanged at 100 servers).
- Research conducted 2026-07-08.
