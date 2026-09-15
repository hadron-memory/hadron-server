# 049 — The Agent manifest: scopes, the active organization, Channels, and the chat register

Status: **planned** (2026-09-15, Dara, for the coordinator's dispatch
[hadron-server#1153](https://github.com/hadron-memory/hadron-server/issues/1153)).
**This is the plan, not the implementation.** The slices are cut from it; nothing
here has been built, and no spec citation is minted by it.

Design of record (hadron-concept, committed at `c70c908`):

- `design-discussions/hadron-platform/2026-09-13-memory-manifest-and-search-lenses/summary.md`
  — **D-2026-09-13-001 … 005**, Q-2026-09-13-001
- `design-discussions/hadron-platform/2026-09-13-agent-chat-register/summary.md`
  — **D-2026-09-13-006 … 010**, Q-2026-09-13-002 … 003
- `design-discussions/_registry/decisions.md` — the rule text, the supersessions, and
  the **rejected alternatives**. Every "rejected" below is quoted from there so a slice
  cannot re-adopt one by accident.

Implementation issues that already exist and stay: **#1150** (the lens half — Scope
table, ladder, disclosure, active org on MCP), **#1047** (closed by Phase 4's protected
loc), **#1048** (absorbs Phase 8's Channel-addressed chat operations).

Holger's governing constraint, stated in both sessions: **the CLI must surface 100% of
the platform.** Every server surface in this plan must be reachable from GraphQL, since
that is what the CLI consumes; nothing may land reachable only from the portal.

## 1. Grounding — this plan implements decided design, it does not re-decide it

The ten decisions are treated as fixed. Where a decision determines an implementation
choice, the plan states the choice and cites the decision. Where a decision leaves a
choice open, the plan says **"open"** and offers at most a recommendation. Where the
design is **silent on something load-bearing**, the plan does not fill the gap: §12
lists those as reports to the coordinator, and the affected slice is marked as blocked
on the answer.

One correction of premise, measured against current `main` (`f6188bc`) rather than
recalled:

- **Protected branches (D-2026-08-25-004, `Memory.protectedLocs`) are not built.**
  `prisma/schema.prisma` has no such column and no issue tracks it. The Channel
  decision (D-2026-09-13-006) says creating a row "reserves and **protects** the loc",
  and its rejection of the chat-root-as-channel alternative rests on "nothing to
  protect before the first post". So the protection mechanism is on this plan's
  critical path, and §12 item 2 asks the coordinator which of two shapes it takes.

## 2. Why one plan — the shared pieces, named once

The two sessions decided one epic. Four shapes recur, and each is a **first-class
deliverable built once** in Phase 0, then consumed by the later phases. A slice that
re-implements one of these instead of consuming it is the specific failure this plan
exists to prevent.

| # | Shared piece | Consumed by |
|---|---|---|
| **S1** | **The exactly-one-owner column triple.** Three nullable FKs `organizationId` / `agentId` / `appId` + a CHECK `num_nonnulls(...) = 1`, never an `ownerKind` string (D-001, D-007). Precedent already in the repo: `chk_ai_service_config_owner` in `prisma/post-push.sql` (spec 036) uses exactly this `num_nonnulls` form. Delivered as: the CHECK idiom (migration + `post-push.sql` + `src/test/globalSetup.ts`, the three places every CHECK lives), one `resolveOwnerInput(ownerRef)` helper that turns a caller's `{organizationRef \| agentRef \| appRef}` into the triple and applies the owner's write gate (§8), and one **collision resolver** `pickByOwnerPrecedence(rows, {app, agent, org})` implementing App › Agent › organization with **namespacing, never union** (D-001: "merges two builders' intentions nobody reviewed"). | Scope (Phase 2), register (Phase 5) |
| **S2** | **Intersect-and-disclose.** `narrowToAccessible(requested: memoryId[], accessible: memoryId[] \| null) → { kept, dropped }`, order-preserving, where `accessible` is the set the existing gate already computes (`getAccessibleMemoryIds` in `resolvers.helpers.ts`; `getMemoryAccess` in `src/mcp/access-control.ts`). Never widens (D-004: "a lens never grants"; D-008: "the register never grants"). The dropped half is *reported*, never an error (D-004 rejected erroring: "turns a legitimate App-wide scope into a failure for every member lacking one memory"). | scope resolution (Phase 3), `scope explain` (Phase 2), register can-act (Phase 6) |
| **S3** | **The disclosure envelope.** One renderer for "what this result was produced under": (a) a `scope` block on `FindNodesResult` and on the MCP text envelope (`scope:` line), (b) the degrade code `scope_narrowed` appended to the existing comma-separated `degraded` set (`FindNodesResult.degraded`, `typeDefs.ts` ~l.238 — "parse the set, never compare the whole string"), (c) the optional outside-scope count. Precedent: `hadron_list_memories` already prints a `Scope:` line (`src/mcp/server.ts` ~l.1618) — that wording is superseded by this piece, not duplicated. | findNodes / list_nodes / globalSearch (Phase 3), register reads (Phase 6) |
| **S4** | **The protected-loc write gate.** A predicate `isProtectedLoc(memoryId, loc)` and one refusal point in the generic node write path (create / update / delete / move, GraphQL and MCP) that consults it, with the owning surface writing through its own gate. **Shape blocked on §12 item 2.** | Channel (Phase 4); later D-2026-08-25-004 |
| **S5** | **The register disclosure vocabulary.** A closed set of reason codes an entry carries when the Agent cannot act on it (D-008/D11: "disclosed with the reason and the Agent's URN, never dropped") — `HOST_MEMORY_NOT_READABLE`, `HOST_MEMORY_NOT_WRITABLE`, `CHANNEL_DELETED`, `DRIVER_NOT_PARTICIPANT`. Rendered identically by every consumer of `resolveRegister`. | briefing, `hadron_whoami`, run snapshot, relay read (Phase 6) |

The manifest itself is not a table. It is the **three lists** an Agent's consumers read
(D7 local, register session): memories = the existing `AgentMemoryItem`
(`cor:dmo:050:09`), scopes = Phase 2, channels = Phase 5. Nothing new stores "the
manifest"; `resolveRegister` and the scope resolver are its read surfaces.

## 3. Data model (Prisma sketch)

New tables are listed here; **migrations are §7**, called out separately because two of
them rewrite existing data.

### 3.1 `Scope` + `ScopeMemory` (D-001)

```prisma
model Scope {
  id             String   @id @default(cuid())
  name           String                       // unique within its OWNER, not globally
  description    String?
  organizationId String?  @map("organization_id")   // S1 triple — exactly one set
  agentId        String?  @map("agent_id")
  appId          String?  @map("app_id")
  // audit + soft-delete as every tenanted row
  memories       ScopeMemory[]
  @@unique([organizationId, name]); @@unique([agentId, name]); @@unique([appId, name])
}

/// The ORDERED memory list. A join row rather than an id array so that
/// "which scopes include this memory" is a query (D-001 rejected ids-in-JSON
/// for exactly that: `scope explain` and memory deletion need the reverse
/// lookup) and so memory deletion cascades.
model ScopeMemory {
  scopeId  String
  memoryId String
  position Int
  @@id([scopeId, memoryId]); @@unique([scopeId, position])
}
```

- `name` is unique **per owner**, which is what makes App › Agent › org collisions
  possible and resolvable by namespacing (`marketing` vs `juno/marketing` per #1150 —
  the namespacing spelling is **open**, tunable, and must be one shared function, S1).
- **`global` is reserved** (D-002) and refused at create.
- A scope may list memories the App has not attached (D-001); selecting it never
  attaches anything. **No saved filter** (D-001 rejected "memories plus a saved
  filter": "a filter riding silently under a name is how a wrong-country answer becomes
  invisible") and **no retrieval parameters** (D-004: "a scope never carries depth,
  padding, or weights").

### 3.2 The active organization and the active scope on the client session (D-002, D-003)

"The session's active scope" in the ladder is the **client** session — the sibling of
`hadron_set_active_app` / `hadron_set_active_memory`, which persist per
`(userId, clientKey)` in `McpSessionState` since #1013. It is **not** the Hadron
`Session` row (that row carries `appId` and the write-memory `memoryId`, and is bound to
a Worker; a stint's search lens is not provenance). So:

```prisma
model McpSessionState {  // existing — two columns added
  organizationId String? @map("organization_id")   // hadron_set_active_org  (D-003)
  scopeId        String? @map("scope_id")          // hadron_set_active_scope (D-002)
}
```

The CLI's equivalents are config keys (hadron-cli#578). GraphQL needs no session state:
the caller passes `orgId` (already on `findNodes` / `globalSearch`, `cor:api:100:01`)
and the new `scope` argument per call.

### 3.3 Headless runs carry a scope snapshot (D-004)

```prisma
model AppRun {  // existing — one column added
  /// D-2026-09-13-004: the trigger MAY name a scope; it is SNAPSHOTTED at mint as the
  /// ordered memory-id list (same reason `policy` is snapshotted — a run must not change
  /// meaning because someone edited a scope mid-flight). Null ⇒ `app`.
  scopeSnapshot Json? @map("scope_snapshot")
}
```

The trigger rows (`agent_schedules`, webhook routes, `hadron_spawn`) each gain an
optional `scopeRef`; that is the *only* place a run's scope comes from. No "default
named scope for headless runs" (D-004).

### 3.4 `Channel` (D-006, D12)

```prisma
enum ChannelKind { CHAT }   // `BLOCKERS` / `TASKS` when built (D7 local) — not now

model Channel {
  id             String      @id @default(cuid())
  memoryId       String      @map("memory_id")      // host memory — the audience (cor:acl:030:01)
  loc            String                             // reserved address of the chat root
  name           String
  kind           ChannelKind
  description    String?
  chatRootNodeId String      @map("chat_root_node_id")   // eager, one-to-one (D-006)
  lastSeq        Int         @default(0) @map("last_seq")           // D-009 watermark
  lastMessageAt  DateTime?   @map("last_message_at")
  // audit + soft-delete
  bindings       ChatBinding[]   // spec 043, re-keyed by Channel (Phase 0 amendment; unbuilt)
  @@unique([memoryId, loc])          // one Channel per address
  @@unique([chatRootNodeId])         // one Channel per root
}
```

- **Eager one-to-one creation is load-bearing** (D-006 adversarial round): the row, the
  chat-root node and its `:messages` child are created **in one transaction**, and the row
  stores the node id. That is what reconciles "canonical reference = PK of the chat node"
  with the table. A Channel row whose root is missing is a bug, not a state.
- `lastSeq` is the **allocator's output**, written inside `appendChatMessage`'s
  ancestor lock (`src/lib/chatRoot.ts`) in the same transaction as the seq — it is the
  watermark D-009 needs and nothing else. The chat root's `data.messageCount` stays
  what it is: a routing operand
  (`findings:chat-seq-counter-is-a-routing-operand`). Two numbers, two jobs; the plan
  does not merge them.
- **"The App's default Channel"** (D-007, D2) needs a marker. **Proposed:**
  `App.defaultChannelId String? @unique` — a nullable FK on the App, set by Phase 4's
  migration and by eager creation at `createApp`. Rejected here: a boolean on the
  Channel (two defaults per App would be a data state the CHECK cannot refuse).
- `kind` is an enum by the repo's precedent (D-2026-05-22-002: prefer enums where
  future values are foreseeable). Adding `BLOCKERS` later is an enum-add, which with a
  CHECK referencing it is **two migration files** (the Postgres transaction rule the
  repo has already hit — `hrn:node:hadronmemory.com:dev:ops:incidents:20260517-p3009-memoryclass-ownership`).

### 3.5 `RegisterEntry` (D-007) — **blocked on §12 item 1**

```prisma
model RegisterEntry {
  id             String       @id @default(cuid())
  organizationId String?      // S1 triple — the OWNER (who controls the row)
  agentId        String?
  appId          String?
  channelId      String       @map("channel_id")
  role           RegisterRole            // WATCH | POST | BOTH — INTENT, never permission (D-008)
  mentionOnly    Boolean      @default(false) @map("mention_only")
  description    String?                 // free text — the human's intent (D1)
  // audit
  // ??? the SUBJECT — which Agent attends. See §12 item 1 before adding a column.
}
enum RegisterRole { WATCH POST BOTH }
```

- **Not a trigger list** (D-007): a row here never starts a run. Triggers stay in
  `agent_schedules` / webhook routes / `SPAWN` (`AppRunTriggerKind`). Q-2026-09-13-002
  (a `CHANNEL` trigger kind) is out of scope.
- **Defaults are materialised** (D2): install writes a real App-owned row for the App's
  default Channel; a migration writes them for existing installs (§7.3). Rejected:
  derived-and-unstored ("cannot be switched off"), builder-declared ("a forgotten line
  makes a hermit").
- **Each owner removes its own rows; an App may not remove an org row; an App may remove
  the install-created default** (D4).
- **Not exportable** (D-2026-08-25-006, standing): platform instrumentation, not memory
  content. Excluded from memory export and git mirror.

### 3.6 `ChannelReadState` (D-009)

```prisma
/// Per Agent per Channel: where this Agent is up to. OUTSIDE the register (D-009
/// rejected a cursor on the register row: "mixes what-I-attend with where-I-am and
/// the relay would keep a second copy").
model ChannelReadState {
  agentId     String
  channelId   String
  lastSeenSeq Int      @default(0) @map("last_seen_seq")
  updatedAt   DateTime
  @@id([agentId, channelId])
}
```

- Keyed on **Agent**, not Worker or App, as decided. The relay's per-(app, worker) state
  file watermark "moves in" here (D-009) — the relay reads and advances this row.
- **Mute is session state, never register or read-state** (D16 local). No column.

## 4. Resolution logic

### 4.1 The active-organization ladder (D-003)

One function, `resolveActiveOrg(principal, {namedOrgRef?, activeAppId?, storedOrgId?})`,
used by the MCP tools and by the CLI through GraphQL:

1. named in the call (`orgId` / `orgRef`) → membership-gated as `cor:api:100:01` already
   is (no admin bypass);
2. the active App's organization **only when the App is org-owned** (`App.organizationId
   IS NOT NULL`; a personal App per spec 047 has none — Holger's correction);
3. the explicitly set org (`McpSessionState.organizationId`, `hadron_set_active_org`);
4. the caller's single membership (`getMemberOrgIds` returns exactly one);
5. refusal, **with the member list** (a typed `ORG_REQUIRED` carrying the caller's
   memberships so the next call can name one).

Selecting an org activates the `cor:api:100` org view; there is **no "org default
scope"** (D-003). **§12 item 3** asks what step 5 means for a caller with **zero**
memberships, which spec 048 made an ordinary state.

### 4.2 The scope ladder (D-002), for search and node listing ONLY

`resolveSearchScope(principal, {named?, storedScopeId?, activeAppId?, activeOrgId})`
returns `{ memoryIds: string[] (ordered), label: string, dropped: Memory[] }`:

1. a scope **named in the call** (`scope` argument; the reserved `global` = the active
   org's `cor:api:100` view, `app` = the active App's attached memories);
2. the session's active scope (`McpSessionState.scopeId`);
3. the active App ⇒ `app` — `AgentMemoryItem` rows of its installed Agents + its
   provisioned App memories, i.e. what `getAppMemoryAccess` already computes;
4. the active organization (§4.1) ⇒ `global`;
5. refusal with the member list (falls out of §4.1 step 5).

Then **S2**: `memoryIds ∩ accessible`, dropped memories reported through **S3** as
`scope_narrowed`. Name resolution across owners is **S1**'s precedence, namespaced.

**Where it lands:** `findNodes` (`resolvers.query.node.ts`, the "accessible ∩ requested"
block ~l.934 is the one intersection D-004 names), `globalSearch`'s node slice (it
already calls `findNodes` as executor, D-2026-06-30-002), and the MCP mirrors
`hadron_find_nodes` / `hadron_list_nodes` / `hadron_search`. **Entity listings
(`memories`, `apps`, `agents`, `hadron_list_memories`) do NOT narrow** — `cor:acl:020:03`
rules 2–5 keep governing them; the amendment goes through the rule's own exit ("a
surface specified to be App-scoped by definition is not a broad listing") and reaches
search and node listing only.

**Precedence when a caller passes both `scope` and `memoryUrns`:** **open.** The design
says filters stay per call and a scope selects memories; whether an explicit memory set
is a *further* narrowing of the scope or *replaces* it is not stated. Recommendation:
`memoryUrns` narrows within the scope (a filter), and the envelope says so — but this is
a choice, flagged in §12 item 6.

**Scopes never dedupe** (D-005: "general search has no winners"). Same-address nodes from
different memories are all returned with full URNs; scope **order** is consumed only by
the stubbed task-customization operation, never by search.

### 4.3 `resolveRegister` (D5 local, D-007) — one resolver, every consumer

`resolveRegister({ agentId, appId, organizationId, actor? }) → RegisterView`, where a
view row is `{ entry, channel: {id, name, kind, memoryUrn, lastSeq, lastMessageAt},
readState?: {lastSeenSeq}, canRead, canPost, disclosure?: S5 code, agentUrn }`.

- Collects rows from all three owners for this (agent, app, org) per **§12 item 1**'s
  answer on the subject column; App › Agent › org precedence applies **per Channel** (one
  view row per Channel; the winning owner's `role` / `mentionOnly` stand, the losers are
  not unioned).
- Joins the Channel watermark (Holger, turn 012) and the Agent's read-state.
- `canRead` / `canPost` are the **existing** host-memory gates evaluated for the actor
  (`requireTeamChatAccess`'s user branch / `canWriteToMemory`) — the register grants
  nothing (D-008). An entry the actor cannot act on is **returned with S5's reason and the
  Agent's URN**, watch-only, never dropped (D11).
- `actor` is optional because the run snapshot at mint has an on-behalf-of user and the
  relay has an App key; when absent, `canPost` is reported as `UNKNOWN_ACTOR`, not
  guessed.

Consumers, all in Phase 6: the boot briefing (**derived data**, appended by the server
after the template renders — never an authored prompt part, which is the note owed to the
2026-09-10 prompt-policy discussion), `hadron_whoami` (`src/mcp/server.ts` ~l.5983),
the headless-run snapshot at mint (stored on the run beside `policy`), and a GraphQL
`agentRegister(agentRef, appRef)` query the relay reads **instead of its configured
`appRef`**.

### 4.4 The attention section (D-009)

Per hop in `executeAppRunInner` (`src/jobs/appRuns.ts`), after `deps.assemble(...)`
returns the instructions and before the LLM call, the kernel appends a CPU-computed
section:

```
## Channels (attention)
- <channel name> (<memoryUrn>:<loc>): 3 new since seq 41 (now 44)    ← lastSeq − lastSeenSeq
- <dm channel>: nothing new
```

- **Computed from the run's register snapshot ∩ live `Channel.lastSeq` ∩ the Agent's
  `ChannelReadState`** — one comparison per Channel, no model call.
- **The cursor advances in the same checkpoint write as the hop** (D-009 rejected
  "catch-up at start only": "a long run goes deaf after its first hop"). Today the
  checkpoint is a guarded `appRun.updateMany({status:'RUNNING'})` (~l.910); it becomes a
  transaction of that update plus the `ChannelReadState` upserts, still guarded so a
  concurrent cancel is never overwritten. A resumed run therefore re-reads nothing it saw.
- `mentionOnly` entries list only new messages whose stored `data.mentions` names the
  Agent's worker token — **see §12 item 5**: that is a small query over the new seq
  window, not the "no message fetch" the registry describes literally.
- Content of the new messages is **not** injected. The section says *that* and *how
  many*; the Agent reads with the Channel-addressed read tool (Phase 8) if it chooses.

## 5. Surfaces per phase

All GraphQL; MCP mirrors named where the desktop track needs them. Every new
`<entity>(ref)` / `<entity>s(filter, orgId?, limit, offset)` pair follows
`conventions:uniform-read-surface` (`cor:api:120`) and `<entityRef>` naming
(`cor:api:140`); mutations are `create/update/delete<Entity>`.

| Phase | GraphQL | MCP |
|---|---|---|
| 1 Active org | (none — `orgId` exists on the queries) | `hadron_set_active_org(orgRef)`, clearable; `ORG_REQUIRED` refusal carrying memberships; `hadron_server_info` capability token |
| 2 Scopes | `scope(ref)`, `scopes(filter{owner}, orgId)`, `createScope(input{ownerRef, name, description, memoryRefs[]})`, `updateScope`, `deleteScope`, `scopeExplain(scopeRef \| name, appRef?) → {memories[], dropped[], winnerFor(loc)?}` | `hadron_scope_explain`; CRUD via GraphQL (the CLI's job — hadron-cli#578) |
| 3 Ladder | `findNodes(scope: String)`, `globalSearch(scope)`, `FindNodesResult.scope {name, ownerUrn, memoryUrns[], degraded}`, `outsideScopeCount: Int` (when cheap, tunable) | `hadron_set_active_scope(scopeRef)`, clearable; `scope` arg on `hadron_find_nodes` / `hadron_list_nodes` / `hadron_search`; `scope:` envelope line |
| 4 Channel | `channel(ref)`, `channels(filter{appRef \| memoryRef}, orgId)`, `createChannel(input{memoryRef, loc, name, kind, description})` (App admin / org CONTRIBUTOR+, D6), `updateChannel`, `deleteChannel` (soft; **§12 item 7** on what deletion means for a protected loc); `App.defaultChannel` | `hadron_list_channels(app)`, `hadron_create_channel` |
| 5 Register | `registerEntry(ref)`, `registerEntries(filter{ownerRef \| channelRef \| agentRef})`, `createRegisterEntry(input{ownerRef, channelRef, role, mentionOnly, description})`, `updateRegisterEntry`, `deleteRegisterEntry` (owner-removes-own; App may not remove org) | `hadron_register_add` / `hadron_register_remove` (MCP names **open**; the CLI verb set is hadron-cli's) |
| 6 resolveRegister | `agentRegister(agentRef, appRef) → [RegisterViewRow]`; briefing block on `startSession` / `Worker.prompt`; `AppRun.registerSnapshot` | `hadron_whoami` prints the register per bound row; `hadron_get_worker` too |
| 7 Read-state | `channelReadState(agentRef, channelRef)`, `advanceChannelReadState(agentRef, channelRef, seq)` (the relay's write) | (kernel-internal; nothing new) |
| 8 Channel-addressed chat + DMs | `channelMessages(channelRef, sinceSeq, mentionsRef, limit)`, `createChannelMessage(channelRef, body, sessionRef, replyToSeq)` — the existing `teamChatMessages` / `createTeamChatMessage` become the `appRef → App.defaultChannel` convenience over these; `openDirectChannel(participantRefs[2])`; system announcements | `hadron_team_chat_read/post` gain `channel`; `hadron_channel_read/post` |

## 6. Phases, order, dependencies

Two tracks after Phase 0. The lens track (1–3) and the Channel track (4–8) are
independent of each other until Phase 6 (the briefing renders both lists) and Phase 8
(a DM channel search is just search).

```
Phase 0 ── shared pieces S1–S3, S5 · measurement (§9) · spec-043 plan amendment (I)
   │
   ├── Phase 1  active org (B)          ──┐
   │      Phase 2  Scope table + CRUD + explain (A₁)   │ lens track → #1150
   │      Phase 3  ladder + disclosure + run snapshot (A₂, D-004) ──┘
   │
   └── Phase 4  Channel + eager creation + S4 protected loc + migration (C) → closes #1047
          Phase 5  register table + install default + migration (D)   [blocked: §12 item 1]
          Phase 6  resolveRegister + consumers (E)
          Phase 7  read-state + watermark + attention section + checkpoint (F)
          Phase 8  Channel-addressed chat ops + DM pairs + announcements (G, H) → into #1048
```

**Cut guidance for the coordinator** — each phase is one issue and, by this team's bias,
one PR; Phase 0 may be split into "S1+S2+S3+S5 helpers" and "measurement", since the
measurement is a report, not code. Phase 4 is the largest and should not be split
further: the row, the root, the protection and the migration are one transaction's worth
of invariants, and landing the table without the protection is the state #1047 describes.

**Ordering rationale:**

- **Phase 1 first** because the scope ladder's step 4 is the org and the org ladder is
  four small pieces on an existing column pattern. It also ships the CLI/MCP parity the
  portal has had since spec 014 — the smallest user-visible win in the plan.
- **Phase 3 after 2**, obviously; **Phase 3 carries the `cor:acl:020:03` amendment
  obligation**, so the measurement (§9) must be done — not merely started — before Phase
  3 opens, since the registry says the amendment "should be accompanied by one".
- **Phase 4 before 5**: a register row is an FK to a Channel. Phase 4 also closes #1047
  on its own, which is why it is worth landing even if Phase 5 waits on §12 item 1.
- **Phase 7 after 6**: the attention section reads the run's register snapshot.
- **Phase 8 last**: it is where #1048's open questions live (host memory of a
  human↔worker DM, §12 item 4), and everything before it is useful without DMs.

## 7. Migrations — separate from the new tables

Migration directories follow the repo's hand-typed `YYYYMMDDHHMMSS_<name>` convention.
Every CHECK lives in **three** places (migration, `prisma/post-push.sql`,
`src/test/globalSetup.ts`) — `hrn:node:hadronmemory.com:hadron-server:review:non-prisma-ddl-sync`;
never add a CHECK with `IF NOT EXISTS`.

### 7.1 Phase 4 — existing team chats → Channel rows

- For every `chats:team` root in an app-class memory (`locateTeamChatRoot`'s scan, i.e.
  `Node.loc = 'chats:team'` + `nodeType='chat'` in `class='app'` memories): insert one
  `Channel {memoryId, loc:'chats:team', name:'team', kind:CHAT, chatRootNodeId,
  lastSeq: <allocator's high-water mark>, lastMessageAt}` and set the owning App's
  `defaultChannelId`.
- `lastSeq` seeds from the same `GREATEST(messageCount, MAX(seq) over message nodeTypes)`
  the allocator uses (`findings:chat-seq-counter-is-a-routing-operand`) — not from
  `messageCount` alone, which the finding shows can lag.
- **Known prod collision:** the finding records `micromentor.org:mm-eng-team`'s team chat
  carrying two messages at seq 3. The migration must **not** attempt to repair it (that
  renumbers a cited seq — a human decision), and `Channel.lastSeq` tolerates it because it
  is a high-water mark, not a uniqueness claim.
- **Soft-deleted roots** (the "revived, not re-created" clause of `cor:agt:020:04`): a
  row is created for them too, since the row is what protects the address; the Channel is
  soft-deleted in step with its root. **Open** whether a Channel row should exist for a
  retired App's chat — recommendation: yes, read-only history, since the register never
  references it.
- Idempotent (`@@unique([memoryId, loc])` makes a re-run a no-op) and resumable.
- Apps with **no** team chat yet (never posted): `createApp` provisions the shared
  memory since #951 (`provisionAppSharedMemory`), so eager creation hooks there for new
  Apps; for existing Apps that never posted, the migration creates the row + root eagerly
  as well, so that "lazily on the first post" (`bootstrapTeamChat`) is retired rather
  than kept as a second path. That retirement is an **amendment to `cor:agt:020:04`**
  (its "created lazily on the first post; a read never provisions" clause) — Vera's, listed
  in §10.

### 7.2 Phase 4 — the protected loc

Whichever shape §12 item 2 chooses, the migration marks every migrated Channel's loc as
protected. If the shape is `Memory.protectedLocs` (D-2026-08-25-004), this migration also
adds that column.

### 7.3 Phase 5 — install-created default rows

For every live `AppAgent` row whose App has a `defaultChannelId`: one App-owned
`RegisterEntry {channelId: defaultChannel, role: BOTH, mentionOnly: false, description:
'Default channel (installed)'}`. **Blocked on §12 item 1** (which Agent the row is for).
Idempotent on the row's natural key once that key exists.

### 7.4 Phase 7 — relay watermark move-in

Not a server migration: the relay's state file holds the per-(app, worker) watermark. The
first `advanceChannelReadState` from a relay seeds the row from the file. Named here so the
relay's owner knows the server side expects it.

### 7.5 Session state columns

`McpSessionState.organizationId` / `scopeId` (Phase 1 / 3) and `AppRun.scopeSnapshot`
(Phase 3) are additive nullable columns — plain `db:dev-setup` territory.

## 8. Authorization — first-class review criteria

Access-control bugs here are cross-tenant leaks. The CLAUDE.md invariants and
`hrn:node:hadronmemory.com:hadron-server:review` apply to every phase; the ones specific
to this epic:

1. **Neither list grants.** A scope resolves to `requested ∩ accessible` (S2) and a
   register entry's `canRead` / `canPost` are the host memory's gates. Any code path that
   turns a Scope or RegisterEntry row into a memory id **without** the intersection is a
   leak. The intersection is a **required parameter** of the resolver, not an optional
   post-filter (`findings:a-gate-a-caller-can-omit-is-a-gate-some-caller-omits`).
2. **Disclosure must not become an existence oracle.** `scope explain` and
   `scope_narrowed` report memories the caller cannot read. Report them by **count** to
   everyone, and by **URN** only when the memory's existence is already visible to the
   caller (same org, or the scope's owner is the caller's org/App). A scope authored in
   another tenant must not enumerate that tenant's memory names to a member who cannot
   read them. The same rule for register disclosure: the *reason code* and the Agent's
   URN are always shown; the host memory's URN only when readable-or-same-org.
3. **Owner gates on the S1 triple:** org-owned rows need org CONTRIBUTOR+
   (`requireOrgRole`, `findFirst` + `deletedAt: null` on `OrgMember`); App-owned rows need
   App admin (or the user-owned App's owner); Agent-owned rows need the Agent's owner.
   Reuse `resolveRefArg` + the existing predicates; a bespoke check drifts.
4. **The org ladder is membership-gated with no admin bypass**, as `cor:api:100:01`
   already states; a platform admin selecting an org they are not a member of is refused.
5. **The protected-loc gate (S4) is write-only.** It refuses generic create / update /
   delete / move on the address and its `:`-descendants; **reads stay memory-wide**
   (D-2026-08-25-004). It sits **above** the platform-admin early-return, exactly as
   `chatLocFilter`'s team-chat refusal does (#1030) — admins skip entitlement narrowing
   and would otherwise be the one principal still able to write under a Channel.
6. **Channel reads follow the host memory; Channel posts follow the on-behalf-of user**
   (`cor:acl:030:01`, #1048's rule, D8 local). A Worker posting into a Channel hosted in
   another App is admitted iff its on-behalf-of user may write the host memory — never
   because a register row names the Channel.
7. **Session-state recovery re-authorizes** (`findings:mcp-active-app-selection-evaporates-on-reconnect`):
   a stored `organizationId` / `scopeId` is a cache of a choice, re-checked against
   current membership / scope readability on every load; a stale one is dropped and
   disclosed, never honoured.
8. **Impersonation** is read-only and single-org; `hadron_set_active_org` and the scope
   setter refuse under it; `resolveRegister` under impersonation shows the target's
   register but every `canPost` is `false` with reason `IMPERSONATION` (add to S5).
9. **App-key principals:** an App key's org is its credential (`cor:api:100`); the org
   ladder short-circuits to it; a pure App-key session bound to an agent stays
   hard-isolated to `sessionScopedMemoryIds` (#1003) — a scope named by such a caller is
   intersected with **that** set, not the App's.

## 9. The measurement owed — Q-2026-08-07-002, a deliverable with a method

The whole lens feature rests on "ingest a lot into Hadron and you are drowning in noise",
and the registry says the premise "has never been measured". D-002's amendment to
`cor:acl:020:03` should ship **with** a number. Phase 0 delivers it as a finding node
(`hrn:mem:hadronmemory.com:hadron-server`, `findings:` branch) before Phase 3 opens.

**Method** (read-only, prod, via the `ops:alpha:db-access` runbook — host `psql`, no
container `psql`):

1. **Corpus composition.** `SELECT m.class, n.node_type, count(*) FROM nodes n JOIN
   memories m … WHERE n.deleted_at IS NULL GROUP BY 1,2` — the distribution Q-2026-08-07-002
   literally asks for, per memory class.
2. **Per-memory chat share.** For every memory with ≥ 100 live nodes: the fraction that
   is `chat-message` / `record`. Report the median and the top ten. This answers whether
   noise is a property of *some* memories (a scope problem) or of *the corpus* (an
   exclusion problem).
3. **Query-level noise.** Take a fixed query set the team can defend — the 30 most
   frequent distinct terms in node **names** across `hadronmemory.com` memories — and for
   each run `findNodes` (keyword) as an org member with `orgId` set, top 20: count hits
   whose memory is not the one a human would have scoped to, and hits that are
   `chat-message`. Run once with today's default exclusion and once without.
4. **Cross-App narrowing.** Re-run the seq 534 probe shape (two Apps, one user) against
   the same query set with and without an active App, recording the result-count delta.
   That is the number the amendment should cite for "narrowing produces fewer answers,
   disclosed and recoverable".

**What the number decides:** if chat share is small and step 3 shows little cross-App
contamination, the amendment's rationale must be rewritten around *ordering and
intent* rather than noise; the ladder still ships (Holger decided it), but the spec text
must not assert what the measurement contradicts. If it is large, the rationale cites
the figures. Either way the finding node carries the SQL, the date, and the counts —
**no unmeasured quantity in prose**.

## 10. What each phase obliges elsewhere — named, not done

Nothing below is this repo's to change; the coordinator files them.

| Phase | hadron-cli (#578 + new) | hadron-portal | hadron-docs (#289 + new) | hadron-relay | specs (Vera — amendments, no citations minted here) |
|---|---|---|---|---|---|
| 1 | `hadron org use`, config key, the resolution ladder, `ORG_REQUIRED` rendering | — (portal has it) | "which organization am I in" | — | `cor:api:100` (active org on CLI/MCP) |
| 2 | `hadron scope ls\|get\|create\|update\|rm\|explain` | scope CRUD views | scope concept | — | new `cor:dmo` entry for Scope; `cor:dmo:050:09` (AgentMemoryItem = the manifest's memory list) |
| 3 | `--scope`, config scope, **every search prints its scope**, outside-scope count | scope line on search results | "what does a search cover" (#289) | — | `cor:acl:020:03` (search App-scoped by definition + disclosure clause — **with §9's measurement**), `cor:api:090` (`scope` arg, envelope `scope:` line, outside-scope count) |
| 4 | `hadron team channel list\|create\|members` | App page: Channels + participants | Channel concept | envelope carries Channel **PK** | new `cor:dmo` entry for Channel; `cor:agt:020:04` (team chat = the App's default Channel row; lazy-create clause retired); `cor:acl:030:01` restated for Channels |
| 5 | `hadron agent channels`, register add/rm | Agent page: register view | "which chats does this Agent take part in" (with #287) | — | new `cor:dmo` entry for the register (+ the "not exportable" rule from D-2026-08-25-006) |
| 6 | `--mine`, disclosure in `whoami` output | Agent page: resolved register + read-state | — | **read the register instead of `appRef`**; drop `appRef` from config | `cor:agt:010` (or `:01`): the register block is derived data in a briefing |
| 7 | — | read-state on the Agent page | — | advance read-state via GraphQL; retire the state-file watermark | `cor:agt:010`: attention section + read-state in a headless run |
| 8 | `hadron team chat` gains `--channel`; DM verbs | DM UI | — | carry Channel PK per message | `cor:agt:020:04` (Channel-addressed operations; DM pairs); spec 043 `plan.md` (Phase 0 amendment: `ChatBinding` keyed by Channel; Agents write through the Channel) |

The spec-043 amendment (in-scope item **I**) is a `plan.md` edit in **this** repo,
delivered in Phase 0 as a doc-only change: `ChatBinding.channelId` replaces `(memoryId,
messagesLoc)`; Agents never post via the Slack tool; provider-only operations deferred to
Q-2026-09-13-003. Phase 3 of 043 is not built here.

## 11. Out of scope — named so nobody fills them in passing

- CLI, portal, docs, relay implementation (§10 names what they owe).
- Spec citations: none minted. §10 says which server change obliges which amendment
  and stops.
- **Q-2026-09-13-002** — a Channel message starting a run (the run-triggers-run hazard).
  No `CHANNEL` trigger kind.
- **Q-2026-09-13-003** — provider-only operations on a bound Channel.
- **Task customization** (`STUBBED-agent-task-customization`) — the only consumer of
  scope *order*; `scopeExplain`'s `winnerFor(loc)` is built for it but the operation is not.
- Spec 043 Phase 3 itself; `ChatBinding` is not created by this plan.
- Chat search scopes A/B/C (Q-2026-08-08-004); a saved filter in a scope; retrieval
  parameters in a scope (never — retrieval-config's job).
- Team-scoped Channel visibility (waits on the team entity, Q-2026-08-25-002).
- Push delivery to sessions (#1048 keeps it out; the register makes polling cheap).
- **The prior-art claims** (Slack / Discord / Matrix / Teams admit a bot from the room's
  side) are **recalled, not verified** — they informed D-008 and appear nowhere in this
  plan as fact. Verify before any spec or doc cites them.
- Repairing the prod seq-3 collision (§7.1) — a human decision about renumbering a
  cited seq.

## 12. Reports to the coordinator — where the design is silent on something load-bearing

Not filled here. Each names the slice it blocks.

1. **The register entry has no SUBJECT.** D1's shape is `(owner, Channel, role,
   mentionOnly, description)`: the owner says who *controls* the row; nothing says which
   *Agent attends*. Two consequences the design does not address: (a) "installing an
   Agent creates an App-owned row for the App's default Channel" (D2) produces an
   indistinguishable duplicate on the second install into the same App unless the row
   carries the Agent; (b) an **Agent-owned** row "travels with the install" (D4) but holds
   an FK to one App's Channel — which cannot travel — so a builder default can only mean
   "the default Channel of whichever App installs me", a symbolic reference, not an FK.
   **Recommendation to put to Holger:** add `agentId` as a *subject* column distinct from
   the owner triple (every row names the Agent it is for; owner still exactly-one), and
   let Agent-owned rows reference `DEFAULT_CHANNEL` symbolically. **Blocks Phase 5** (§3.5,
   §7.3) and the subject half of §4.3.
2. **The protected-loc mechanism is unbuilt and unfiled.** D-2026-08-25-004 decided
   `Memory.protectedLocs` (declared per Agent in `memoryProvisioning`, unioned at
   install, App-admin-editable); D-2026-09-13-006 says a Channel row "adds [its loc] to
   the host memory's protected locs". Two shapes: (A) build D-004's general column now,
   with the Channel migration as its first writer — larger, and a second declaration
   source (`memoryProvisioning`) this plan does not otherwise touch; (B) build the gate
   (S4) with the Channel table as its **only** predicate source, and let D-004 add the
   column later as a second source behind the same predicate. **Recommendation: B** —
   the gate is the shared piece either way, and a Channel row is the one source this
   epic needs. Either way an issue for D-004 is owed. **Shapes Phase 4**; does not block
   it if B is accepted.
3. **The org ladder's refusal for a caller with no organization at all.** D-003 step 5
   refuses "with the member list"; spec 048 made org-less users ordinary, and their
   `global` view under `cor:api:100` is simply their own personal/private memories.
   Refusing them blocks search for everyone who has no org. **Recommendation:** an empty
   membership resolves to the user-owned view and the envelope says so; a caller with
   **two or more** memberships and no selection is the refusal case. **Shapes Phase 1.**
4. **The host memory of a human↔worker DM pair.** D-2026-08-25-006 settles
   Agent↔Agent DMs (the coordination App's team space, org-visible by policy); D6 local
   says DM pairs are "created by the platform on first post at a canonical address" but
   the human↔worker case — #1048's opening use — has no decided host memory, and the
   memory is the privacy boundary (D-2026-08-11-003). A DM in the App's shared memory is
   readable by every App member, which is either the intent ("anyone should be able to see
   what the Agents say") or exactly what #1048 wanted to avoid ("private, prompt
   exchange"). **Blocks Phase 8's DM half**; the Channel-addressed read/post half is
   unaffected.
5. **`mentionOnly` versus "no message fetch".** D-009's registry note says the attention
   check is "one comparison per Channel with no model call and no message fetch". A
   `mentionOnly` entry cannot be honoured without looking at the new messages' stored
   `data.mentions` — a cheap indexed query over the `(lastSeenSeq, lastSeq]` window, but a
   fetch. **Recommendation:** accept the query; keep the section content-free. Not
   blocking; recorded so the registry note is not cited as a constraint the code violates.
6. **`scope` and an explicit `memoryUrns` in the same call** (§4.2) — narrows-within or
   replaces. Not blocking (recommendation given); should be decided before Phase 3's
   envelope wording is written, since the CLI prints it.
7. **What `deleteChannel` means.** A Channel row protects an address and is one-to-one
   with a root that may hold cited history. Soft-deleting the row while the root stays
   would unprotect a live transcript; deleting the root cascades a team's record. **Open**;
   recommendation: soft-delete both together, keep the protection while either exists,
   and forbid hard delete outside a platform-admin operation. Shapes Phase 4's mutation.

## 13. Testing

- **Differential tests for every "one computation" claim**: GraphQL `findNodes` scope
  resolution vs `hadron_find_nodes`; `resolveRegister` as consumed by briefing / whoami /
  run snapshot — one fixture, every consumer, same rows (the pattern
  `resolvers.worker.test.ts` uses for liveness, `cor:agt:020:11`).
- **Mutation tests on the gates**, not only positive tests: empty the intersection (S2)
  and every "never grants" assertion must go red; remove the actor from `resolveRegister`
  and `canPost` must read `UNKNOWN_ACTOR`, not `true`. A gate whose test stays green when
  the gate is deleted measured nothing (the #1142 lesson).
- **Two audiences per refusal**: the caller's typed error *and* the operator-visible
  state — a scope that narrows to nothing must leave a `scope_narrowed` envelope, not an
  empty page that looks like "no results".
- **Migration tests** run twice (idempotency) and against a fixture carrying the seq-3
  collision shape, a soft-deleted root, and an App that never posted.
- **Checkpoint atomicity**: kill the run between the hop's side effects and the
  checkpoint; on redelivery the attention section must show the same "new" count as
  before — proves the cursor moved in the checkpoint, not before it.
- **The loader, not just the renderer**: for every consumer of `resolveRegister`, assert
  the *input* rows are identical, not only the rendered block
  (`findings:a-gate-a-caller-can-omit-is-a-gate-some-caller-omits`, corollary 1).
- Full suite locally with `HADRON_TEST_CONNECTION_LIMIT=3`; SDL/resolver argument parity
  is invisible to the suite (`findings:sdl-resolver-arg-drift-invisible-to-tests`) — the
  `graphql-sdl-parse` and `check:sdl-enums` gates plus a CLI codegen dry-run are the check.
