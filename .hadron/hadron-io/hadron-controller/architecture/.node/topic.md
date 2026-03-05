## Architecture

### System Diagram

```
                        ┌─────────────────────────────────────────┐
                        │           hadron-controller              │
                        │                                         │
  Browser / UI  ──────► │  /auth/github  →  GitHub OAuth          │
  GitHub App    ──────► │  /auth/me      →  JWT validation        │
                        │                                         │
  AI agents     ──────► │  POST /graphql  (Apollo Server)         │
  MCP clients   ──────► │  POST /usage    (REST, no auth)         │
  CI tools      ──────► │  POST /reload   (trigger sync)          │
                        │                                         │
                        │  ┌──────────────────────────────────┐  │
                        │  │  controller/                     │  │
                        │  │    startup()   ← runs on boot   │  │
                        │  │    syncGraphFromGithub()         │  │
                        │  │    findGraph / createNode /...   │  │
                        │  └──────────────────────────────────┘  │
                        │           │               │             │
                        │    integrations/    integrations/       │
                        │      github/          localFs/          │
                        │    (git clone/pull) (parse .node/)      │
                        │           │               │             │
                        │           └───────────────┘             │
                        │                   │                     │
                        │           integrations/db/              │
                        │         (Prisma + PostgreSQL/SQLite)    │
                        └─────────────────────────────────────────┘
```

### Directory Structure

```
src/
  index.ts               Entry point — boots server, triggers startup()
  server.ts              Express app, routes, Apollo middleware
  config.ts              Reads .hadron-controller.yaml, exports SOURCES_PATH
  enums.ts               Role and ClientType enums

  auth/                  GitHub OAuth flow + JWT helpers
    github.ts            buildAuthUrl, exchangeCode, fetchUser, checkOrgMembership
    jwt.ts               signJwt, verifyJwt (jose, HS256, 7-day expiry)

  middleware/
    auth.ts              resolveAuthContext — JWT vs API key detection

  api/graphql/schema/
    typeDefs.ts          GraphQL schema (SDL)
    resolvers.ts         All query and mutation resolvers

  controller/            Business logic layer
    controller.ts        Barrel export
    startup.ts           Syncs all configured graphs on boot
    operations/
      findGraph.ts       Load graph from DB by namespace
      createNode.ts      Save to FS + upsert in DB
      updateNode.ts      Delegates to createNode
      createUsageEvent.ts  Persist usage telemetry

  integrations/
    db/                  Database client and provider abstraction
      client.ts          Prisma client singleton
      provider.ts        PostgreSQL/SQLite serialization helpers
    localFs/             Filesystem integration
      loadNodeFromFs.ts  Parse .node/node.yaml + topic.md → Node
      saveNodeToFs.ts    Write Node back to .node/ directory
      loadGraphFromFs.ts Walk directory tree → HadronGraph + edges
      loadAllGraphsFromFs.ts  Load all graphs from config
    github/
      syncGraphFromGithub.ts  git clone/pull → load FS → upsert DB
```

### Request Lifecycle (GraphQL)

1. Client sends `POST /graphql` with `Authorization: Bearer <token>`
2. `resolveAuthContext(req, db)` in `middleware/auth.ts`:
   - Token with dots → verify JWT → `{ userId, clientId, role }`
   - Token without dots → bcrypt-compare against `Client.keyHash` → `{ clientId, role, namespace }`
3. Context `{ db, clientId, userId, role, namespace }` passed to Apollo resolvers
4. Resolver checks role via `requireRole(ctx, 'CONTRIBUTOR')` before mutating
5. Result returned as GraphQL response

### Request Lifecycle (Graph Sync)

1. Boot or `POST /reload` → `controller.startup()`
2. `startup()` reads `.hadron-controller.yaml`
3. For each graph: `syncGraphFromGithub(name)`
   - `git clone` or `git pull` into `SOURCES_PATH/<graph.path>`
   - Walk filesystem for `.node/` directories
   - Parse `node.yaml` + `topic.md` for each node
   - Transaction: delete old namespace rows, insert new nodes + edges
