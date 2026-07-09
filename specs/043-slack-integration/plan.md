# 043 — Slack integration: `hadrontool-slack` + command dispatch

Status: **planned** (design converged 2026-07-09, Holger + Claude). Decision
record: `hrn:node:hadronmemory.com::hadron-server::reference:hadrontool-slack`.
Pattern precedent: `hadrontool-telegram` (spec 042, #592) — this is the fourth
application of the capability-tool pattern. 043 covers the command *surface*
(search + task-run) and the chat *bridge* — which 042 designed for Telegram —
on provider-neutral core models (decisions 8–9). **The bridge is the priority
and ships first** (Phase 3, right after the plumbing); search and task-run
follow in Phases 4–5.

## Goal

Slack as a **command surface** for Hadron — never as the source of truth:

1. **Search**: a Slack user runs `/hadron find <query>`; Hadron searches the
   memories that user can read and posts the results (names, abstracts,
   portal links) back into the channel/thread.
2. **Run a task**: `/hadron task <query>` finds runnable task nodes
   (`Node.isRunnable`, the spec-038 predicate) accessible to the user,
   presents the candidates as an interactive pick list, and on selection
   triggers a **spec-040 headless AppRun**; the run's result posts back to
   the same channel/thread when it completes.

3. **Chat bridge** (added 2026-07-09 — "Slack first"): an agent team chat
   (the existing chat-memory protocol) is mirrored bidirectionally into a
   Slack channel, so humans participate natively while agents keep using
   `hadron chat read`/`post` unchanged. This is the 042 Phase-4 scenario;
   it ships on Slack first because Micromentor — the pilot customer —
   already lives in Slack. The chat memory stays the agents' plane and the
   durable record; Slack is the humans' mirror.

Capabilities 1–2 are gated by a verified Slack-user → Hadron-user binding;
searches and runs execute with *that user's* access through the existing
shared gates. Capability 3 is configured per channel by the owning App's
org admins and needs **no user bindings** (like 042's consumer 3, channel
membership is the human-side trust boundary) — and it is the
highest-value piece (the Micromentor team chat), so it ships first after
the plumbing (Phase 3).

## Decisions (2026-07-09, Holger)

1. **One Slack app per workspace, not per Hadron App.** Deliberate divergence
   from telegram decision 2: Telegram bots cost 30 seconds in BotFather, so
   bot-identity ⇒ App-routing was free; each Slack app is a dev-portal
   artifact (manifest, scopes, tokens, install). For command-driven search +
   task-run, bot identity carries no routing weight. A connection = one
   workspace install of the single "Hadron" Slack app. **The tool stays
   granularity-agnostic** (a connection is just tokens + identity, exactly
   like 042) — which Hadron App serves a command is a core-side resolution
   (`defaultAppId` on the connection; per-channel override is a later
   binding row, not a redesign). Per-App Slack apps (persona DMs, "DM
   @Iris") remain possible later without touching the tool.
2. **Socket Mode in v1.** Slack's no-public-ingress transport: the tool opens
   an outbound WebSocket (`apps.connections.open` → wss URL), so there is no
   Traefik/DNS/public-route surface — the same posture that made telegram's
   long-polling the v1 choice. Slash commands and Block Kit interactivity
   both arrive over the socket. Known ceiling: Slack disallows Socket Mode
   for Marketplace-distributed apps, so a public directory listing later
   forces the Events-API flip — which is a per-connection config change
   (HTTP receiver + signing-secret verification), not a redesign; same
   shape as telegram's planned webhook flip.
3. **`@slack/socket-mode` + `@slack/web-api`, no Bolt.** Telegram's raw-fetch
   decision (042 #4) was about plain request/response HTTPS; Slack's Web API
   is equally plain but Socket Mode is a stateful envelope/ack/reconnect
   protocol that is real lifecycle code to hand-roll. The two focused
   official packages handle exactly that; Bolt is rejected — it wants to own
   the app shape our Express scaffold already provides.
4. **Task execution = spec-040 headless AppRun.** Discovery via the canonical
   `isRunnable` predicate scoped to the bound user's accessible memories;
   the run gets the task + Slack context (who asked, where the answer goes)
   as input; run budgets and quotas apply unchanged. Precedent: 042's
   DM→AppRun consumer.
5. **The tool is Hadron-blind** (standing capability-tool boundary, 042 #6 —
   now four-for-four). No core tables, no core API. Tool→core = the
   normalized events ingress only; core→tool = `/ops/*` only. Neither
   capability lives in the tool: the tool **persists the envelope, acks
   Slack within the 3-second window, then forwards** the normalized event
   (see the socket worker below — an ack without a durable record would
   silently drop commands on a crash, since Slack never retries an acked
   envelope), and later delivers whatever message core tells it to. When an
   op needs Hadron context, core passes it in — invert, don't query.
6. **Sender binding is mandatory, token-bind v1.** Slack workspaces are
   membership-gated (unlike publicly discoverable Telegram bots), but Hadron
   is multi-tenant: a `slackUserId` proves nothing about Hadron identity.
   Same flow as 042 #3: core mints a single-use, short-TTL (10 min),
   hashed-at-rest token; the user redeems it with `/hadron link <token>`.
   Commands from unbound users get exactly one ephemeral reply: how to
   link. Verified-email auto-match (`users:read.email`) is a possible later
   convenience, not the v1 floor.
7. **Neutral message shape; the tool renders Block Kit.** Core never emits
   Block Kit JSON (that would couple core to Slack). Ops accept a small
   provider-neutral shape — `text` (markdown subset) plus optional
   `choices[]` — and the tool translates to mrkdwn / Block Kit buttons or a
   static select. This is the one place the ops surface grows beyond 042's,
   because task-pick needs interactivity.
8. **Slack ships the chat bridge first; the core bridge is provider-neutral.**
   (Holger, 2026-07-09.) Micromentor is the pilot customer and lives in
   Slack, so the 042 Phase-4 bridge lands here first. The binding models and
   sweep worker are built provider-neutral (`ChatBinding` /
   `ChatParticipant`, provider-dispatched sends) with Slack as the first
   consumer; 042's Telegram group bridge becomes a thin second adapter on
   the same models. Three Slack-specific deltas vs the 042 design:
   - **Per-agent identity comes free.** `chat.postMessage` with
     `chat:write.customize` accepts per-message `username`/`icon_url` — every
     agent gets its own face through the one workspace bot. 042's
     per-participant `sendViaConnectionId` machinery is unnecessary on
     Slack; the participant row carries a display identity instead.
   - **Loop prevention must be explicit.** Slack bots DO receive their own
     and other bots' messages (unlike Telegram's platform rule) — the
     inbound consumer skips events carrying the connection's own bot
     identity, plus the `data.source: 'slack'` provenance skip. NB: Slack
     issues a bot TWO distinct ids — the `bot_id` (`B…`) carried on bot
     message events and the bot's user id (`U…`) from `auth.test` — so the
     connection stores **both** (`botId` + `botUserId`) and the filter
     matches either. 042's "safe by construction" sentence does not
     transfer.
   - **Durability needs reconnect backfill.** Socket Mode has no server-side
     queue (Telegram's `getUpdates` buffers 24h); on reconnect the tool
     emits a gap event and core re-sweeps bound channels via `get-history`.
     Core owns the per-binding inbound cursor; deterministic message locs
     make replays idempotent upserts.
9. **The bridge is a defined provider contract, not a Slack feature.**
   (Holger, 2026-07-09.) A provider tool that supports bridging implements
   the **bridge profile** — ops `send-message` (accepting `sender`),
   `get-history`, `get-channel-info`; events `<provider>.message.received`
   and `<provider>.gap`; one normalized message shape shared by ops and
   events (the 042 one-type rule) — and advertises `bridge` in `/info`
   capabilities so core can refuse to enable a binding on a tool that
   can't carry it. Core has exactly ONE inbound consumer and ONE outbound
   sweep worker, dispatching on `ChatBinding.provider` through a provider
   table in `chatBridgeClient.ts` (the `PROVIDER_TOOLS` pattern from
   `emailClient.ts`). Provider quirks live in thin adapter seams: Slack =
   customize-send identity + explicit own-bot filter + gap backfill;
   Telegram = participant `sendViaConnectionId` dispatch +
   privacy-exemption validation + no gap events (its poll cursor already
   guarantees delivery). Adding a third provider (Discord, Teams, Matrix…)
   = a new tool implementing the profile + a provider-table row — no new
   core worker. This is the "channel adapters stay thin; the
   access-controlled memory is the product" posture applied structurally.

## Architecture

Same skeleton as hadrontool-telegram: standalone Express service, own
Postgres, own encryption key, bearer-gated internal HTTP, two planes.

```
core (hadron-server)                    hadrontool-slack
────────────────────                    ────────────────
slackClient.ts      ── POST /ops/* ──►  ops handlers ── Slack Web API
                       (internal,       token store (AES-256-GCM)
                        bearer)         per-connection Socket Mode client
/internal/slack-events  ◄── events forwarder (normalized commands/interactions)
bindings + command dispatcher + AppRun trigger
```

### Tool surface (`hadrontool-slack`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/connections` | Register a workspace install: `{botToken, appToken}` → validate live (`auth.test` + `apps.connections.open` dry-run), encrypt both, return `{id, teamId, teamName, botUserId, botId}` (both bot ids — see the loop-prevention note in decision 8) |
| `GET` | `/connections/:id` | Identity + socket status |
| `DELETE` | `/connections/:id` | Close socket, soft-delete |
| `POST` | `/ops/<operation>` | v1 ops below |
| `GET` | `/info`, `/healthz`, `/readyz` | Capabilities / liveness |

- All routes internal, `Authorization: Bearer $SLACK_TOOL_TOKEN`; refuses to
  start without it in production. **No public route** (Socket Mode).
- **Ops (v1)**: `send-message` (`{connectionId, channelId, threadTs?, text,
  choices?, sender?, ephemeralUserId?, idempotencyKey?}` → `chat.postMessage` /
  `chat.postEphemeral`; `sender: {displayName, avatarUrl?}` renders via
  `chat:write.customize` `username`/`icon_url` — the bridge's per-agent
  identity), `respond` (`{connectionId, responseUrl, text,
  choices?, replaceOriginal?}` → the `response_url` path, valid 30 min —
  the natural reply channel for command/interaction round-trips),
  `update-message` (`{connectionId, channelId, ts, text, choices?}`),
  `get-user-info` (`{connectionId, slackUserId}` → display name, email if
  scoped), `get-channel-info` (`{connectionId, channelId}` → name, bot
  membership — the bridge enable-time check), `get-history`
  (`{connectionId, channelId, oldest, latest?, threadTs?}` → normalized
  messages, paginated — the gap-recovery backfill), `get-me`.
  `choices[]` = `[{value, label}]`, rendered as Block Kit
  buttons (≤5) or a static select; the clicked `value` comes back verbatim
  in the `slack.interaction` event — core round-trips its own opaque state
  through it (e.g. a signed task ref), so the tool stays stateless about
  what a choice *means*.
- Same idempotency contract as 042 (completed key replays the stored
  response); same synchronous-send posture (a 2xx means Slack confirmed;
  per-channel pacing ~1 msg/s absorbed inline; saturation returns
  `provider_rate_limited` + `retryAfterSeconds`, durable retry is core's).
- Typed error catalog reusing the 042 shape: `connection_not_found`,
  `connection_unauthorized` (revoked/invalid token → connection marked
  ERROR), `channel_not_found`, `not_in_channel`, `provider_rate_limited`,
  `not_found`, `validation_error`.
- **Socket worker**: one Socket Mode client per active connection
  (`apps.connections.open`, reconnect/refresh handled by the library).
  Envelope handling: **persist, ack, forward** — the normalized event is
  written to a tool-side `EventInbox` row FIRST, then the envelope is acked
  (inside Slack's 3s window), then a drainer delivers inbox rows to
  `CORE_EVENTS_URL` with bounded retries + dead-letter marking. Slack never
  redelivers an acked envelope, so an ack without a durable record would
  silently drop slash commands on a tool crash or core outage (Codex review
  on PR #594) — the inbox is the durable buffer that Telegram's 24h
  server-side queue provided for free in 042. Delivered rows are deleted;
  dead-lettered rows are kept for inspection. Delivery to core is therefore
  at-least-once, and **core's consumers must be idempotent per
  (connectionId, envelopeId)**. (Bridge `message.received` events get
  second-layer coverage from the gap backfill; commands/interactions have
  only the inbox — which is why it exists.) `CORE_EVENTS_URL` unset ⇒ log +
  drop, no inbox writes (deliberate, not an outage — the 042 posture).
- **Normalized events**: `slack.command` (`{connectionId, teamId, channelId,
  threadTs?, slackUserId, command, text, responseUrl, triggerId,
  envelopeId}`), `slack.interaction` (`{connectionId, teamId, channelId,
  slackUserId, value, responseUrl, messageTs, envelopeId}`),
  `slack.message.received` (`{connectionId, teamId, channelId, threadTs?,
  from: {slackUserId, botId?, displayName}, ts, text, envelopeId}` — the
  bridge inbound; the tool forwards bot messages too, carrying `botId`, so
  core can filter deliberately), and `slack.gap` (`{connectionId,
  disconnectedAt, reconnectedAt}` — emitted on socket reconnect; core
  triggers the `get-history` backfill for that connection's bindings).

Tool data model (own Prisma/Postgres, mirroring 042): `Connection`
(encrypted botToken + appToken, teamId, teamName, botUserId, botId,
status), `IdempotencyRecord`, and `EventInbox` (`connectionId, envelopeId
unique, payload, attempts, status pending|dead, createdAt` — the
persist-before-ack buffer above). No cursor column — Socket Mode has no
poll offset.

**Slack app manifest** (checked into the repo as `manifest.yml`): Socket
Mode on, slash command `/hadron`, interactivity on, message events
(`message.channels`, `message.groups`) for the bridge, bot scopes
`commands`, `chat:write`, `chat:write.customize` (per-agent identity),
`users:read`, `channels:history`, `groups:history`, `channels:read`,
`groups:read` (`conversations.info` on a private channel requires it — the
enable-time membership check would otherwise fail exactly where
`groups:history` already granted mirroring; Codex review on PR #594)
(+ `users:read.email` reserved for the later auto-match). One manifest,
N workspace installs.

### Core: connection + ingress + dispatch

- **`SlackConnection`** (new model): `id, organizationId, teamId,
  defaultAppId, toolConnectionId, teamName, botUserId, botId, status,
  deletedAt` (both bot ids — `bot_id` is what bot message events carry,
  `botUserId` is the bot's `U…` id; the loop filter needs the pair).
  Org-owned, workspace-granularity (decision 1). CRUD requires admin/owner
  org role (`requireOrgRole`, `findFirst + deletedAt: null` per the auth
  invariants). `defaultAppId` names the Hadron App that serves commands
  from this workspace; per-channel App overrides are a later binding table.
- **`SlackUserBinding`**: `(connectionId, slackUserId) unique, userId,
  deletedAt`. Created only via the link-token flow:
  `mintSlackLinkToken(connectionRef)` (single-use, 10-min TTL,
  hashed-at-rest — the 042 `mintTelegramLinkToken` shape) redeemed by the
  `/hadron link <token>` command.
- **`slackClient.ts`**: thin mirror of `telegramClient.ts` — provider table
  (`slack` → `SLACK_TOOL_URL`/`SLACK_TOOL_TOKEN`), timeout, typed-error
  pass-through, graceful degradation when the tool is down.
- **`POST /internal/slack-events`**: sibling of `/internal/telegram-events`
  (same `CORE_EVENTS_TOKEN`, `safeEqual`, 503-when-unset posture).
  `dispatchSlackEvent` is the consumer seam; consumers dedupe on
  `(connectionId, envelopeId)` (at-least-once ingress).
- GraphQL per the uniform-read-surface + ref-param conventions
  (`cor:api:120` / `cor:api:140`): `slackConnection(ref)`,
  `slackConnections(filter, orgId?, limit, offset) → {items, total}`,
  `createSlackConnection(orgRef, appRef, botToken, appToken)`,
  `deleteSlackConnection(ref)`, `mintSlackLinkToken(connectionRef)`.
  Tokens are write-only — never returned by any field (encrypted in the
  tool; core stores none of it).
- **CLI parity is part of done** (OSS strategy): `hadron slack connect
  --org <ref> --app <ref> --bot-token <t> --app-token <t>`, `status`,
  `disconnect`, `link` (mints + prints the link token). Parity issue on
  hadron-cli.

### Command dispatch (at `dispatchSlackEvent`)

All handlers resolve the connection → org + default App, then the binding →
user; unbound users (except `link`) get one ephemeral how-to-link reply via
`/ops/respond`.

1. **`/hadron link <token>`** — redeem the mint (hash-compare, TTL,
   single-use), create the binding, ephemeral confirmation. The only
   handler that works unbound.
2. **`/hadron find <query>`** — run the existing node search (the
   `hadron_find_nodes` internals: keyword default; hybrid where a memory
   is vector-indexed) **as the bound user** across the memories that user
   can read, through `getAccessibleMemoryIds` — no bespoke gate (the #362
   invariant). Reply via `/ops/respond`: top N hits as name + one-line
   abstract + `https://hadronmemory.com/app/u/<URN>` portal link. Empty
   result is a normal reply, not an error.
3. **`/hadron task <query>`** — same search constrained to
   `isRunnable: true`. Exactly one hit → confirm-choice; several → a
   `choices[]` pick list (value = signed `{taskNodeId, channelId,
   threadTs}` payload); none → normal empty reply.
4. **`slack.interaction`** — verify + unpack the signed choice value,
   re-check the binding and the user's read access to the task node (the
   pick list is not an authorization), then trigger a **spec-040 AppRun**
   on the connection's App with the task as input and the Slack context
   (requesting user, channel, thread) attached. Immediately
   `respond`-update the picker message ("running <task> — run <id>").
   On run completion, the run-completion path posts the result to the
   stored channel/thread via `send-message` (idempotency key = run id).
   Budgets/quotas per spec 040 apply unchanged; a quota refusal posts as
   an ephemeral error.
5. **`/hadron` bare / `help` / unknown subcommand** — ephemeral usage text.

### Chat bridge (core)

Provider-neutral models — **these are the 042 Phase-4 models, generalized;
Telegram reuses them as the second adapter**:

- **`ChatBinding`**: `id, provider ('slack' | 'telegram'), connectionId
  (provider-scoped), channelId, threadId?, memoryId, messagesLoc, seqCursor
  (outbound), lastMirroredTs? (inbound backfill cursor), enabled,
  deletedAt`. CRUD requires admin/owner org role on the owning App's org.
- **`ChatParticipant`**: `(bindingId, appId), authorHandle, displayName?,
  avatarUrl?, sendViaConnectionId? (telegram-only; null on slack),
  consentedByUserId, deletedAt`. `authorHandle` is the chat-protocol handle
  the outbound mirror matches against message nodes' `data.author`. Adding
  a row requires an org role on the *participant* App's org (the 042
  consent posture).

**Enable-time validation**: the connection's bot must be a member of the
channel (`get-channel-info`) — the Slack analog of 042's privacy-exemption
check, and much weaker because Slack has no privacy mode: once invited and
scoped, the bot sees everything in the channel. Re-check on the sweep's
error path (the bot can be kicked after binding).

**Inbound (humans → chat memory)**: `slack.message.received` resolves the
binding **most-specific-first**: an enabled row matching `(connectionId,
channelId, threadId = threadTs)` wins; otherwise fall back to the
channel-wide row (`threadId IS NULL`) — so thread replies inside a bound
channel still mirror when no thread-specific binding exists (Gemini +
Codex review on PR #594); no match ⇒ drop. Skip messages carrying the
connection's own bot identity (event `bot_id` = connection `botId` OR
sender = `botUserId` — explicit loop prevention, Slack bots see their own
sends) and `data.source: 'slack'` provenance; write message nodes
with **deterministic locs** `…:messages:slack-<channelId>-<ts>` and
`data: {author, identity: 'human', source: 'slack', slack: {channelId,
ts}}` — at-least-once ingress upserts idempotently (the 042 `tg-<messageId>`
pattern; Slack `ts` is unique per channel). A `thread_ts` maps to a `reply`
edge when the parent message's node is known.

**Gap recovery**: on `slack.gap`, core sweeps each enabled binding on that
connection with `/ops/get-history {channelId, oldest: lastMirroredTs}` and
runs the missed messages through the same idempotent inbound consumer.
The sweep is **sequential per connection, not fanned out** —
`conversations.history` is one of Slack's tighter-budget methods, and a
reconnect on a connection with many bindings would trip rate limits if
fired in parallel (Gemini review on PR #594); the tool paces `get-history`
per connection and returns `provider_rate_limited` + `retryAfterSeconds`
on saturation, which the sweep honors before the next binding. This is
the durability story Socket Mode doesn't give for free.

**Outbound mirror**: same DB-backed sweep loop as 042 (D-2026-06-17-004
posture) — per enabled binding, message nodes with `seq > seqCursor`, skip
`data.source === 'slack'`, post via `send-message` with `sender:
{displayName, avatarUrl}` from the author's participant row (falling back
to `**<author> (<role>):**` prefix text when no participant row exists).
**Participant resolution rides on the message node's `data.author` handle**
(the chat-protocol contract `hadron chat post` already honors); the
participant row carries the handle(s) it answers for. Message-writing
paths that today omit an author — `processChatResponse` writes only
`data.role: 'assistant'` (Gemini review on PR #594) — must record the
author identity at creation time, or their nodes permanently fall back to
the prefix form; fixing that write path is a Phase-3 task. `reply` edges →
`threadTs`; store the returned `ts` back into the node's `data.slack` for
future reply mapping. Advance `seqCursor` only after confirmed (or
terminally-failed) delivery.

## Phases

**Phase 1 — the tool** (new repo `hadrontool-slack`, scaffold from
hadrontool-telegram): config/logger/db/crypto/auth-middleware/respond funnel
carry over nearly verbatim; implement `POST /connections` (live validation),
the v1 ops incl. the neutral `choices[]` → Block Kit renderer, per-channel
pacing + 429 backoff, the Socket Mode worker (persist-ack-forward via the
`EventInbox`, bounded retry + dead-letter), the events forwarder, `/info`,
`manifest.yml`. Tests:
real HTTP + real Postgres over a fake Slack — `SLACK_API_BASE` override plus
a fake Socket Mode server (`apps.connections.open` returns a local `ws://`
URL), the 042 fake-Bot-API pattern extended with a WebSocket.

**Phase 2 — core plumbing**: `SlackConnection` model + migration,
`slackClient.ts`, `/internal/slack-events` + `dispatchSlackEvent` (+
envelope dedupe), GraphQL connection CRUD/reads, env registration (Doppler
dev + prd), CLI connect/status/disconnect. Acceptance: a connection
registers against the live tool and `/hadron` answers the ephemeral usage
text — the full command round-trip pipeline proven. (User bindings move to
Phase 4 — the bridge doesn't need them.)

**Phase 3 — chat bridge** (the priority phase — the Micromentor team-chat
mirror): tool side — message-event subscription + `slack.message.received`
forwarding (bot messages included, `botId` carried), `slack.gap` on
reconnect, `get-history` + `get-channel-info` ops, the `sender`
customize-send, `bridge` in `/info` capabilities. Core side —
`ChatBinding`/`ChatParticipant` (provider-neutral) + migration,
`chatBridgeClient.ts` provider dispatch, enable-time membership validation,
binding CRUD (GraphQL + CLI), the inbound consumer (most-specific binding
resolution, deterministic locs, bot-loop filter on both bot ids, reply
mapping), the paced gap-backfill sweep, the outbound mirror worker, and
the author-identity fix in message-writing paths that omit it
(`processChatResponse` → record the author on assistant message nodes).
Acceptance: the 042 EngTeamChat scenario, on Slack — two
agents + two humans, agents coordinating in the chat memory via `hadron
chat read`/`post` unchanged, humans in a Slack channel, per-agent
names/avatars outbound. **This phase builds the provider-neutral worker 042
Phase 4 reuses** — when Telegram's bridge lands, it is an adapter
(participant `sendViaConnectionId` dispatch + privacy-exemption
validation), not a second worker.

**Phase 4 — bindings + search**: `SlackUserBinding` + migration,
`mintSlackLinkToken`, the `link` handler, the `find` handler + result
formatting, CLI `link`. Acceptance: `/hadron link` round-trip binds a user;
unbound `/hadron find` gets the how-to-link ephemeral; bound `/hadron find
<query>` returns the same top hits the user would get from `h-find-nodes`,
with portal links, in-thread.

**Phase 5 — task run**: the `task` handler, choice round-trip, signed
choice values, AppRun trigger + completion → channel post. Acceptance: pick
a task from the list in Slack, watch the run execute under spec-040 budgets,
result lands in the thread.

## Environment variables

| Variable | Side | Notes |
|---|---|---|
| `SLACK_TOOL_URL` / `SLACK_TOOL_TOKEN` | core | Provider entry in `slackClient.ts`; unset ⇒ typed `SLACK_TOOL_NOT_CONFIGURED` |
| `SLACK_TOOL_TOKEN` | tool | Same value; bearer gate on every route |
| `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY` | tool | Own DB, own key (never core's) |
| `CORE_EVENTS_URL` / `CORE_EVENTS_TOKEN` | tool | Points at `/internal/slack-events`; same token contract as email/telegram events |
| `SLACK_API_BASE` | tool | Web API base override for tests (default `https://slack.com/api`) |
| `SLACK_SEND_GAP_MS` | tool | Per-channel pacing gap (default ~1000) |
| `DISABLE_SOCKET_WORKER` | tool | Ops hatch, mirrors `DISABLE_POLL_WORKER` |

## Non-goals (v1)

Events-API/webhook transport (the Marketplace flip, later); per-App Slack
apps / persona DMs; @mention conversational chat outside bound channels;
message edit/delete mirroring; reactions; email auto-match binding; App
Home tab; per-channel App overrides for commands (schema leaves room; no
table yet); the Telegram bridge itself (042 Phase 4 — lands later as the
second adapter on this spec's `ChatBinding` models).
