# Contract — `createMemory` (personal/private) + class-driven authorization

Behavioral contract for the surfaces this feature changes. Typed errors per
constitution S2/Principle III (stable `extensions.code`, no raw Prisma/`new Error`).

## GraphQL — `createMemory`

**Now accepts** `class ∈ {knowledge, group, personal, private}` (was
`knowledge`/`group` only).

Input (relevant): `{ name, class, appId?, visibility?, encrypted? }`. The
`createMemory` mutation signature in `typeDefs.ts` MUST be extended to add `appId`
and `encrypted` (and the broadened `class`) — this is a tracked implementation task
in [plan.md](../plan.md).

Server behavior:

| class | owner set to | app_id | visibility | encrypted | notes |
|---|---|---|---|---|---|
| `personal` | caller `userId` | optional (`(app,user)`) or NULL (free-standing) | NULL (forced) | false | requires a **user** caller |
| `private` | caller `userId` | optional or NULL | NULL (forced) | caller value or false (opt-in) | user caller; never shareable |
| `knowledge` | org/agent | NULL | `PUBLIC` \| `ORGANIZATION` (default ORGANIZATION) | false | unchanged |
| `group` | (deferred path) | NULL | `GROUP` | false | unchanged |

Rejections (typed):

| Caller / input | Result |
|---|---|
| App-key (no `userId`) creating `personal`/`private` | typed error — owner-only memory needs a user owner |
| `visibility` passed for `personal`/`private` | **typed rejection** (`BAD_USER_INPUT`) — those classes carry NULL visibility |
| `encrypted=true` on non-`private` | rejected — only `private` may encrypt |
| create `MemoryShare` targeting a `private` memory | rejected at share-create |

## Authorization by class (`resolveMemoryAuthorization` + MCP gate + GraphQL surfaces)

| class | read | write |
|---|---|---|
| `system` | app members | builder (agent owner) only |
| `app` | app members | app members |
| `knowledge` | `ORGANIZATION`→org members; `PUBLIC`→anyone incl. unauthenticated | members |
| `personal` | owner (`userId`); `MemoryShare(reader\|writer)` grantee | owner; `MemoryShare(writer)` |
| `private` | owner only | owner only |

- **No ADMIN/OWNER bypass** for `personal`/`private`. **No org path.**
- **Free-standing** (`app_id NULL`) `personal`/`private`: allow iff
  `caller === Memory.userId` — **no** agent / `AgentSubscription` requirement.
- Optional agent-on-behalf branch may apply when an agent context matches the
  memory's scope, but is never required.

Read-surface parity (all honor class owner-only for `personal`/`private`, and
`PUBLIC` for knowledge): `Query.memory`, `Query.myMemories`,
`Organization.memories`, node reads/search via `getAccessibleMemoryIds` /
`memoryAccessFilter`, the MCP `h-list-memories` + node tools.

Active-app: a **restriction-only** mask on the result set (FR-012) — never widens,
never changes a decision.

Errors reuse the existing typed `MemoryNotFoundError` / forbidden codes; no new raw
errors cross the boundary.
