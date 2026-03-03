# Hadron Controller

GraphQL API, usage database, and node collection service for the Hadron graph.

Graphs are defined in `.hadron-controller.yaml` and synced from GitHub on startup.
Nodes are stored in both a PostgreSQL database and on the local filesystem.

## Prerequisites

- Node.js 20+
- PostgreSQL 15+ (or SQLite for single-developer mode)

## Quick start

```bash
npm install
cp .env.example .env   # edit DATABASE_URL, JWT_SECRET, SOURCES_PATH
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

## Configuration

Copy `.hadron-controller.yaml.example` (or create one) in the directory pointed to
by `CONFIG_PATH` (default: project root). Example:

```yaml
graphs:
  myorg/myrepo:
    source: "git@github.com:myorg/myrepo.git"
    version: "latest"
    path: "myorg/myrepo"
    updatedAt: "2026-01-01T00:00:00.000Z"
```

| Key | Description |
|-----|-------------|
| `source` | Git clone URL (SSH or HTTPS) |
| `path` | Local path relative to `SOURCES_PATH` |
| `version` | Label only — currently unused |

On startup the controller clones/pulls each graph and loads all nodes into the database.
`POST /reload` triggers a re-sync without restarting.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | Prisma connection string |
| `DB_PROVIDER` | `postgresql` | `postgresql` or `sqlite` |
| `JWT_SECRET` | — | HS256 signing secret (≥ 32 chars) |
| `SOURCES_PATH` | `./sources` | Root directory for cloned graphs |
| `CONFIG_PATH` | `.` | Directory containing `.hadron-controller.yaml` |
| `PORT` | `4000` | HTTP listen port |

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
- **API key** (hex string) — created via `db.client.create(...)` with a bcrypt-hashed key.

Roles: `ADMIN` > `CONTRIBUTOR` > `READER`.

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

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | — | Health check |
| `POST /graphql` | Bearer | GraphQL API (Apollo) |
| `POST /usage` | — | Ingest a usage event (REST, no auth) |
| `POST /reload` | — | Re-sync all graphs from GitHub |

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
