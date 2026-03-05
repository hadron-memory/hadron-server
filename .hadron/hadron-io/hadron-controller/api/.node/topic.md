## API

The controller exposes both a GraphQL endpoint (for rich queries and mutations) and lightweight REST endpoints (for high-frequency, low-overhead calls).

### GraphQL — `POST /graphql`

Uses Apollo Server 4 with `expressMiddleware`. Auth context is resolved per-request from the `Authorization` header (JWT or API key).

Schema files:
- `src/api/graphql/schema/typeDefs.ts` — SDL type definitions
- `src/api/graphql/schema/resolvers.ts` — resolver implementations

#### Queries

| Query | Auth | Description |
|---|---|---|
| `node(loc)` | any | Get a single node by dotted loc |
| `nodes(namespace, tags, search, limit)` | any | Search/filter nodes |
| `subtree(prefix)` | any | All nodes whose loc starts with prefix |
| `nodeUsage(loc, limit)` | any | Recent usage events for a node |
| `sessions(type, repo, customerId, limit)` | any | List sessions |
| `session(id)` | any | Single session with events |
| `clients` | ADMIN | All API key clients |
| `client(label)` | ADMIN | Single client by label |
| `users` | ADMIN | All registered users |
| `me` | any (authenticated) | Current user from JWT |

#### Mutations

| Mutation | Auth | Description |
|---|---|---|
| `upsertNode(input)` | CONTRIBUTOR | Create or update a node |
| `deleteNode(loc)` | CONTRIBUTOR | Delete a node |
| `replaceSubtree(namespace, ownerRepo, nodes, edges)` | CONTRIBUTOR | Atomically replace a namespace (used by collection tool) |
| `startSession(input)` | any | Start tracking a session |
| `endSession(id, summary, tokens, ...)` | any | Mark session complete |
| `recordUsage(event)` | any | Record a usage event |
| `createClient(label, type, role, ...)` | ADMIN | Create an API key client (returns raw key once) |
| `revokeClient(label)` | ADMIN | Delete a client |
| `updateUserRole(userId, role)` | ADMIN | Change a user's role |

#### JSON Scalar

`outcomeMeta` (on Session) and `actionArgs` (on UsageEvent) are typed as the GraphQL `JSON` scalar. The resolver uses field-level resolvers to deserialize SQLite's JSON strings back to objects.

### REST Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Health check → `{ ok: true }` |
| `GET` | `/auth/github` | none | Start GitHub OAuth flow |
| `GET` | `/auth/github/callback` | none | OAuth callback (exchanges code, issues JWT, redirects) |
| `GET` | `/auth/me` | JWT | Current user info |
| `POST` | `/usage` | none | Ingest a single UsageEvent (high-frequency, no GraphQL overhead) |
| `POST` | `/sessions/:id/outcome` | none | Report session outcome (0.0–1.0, for CRM webhooks etc.) |
| `POST` | `/reload` | none | Re-sync all graphs from GitHub |

### Field Resolvers for SQLite Compatibility

Three models have field resolvers that transparently deserialize SQLite-stored strings back to native types before GraphQL serialization:

```ts
Node.tags        // String → string[]  (JSON.parse)
Session.outcomeMeta   // String → object   (JSON.parse)
UsageEvent.actionArgs // String → object   (JSON.parse)
```

PostgreSQL stores these as native `String[]` and `Json`, so the deserializers are no-ops there.
