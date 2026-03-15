# Hadron Controller

GraphQL API, graph sync engine, and usage database for the Hadron knowledge graph platform.

Graphs are managed through the GraphQL API (via hadron-web) and synced from GitHub.
Nodes are stored in PostgreSQL and cloned locally for filesystem operations.

## Prerequisites

- Node.js 20+
- PostgreSQL 15+ (or SQLite for single-developer mode)

## Quick start

```bash
npm install
cp .env.example .env   # edit DATABASE_URL, JWT_SECRET, HADRON_ENCRYPTION_KEY
```

### PostgreSQL (default)

```bash
npm run db:push        # push schema to database (first time)
npm run dev            # http://localhost:4000
```

### SQLite (single-developer / offline)

No external database required — everything lives in a single file.

```bash
# 1. Switch the Prisma schema to SQLite and regenerate
npm run db:use-sqlite

# 2. Push the schema
DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" npx prisma db push

# 3. Start the server
DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" npm run dev
```

To switch back to PostgreSQL:

```bash
npm run db:use-pg
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | Prisma connection string |
| `DB_PROVIDER` | `postgresql` | `postgresql` or `sqlite` |
| `JWT_SECRET` | — | HS256 signing secret (≥ 32 chars) |
| `HADRON_ENCRYPTION_KEY` | — | AES-256-GCM key for encrypting secrets at rest (32 bytes, hex) |
| `GRAPHS_PATH` | `./graphs` | Root directory for cloned graph repos |
| `PORT` | `4000` | HTTP listen port |
| `BASE_URL` | `http://localhost:4000` | Public URL (used for OAuth callback) |
| `FRONTEND_URL` | `http://localhost:5173` | hadron-web URL (OAuth redirect, CORS) |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth app client secret |
| `GITHUB_WEBHOOK_SECRET` | — | GitHub App webhook verification secret |
| `JWT_EXPIRY` | `7d` | JWT token lifetime |

See `.env.example` for the full list with generation instructions.

## Node filesystem format

Each node is a directory containing a `.node/` subdirectory:

```
myorg/myrepo/
  services/
    .node/
      node.yaml      # name, description, tags, outgoing edges
      topic.md       # markdown content
```

`node.yaml` example:

```yaml
name: services
description: "Service layer"
tags: [backend, api]
nodes:
  - loc: models          # relative loc of target node
    rel: "depends on"
```

The node's `loc` is derived from its path relative to the graph root, with `/`
replaced by `.` (e.g. `services/auth` → `services.auth`).

## Authentication

Two token types are accepted via `Authorization: Bearer <token>`:

- **JWT** (contains dots) — issued after GitHub OAuth login; carries `sub`, `login`, `role`.
- **API key** (hex string) — created via the GraphQL API with a bcrypt-hashed key.

Roles: `OWNER` > `ADMIN` > `CONTRIBUTOR` > `READER`.

## Graph access control

Node queries and mutations enforce graph-level access control:

- **Users** see nodes from their organizations + cross-org subscriptions + public graphs
- **Clients** see only nodes from graphs in their subscribed bundles
- **Writes** require CONTRIBUTOR+ role, and for clients: a READ_WRITE bundle subscription

See `hadron-concept/hadron-specs/Authorization/Graph Access Control.md` for the full spec.

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | — | Health check |
| `POST /graphql` | Bearer | GraphQL API (Apollo) |
| `POST /usage` | — | Ingest a usage event (REST) |
| `POST /reload` | — | Re-sync all graphs from GitHub |
| `GET /auth/github` | — | Start GitHub OAuth flow |
| `GET /auth/github/callback` | — | OAuth callback |
| `GET /auth/me` | Bearer | Current user info |
| `POST /github/webhook` | HMAC | GitHub App webhook receiver |
| `POST /mcp` | Bearer | MCP protocol endpoint |

## Testing

Tests require a `hadron_test` PostgreSQL database. Create it once:

```bash
npm run db:test-setup
```

Then run:

```bash
npm test                # run all tests
npm run test:watch      # watch mode
npm run test:coverage   # with coverage report
```

Tests use Vitest with `pool: 'forks'` (one process per file) and `fileParallelism: false`
to prevent concurrent writes to the shared test database.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled server |
| `npm test` | Run all tests |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Coverage report |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:push` | Push schema to database |
| `npm run db:migrate` | Run Prisma migrations (PostgreSQL) |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:use-pg` | Switch to PostgreSQL schema |
| `npm run db:use-sqlite` | Switch to SQLite schema |
| `npm run db:test-setup` | Create/update the `hadron_test` database |

## Database provider adapter

`src/integrations/db/provider.ts` abstracts the differences between the two engines.
The server reads `DB_PROVIDER` at startup:

| Feature | PostgreSQL | SQLite |
|---------|-----------|--------|
| Tags | `String[]` (native array) | `String` (JSON-serialized) |
| JSON fields | `Json` type | `String` (JSON-serialized) |
| Tag filter | Prisma `hasEvery` | `AND` + `contains` on JSON string |
| Case-insensitive search | `mode: 'insensitive'` | Omitted (SQLite LIKE is already case-insensitive) |
| Enums | `enum Role / ClientType` | `String` with defaults |

## Architecture

For deeper architecture documentation, see the hadron nodes in
[.hadron/hadron-io/hadron-controller/](.hadron/hadron-io/hadron-controller/).
