# 042 — Telegram integration: `hadrontool-telegram` + chat bridge

Status: **planned** (design converged 2026-07-09, Holger + Claude). Decision
record: `hrn:node:hadronmemory.com::hadron-server::reference:hadrontool-telegram`.
Pattern precedent: `hadrontool-ms-exchange` (#396) — this is the third
application of the capability-tool pattern, and the simplest so far (no OAuth,
no subscription renewals, optional public ingress).

## Goal

Telegram as a **surface** for Hadron Apps — never as the source of truth:

1. A Hadron App owns a Telegram bot; users DM the App (and it answers).
2. Headless AppRuns (spec 040) send proactive DMs (inbox summary etc.).
3. An agent team chat (the existing chat-memory protocol) is mirrored
   bidirectionally into a Telegram group, so humans participate natively
   while agents keep using `hadron chat read`/`post` unchanged.

The chat memory stays the agents' plane and the durable record; Telegram is
the humans' plane. This is deliberate — Telegram bots can never see other
bots' messages (platform rule, independent of privacy mode), so agents
cannot coordinate *inside* Telegram. The bridge design makes that limitation
irrelevant: nothing that matters ever exists only in Telegram except human
messages, which the group's **ear bot** can see — provided it is exempt
from Telegram's privacy mode (see the binding validation below; NOT the
BotFather default).

## Decisions (2026-07-09, Holger)

1. **Bot API, not MTProto user accounts.** Bots need no phone number and no
   ToS-grey automation. Per-agent bots in one group can't see each other, so
   user accounts were the only alternative — rejected for v1.
2. **One bot per App is the blessed granularity.** Bot identity ⇒ App routing
   is structural; verified sender binding ⇒ user routing. The tool itself is
   granularity-agnostic (a connection is just a token + identity); ownership
   is a core-side column.
3. **Long-polling (`getUpdates`) in v1.** Deletes the public-ingress /
   Traefik / DNS surface entirely; Telegram queues updates 24h, so restarts
   lose nothing and `update_id` is a natural dedupe cursor. Webhook
   (`setWebhook` + secret-token header) is a per-connection config flip
   later, not a redesign.
4. **Raw `fetch` against the Bot API.** Plain HTTPS+JSON; no grammY/Telegraf
   dependency (mirrors ms-exchange talking to Graph without a heavy SDK).
5. **The bridge is core infrastructure, not App behavior.** A deterministic
   worker sweeps binding rows; the owning App only configures them. No model
   invocation per mirrored message; the bridge survives paused runs.
6. **The tool is Hadron-blind — no core DB tables, no core API.** (Holger,
   2026-07-10.) Shared tables would couple migrations across independently
   deployed repos and, worse, bypass authorization entirely — Hadron's
   access control lives in application code (the shared gates), so direct
   table reads have no gate to drift from. And the GraphQL API is out too:
   an API caller needs a principal, and any principal the tool could hold
   is ambient authority. The only tool→core channel is the normalized
   events ingress; the only core→tool channel is `/ops/*`. Implementation
   rule: when an op is tempted to query core for context ("which node maps
   to this message?"), **invert it** — core passes the context in the
   request; ops stay self-contained.
7. **No grant system in this spec.** Telegram connections are App-owned;
   "send via my bot" consent is a chat-binding participant row, not a
   `ConnectionGrant`. User→App resource delegation (`ConnectionGrant`) is
   **Track B**, a parallel spec that unlocks the mailbox/calendar stories —
   see "Track B" below. Nothing in phases 1–4 depends on it.

## Architecture

Same skeleton as hadrontool-ms-exchange: standalone service, own Postgres,
own encryption key, bearer-gated internal HTTP, two planes.

```
core (hadron-server)                    hadrontool-telegram
────────────────────                    ───────────────────
telegramClient.ts   ── POST /ops/* ──►  ops handlers ── Bot API (fetch)
                       (internal,       token store (AES-256-GCM)
                        bearer)         per-connection poll loop
/internal/telegram-events  ◄── events forwarder (normalized updates)
bindings + bridge worker
```

### Tool surface (`hadrontool-telegram`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/connections` | Register a bot: `{botToken}` → validate via `getMe`, encrypt token, return `{id, botId, botUsername}` |
| `GET` | `/connections/:id` | Identity + poll status |
| `DELETE` | `/connections/:id` | Stop polling, soft-delete |
| `POST` | `/ops/<operation>` | `send-message`, `edit-message`, `delete-message`, `get-chat`, `get-chat-member`, `get-me` (v1); media ops later |
| `GET` | `/info`, `/healthz`, `/readyz` | Capabilities / liveness |

- All routes internal, `Authorization: Bearer $TELEGRAM_TOOL_TOKEN`; refuses
  to start without it in production. **No public route in v1** (long-polling).
- `send-message` input: `{connectionId, chatId, text, replyToMessageId?,
  messageThreadId?, parseMode?, idempotencyKey?}`. Same idempotency contract
  as ms-exchange (completed key replays stored response).
- Typed error catalog reusing the spec-002 shape: `connection_not_found`,
  `connection_unauthorized` (revoked token → connection marked ERROR),
  `provider_rate_limited` (Telegram 429; honor `retry_after`),
  `not_found`, `validation_error`.
- **Send ops are synchronous — success means Telegram confirmed.** The tool
  paces per-chat (~1 msg/s per chat, ~20/min per group) and absorbs short
  429s *within* the request, but never acks an undelivered message (no
  durable tool-side queue; a tool crash loses nothing core hasn't already
  confirmed). On saturation it returns `provider_rate_limited` +
  `retryAfter`; **durable retry belongs to core's sweep worker**, which
  holds the cursor and replays with the same `idempotencyKey`. (Gemini
  review on PR #591, comment 2.)
- **Poll worker**: one `getUpdates` long-poll loop per active connection
  (30s timeout, `offset = lastUpdateId + 1` persisted per connection —
  cursor doubles as dedupe). Normalizes updates and POSTs to
  `CORE_EVENTS_URL`. **The cursor advances only after a 2xx from core** —
  unlike Graph, `getUpdates` deletes acknowledged updates server-side, so
  the tool is the last stop; a failed forward must NOT advance (retry next
  tick — Telegram's 24h server-side queue is the durable buffer). Bounded
  per-batch retries with dead-letter logging so one poison event can't
  wedge the stream; a core outage longer than 24h loses updates (accepted).
  (Gemini review on PR #591, comment 4 — the ms-exchange "logged, never
  fatal" posture does not transfer.)
- Normalized events: `telegram.message.received` (`{connectionId, chatId,
  messageThreadId?, from: {telegramUserId, username?, displayName},
  messageId, replyToMessageId?, text, kind: 'dm'|'group', receivedAt}`) and
  `telegram.start` (`{connectionId, chatId, from, payload}` — the deep-link
  `/start <payload>`).

Tool data model (own Prisma/Postgres, mirroring ms-exchange):
`Connection` (encrypted bot token, botId, botUsername, status, lastUpdateId)
+ `IdempotencyRecord`. No subscription/renewal machinery needed.

### Core: connection + ingress

- **`TelegramConnection`** (new model): `id, organizationId, appId (unique),
  botId, botUsername, provider ('telegram'), toolConnectionId, status,
  deletedAt`. **App-owned** — unlike `ExchangeConnection` (user-owned).
  Connection CRUD requires admin/owner org role on the App's org
  (`requireOrgRole`, `findFirst + deletedAt: null` per the auth invariants).
- **`telegramClient.ts`**: thin mirror of `emailClient.ts` — provider table
  (`telegram` → `TELEGRAM_TOOL_URL`/`TELEGRAM_TOOL_TOKEN`), timeout, typed
  error pass-through, graceful degradation when the tool is down.
- **`POST /internal/telegram-events`**: sibling of `/internal/email-events`
  (same `CORE_EVENTS_TOKEN`, `safeEqual`, 503-when-unset posture).
  `dispatchTelegramEvent` is the consumer seam.
- GraphQL surface per the uniform-read-surface + ref-param conventions
  (`cor:api:120` / `cor:api:140`): `telegramConnection(ref)`,
  `telegramConnections(filter, orgId?, limit, offset) → {items, total}`,
  `createTelegramConnection(appRef, botToken)`,
  `deleteTelegramConnection(ref)`. Bot token is write-only — never returned
  by any field (it lives encrypted in the tool; core stores none of it).
- **CLI parity is part of done** (OSS strategy): `hadron telegram connect
  --app <ref> --token <t>`, `status`, `disconnect`, plus binding commands
  below (parity issue on hadron-cli).

### Bindings (core)

Two flavors, both new models:

- **`TelegramUserBinding`** — verified DM identity: `(connectionId,
  telegramUserId) unique, userId, chatId, deletedAt`. Created ONLY via the
  deep-link flow: `mintTelegramLinkToken(connectionRef)` issues a
  **single-use, short-TTL (10 min), hashed-at-rest** token for the calling
  user; the user taps `t.me/<bot>?start=<token>`; the `telegram.start` event
  redeems it and binds `(telegramUserId, chatId) ↔ userId`. Bots are
  publicly discoverable, so an inbound DM is NEVER self-authenticating —
  every DM consumer requires a live binding; unbound senders are dropped
  silently and logged (no auto-reply to strangers by default).
- **`TelegramChatBinding`** — group ⇄ chat memory: `connectionId (the
  inbound ear), telegramChatId, messageThreadId? (forum-topic support from
  day one), memoryId, messagesLoc, seqCursor, enabled, deletedAt` +
  child **`TelegramChatParticipant`** rows: `(bindingId, appId), sendViaConnectionId?,
  consentedByUserId, deletedAt`. A participant row IS the "EngTeamChat may
  deliver my posts via my bot" consent; adding one requires an org role on
  the *participant* App's org, not just the binding owner's.
  **Enable-time validation (Codex review, PR #591):** BotFather's default
  privacy mode hides ordinary group messages from bots — a non-exempt ear
  bot would *silently* miss human messages and leave the chat memory
  incomplete. Enabling a binding therefore requires the ear bot to be
  privacy-exempt, checked mechanically: `get-me` must report
  `can_read_all_group_messages: true`, OR `get-chat-member` must show the
  bot as an admin of the bound chat. Refuse to enable otherwise, with a
  remediation message (BotFather `/setprivacy` → Disable, or promote to
  admin). Re-validate on the sweep loop's error path (privacy can be
  re-enabled after binding). Send-only participant bots need no exemption —
  only the ear reads.

### Consumers (at `dispatchTelegramEvent`)

1. **DM → chat node** (live-session Apps): resolve App (connection) + user
   (binding); write a `message` node under the App's per-user DM
   message-parent (`chats:dm-<user-handle>:messages` in the App's memory)
   with `data: {author: <handle>, identity: 'human', source: 'telegram',
   telegram: {chatId, messageId}}`. **Telegram-sourced message locs are
   deterministic**: `…:messages:tg-<messageId>` (not the chat protocol's
   timestamp-handle form) — a redelivered update (poll retry before the
   cursor persists, at-least-once ingress) upserts the same node instead of
   duplicating. (Gemini review on PR #591, comment 1 — applies to consumer
   3's group messages identically.) hadron-client's existing channel watcher
   delivers it into a live Claude Code session **unchanged** — zero client
   work.
2. **DM → AppRun** (headless Apps): if the App has no watcher and is
   run-enabled, trigger a spec-040 run with the message as input + the DM
   chat as context. Run quotas apply unchanged.
3. **Group message → chat node**: resolve the chat binding by
   `(connectionId, chatId, threadId)`; write the human's message into the
   bound chat memory (same `source: 'telegram'` provenance). Telegram
   `reply_to_message_id` maps to a `reply` edge when the target message's
   node is known (store the telegram-id → node mapping in node `data`).
4. **Mention → AppRun** (headless group participants): a new chat node
   @mentioning a headless participant App triggers a run with chat + audience
   context ("this reply posts to group X; members: …"). Loop discipline: a
   run's own reply does not re-trigger the App that just answered unless
   freshly mentioned; spec-040 quotas are the backstop.

### Outbound mirror (core worker)

DB-backed sweep loop (D-2026-06-17-004 posture; NATS upgrade later): per
enabled binding, list message nodes with `seq > seqCursor` — deliberately
the same server-assigned-`seq` contract `hadron chat read --since` relies
on (message nodes always get a seq; message lists are append-only in
practice; if that contract ever breaks, the chat protocol itself breaks
first) — skip
`data.source === 'telegram'` (loop prevention — the other direction is safe
by construction: Telegram never delivers a bot its own sends, and bots can't
see other bots), and for each node:

- If the author maps to a participant with `sendViaConnectionId` → send
  through that App's bot (the agent gets its own face in the group).
- Else → send through the ear bot with a bold `**<author> (<role>):**`
  prefix (the honest UX ceiling — Telegram has no sender impersonation).
- `reply` edges → `reply_to_message_id`; store the returned Telegram
  `message_id` back into the node's `data.telegram` for future reply mapping.
- Advance `seqCursor` only after successful (or terminally-failed) delivery.

DM chats mirror outbound the same way, through the App's own connection to
the bound `chatId`.

## Phases

**Phase 1 — the tool** (new repo `hadrontool-telegram`, scaffold from
ms-exchange): config/logger/db/crypto/auth middleware carry over nearly
verbatim; implement `POST /connections` (getMe validation), the five v1 ops,
the per-chat send queue + 429 backoff, the poll worker + `update_id`
cursor, the events forwarder, `/info`. Tests: real HTTP + real Postgres over
a fake Bot API (the ms-exchange fake-Graph pattern). Deploy: Komodo → GHCR,
Doppler-injected, internal-only (no Traefik route — nicer than ms-exchange).

**Phase 2 — core plumbing**: `TelegramConnection` model + migration,
`telegramClient.ts`, `/internal/telegram-events` + `dispatchTelegramEvent`,
GraphQL connection CRUD + reads, env registration (Doppler dev + prd), CLI
connection commands.

**Phase 3 — DMs**: `TelegramUserBinding` + `mintTelegramLinkToken` +
`telegram.start` redemption; consumer 1 (DM → chat node) + outbound DM
mirror; consumer 2 (DM → AppRun). Acceptance: the personal-assistant loop —
DM an App, live session answers via channel push; headless App answers via
run.

**Phase 4 — group bridge**: `TelegramChatBinding` + participants +
consent gates; consumer 3 (group → chat memory) + mention→run (consumer 4);
the outbound mirror worker with per-participant send-via dispatch, reply
mapping, forum-topic `threadId`. Acceptance: the EngTeamChat scenario —
two agents + two humans, agents coordinating in the chat memory, humans in
Telegram, per-agent bot identities outbound.

**Track B (parallel, separate spec) — `ConnectionGrant`**: user→App scoped
delegation on user-owned connections. `(connectionId, granteeAppId, scopes[],
grantedByUserId, expiresAt?, deletedAt)`; **grantee is the App (install),
never the Agent** — one Agent in two Apps/orgs is two trust contexts (the
Juno seed-fixture scenario); **owner-only create/revoke, no org-admin
bypass** (the personal/private-memory posture); enforcement swaps inside
`requireEmailConnection` (owner OR live grant covering the operation's
scope) with an operation→scope table in core (`mail.read`, `mail.send`,
`calendar.freebusy`, `calendar.read`); calendar ops (`get-schedule`,
`list-events`) added to hadrontool-ms-exchange. Unlocks: Rachael reads
Holger's inbox in a headless run; free/busy answers in group chat with
disclosure floored by scope. Nothing in Phases 1–4 waits on this.

## Environment variables

| Variable | Side | Notes |
|---|---|---|
| `TELEGRAM_TOOL_URL` / `TELEGRAM_TOOL_TOKEN` | core | Provider entry in `telegramClient.ts`; unset ⇒ typed `TELEGRAM_TOOL_NOT_CONFIGURED` |
| `TELEGRAM_TOOL_TOKEN` | tool | Same value; bearer gate on every route |
| `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY` | tool | Own DB, own key (never core's) |
| `CORE_EVENTS_URL` / `CORE_EVENTS_TOKEN` | tool | Points at `/internal/telegram-events`; same token contract as email events |
| `TELEGRAM_POLL_TIMEOUT_S` | tool | `getUpdates` long-poll timeout (default 30) |

## Non-goals (v1)

Webhook mode (config flip later); media beyond text (photos/documents/voice
— follow-up ops); message edit/delete mirroring; reactions; per-user bots
(just a connection with a different owner if ever needed); MTProto user
accounts (rejected); a general App→App grant system (binding participant
rows suffice).

## Grounding

OpenClaw and Hermes-agent both ship polished Telegram gateways but are
single-trusted-owner, agent-centric architectures: no shared durable chat
memory, agent-to-agent messaging off/pairwise, no multi-tenant authz, no
scoped resource grants. The adapter layer here is deliberately thin
commodity; the differentiator is the access-controlled memory substrate the
bridge writes into. (Their convergence on one-bot-per-agent + mention
routing + forum topics independently validates decisions 2 and the
`threadId` support.)
