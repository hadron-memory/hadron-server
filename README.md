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
| `RESEND_API_KEY` | — | Resend API key for magic-link emails |
| `EMAIL_FROM` | `Hadron <noreply@hadrongraph.io>` | Sender address for emails |
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

- **JWT** (contains dots) — issued after GitHub OAuth or email magic-link login; carries `sub`, `roles`, and provider-specific claims.
- **API key** (hex string) — created via the GraphQL API with a bcrypt-hashed key.

Two identity providers are supported:

- **GitHub OAuth** — `GET /auth/github` starts the flow; user is redirected back with a JWT.
- **Email magic link** — `POST /auth/email` sends a sign-in link via Resend; clicking it verifies the email and issues a JWT.

Roles: `OWNER` > `ADMIN` > `CONTRIBUTOR` > `READER`.

## Graph access control

Node queries and mutations enforce graph-level access control:

- **Users** see nodes from their organizations + cross-org subscriptions + public graphs
- **Clients** see only nodes from graphs in their subscribed bundles
- **Writes** require CONTRIBUTOR+ role, and for clients: a READ_WRITE bundle subscription

See `hadron-concept/hadron-specs/Authorization/Graph Access Control.md` for the full spec.

## GitHub integration

Hadron integrates with GitHub in two ways: **OAuth** for user authentication and a **GitHub App** for graph synchronization.

### GitHub OAuth (user login)

Users log in via the standard GitHub OAuth flow (`/auth/github` → GitHub → `/auth/github/callback`). On first login, a User record is created and linked to the user's GitHub login. A JWT is issued for subsequent API calls.

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a GitHub OAuth App.

### GitHub App (graph sync)

Graphs are stored as Git repositories on GitHub. A GitHub App provides authenticated access for cloning and pushing to these repos.

**Credentials** are stored per-organization in the database (`githubAppId`, encrypted private key). This allows multi-tenant setups where each org uses its own GitHub App. If no per-org credentials exist, the server falls back to the `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` environment variables.

**Authentication flow:**
1. The server signs a short-lived JWT with the App's private key
2. Exchanges it for a 1-hour installation access token via the GitHub API
3. Uses the token to clone/push repos over authenticated HTTPS

Private keys are encrypted at rest using AES-256-GCM (see `HADRON_ENCRYPTION_KEY`). The server handles PKCS#1 → PKCS#8 key format normalization automatically.

### Webhooks

The `/github/webhook` endpoint receives GitHub App events. Payloads are verified using HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`.

**Installation events:**
- **`installation.created`** — When the App is installed on a GitHub org, the controller matches the GitHub org name to a Hadron organization (by domain) and stores the installation ID.
- **`installation.deleted`** — When the App is uninstalled, the installation ID is cleared.

**Push events (auto-sync):**
- When a push to the repository's default branch is received, the controller finds all graphs whose `source` URL matches the repository and triggers a sync. If a graph has a `readBranch` set, only pushes to that branch trigger a sync.

### Graph sync flow

On startup (and via `POST /reload`), the controller syncs all graphs that have a `sourceUrl`:

1. Obtains an installation token for the graph's organization
2. Clones (or pulls) the repo into `GRAPHS_PATH/<namespace>`
3. Walks the filesystem for `.node/` directories
4. Upserts nodes and edges into PostgreSQL

When a node is modified via the API, the change is written back to the local clone.

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | — | Health check |
| `POST /graphql` | Bearer | GraphQL API (Apollo) |
| `POST /usage` | — | Ingest a usage event (REST) |
| `POST /reload` | — | Re-sync all graphs from GitHub |
| `GET /auth/github` | — | Start GitHub OAuth flow |
| `GET /auth/github/callback` | — | OAuth callback |
| `POST /auth/email` | — | Send magic-link email |
| `GET /auth/email/verify` | — | Verify magic link and issue JWT |
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
