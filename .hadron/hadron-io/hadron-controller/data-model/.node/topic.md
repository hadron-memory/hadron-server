## Data Model

The Prisma schema lives in `prisma/schema.postgresql.prisma` (production) and `prisma/schema.sqlite.prisma` (development). Both schemas define the same six models.

### Models

#### Node
Represents a single node in a Hadron graph.

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | Primary key |
| `loc` | String (unique) | Dotted path, e.g. `micromentor-org.mmdata.services` |
| `name` | String | Human-readable label |
| `alias` | String? | Alternative name |
| `description` | String? | One-liner |
| `content` | String? | Full `topic.md` text |
| `tags` | String[] | PostgreSQL native array; JSON string in SQLite |
| `namespace` | String | First two `loc` segments, e.g. `micromentor-org.mmdata` |
| `ownerRepo` | String | GitHub repo slug, e.g. `micromentor-team/mmdata` |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | Auto-updated |

Indexes on `namespace`. Relations to `Edge` (outgoing and incoming) and `UsageEvent`.

#### Edge
A directed relationship between two nodes.

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | Primary key |
| `sourceId` | String | FK → Node |
| `targetId` | String | FK → Node |
| `label` | String? | The `rel` field from node.yaml |

Unique constraint on `(sourceId, targetId)`. Cascade-deletes when either node is deleted.

#### Session
Tracks an AI agent or chatbot session from start to end.

| Field | Type | Notes |
|---|---|---|
| `id` | String | Caller-generated (UUID from h-start-session) |
| `type` | String | `developer`, `chatbot`, `automation`, `edge` |
| `clientId` | String? | API key label or `github:<login>` |
| `repo` / `branch` / `prNumber` | | Git context |
| `customerId` | String? | Tenant/customer for chatbot sessions |
| `llmModel` | String? | e.g. `claude-sonnet-4-6` |
| `inputTokens` / `outputTokens` | Int? | Token usage |
| `turnCount` / `errorCount` | Int? | Quality metrics |
| `parentSessionId` | String? | Sub-agent parent (vertical chain) |
| `prevSessionId` | String? | Same work thread (horizontal chain) |
| `outcome` | Float? | 0.0–1.0, reported externally |
| `outcomeRef` | String? | URL or GUID of the outcome record |
| `outcomeMeta` | Json? | Domain-specific detail blob |
| `startedAt` | DateTime | Auto-set |
| `endedAt` | DateTime? | Set by h-end-session |

#### UsageEvent
Every node access, action run, or tool call produces a record here.

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | Primary key |
| `type` | String | Free-form event type (e.g. `h-view-node`, `h-run-action`) |
| `nodeLoc` | String? | Which node was accessed (stored directly, survives node deletion) |
| `nodeId` | String? | FK → Node (nullable, set if node exists at event time) |
| `actionArgs` | Json? | Key-value args for action runs |
| `clientId` | String? | Who made the call |
| `sessionId` | String? | FK → Session |
| `createdAt` | DateTime | |

#### Client
A machine client that authenticates with an API key.

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | |
| `label` | String (unique) | Human-readable name, e.g. `mmdata-ci` |
| `keyHash` | String | bcrypt hash of the raw token (shown once at creation) |
| `type` | ClientType | `WORKSTATION`, `CLOUD`, `IOT`, `AGENT` |
| `role` | Role | `ADMIN`, `CONTRIBUTOR`, `READER` |
| `namespace` | String? | For CONTRIBUTOR — restricts writes to this prefix |
| `expiresAt` | DateTime? | Optional expiry |

#### User
A human user who signed in via GitHub OAuth.

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | |
| `githubId` | Int (unique) | Stable identifier from GitHub |
| `login` | String | GitHub username |
| `name` | String? | Display name from GitHub profile |
| `avatarUrl` | String? | |
| `role` | Role | Persists across logins; first login defaults to `READER` |

### Enums

```
Role:       ADMIN | CONTRIBUTOR | READER
ClientType: WORKSTATION | CLOUD | IOT | AGENT
```

### Schema Files

| File | Used when |
|---|---|
| `prisma/schema.postgresql.prisma` | Production, `npm run db:use-pg` |
| `prisma/schema.sqlite.prisma` | Development, `npm run db:use-sqlite` |
| `prisma/schema.prisma` | Active symlink, used by Prisma CLI |

The generated client is output to `src/generated/prisma/`.
