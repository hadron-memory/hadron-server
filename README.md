# Hadron Controller

GraphQL API, MCP server, graph sync engine, and usage database for the [Hadron](https://hadrongraph.io) knowledge graph platform.

Serves both **consumer** and **enterprise** users. On sign-up, each user gets a personal workspace (auto-provisioned org, API key, default bundle) so they can connect their AI tool within minutes. Organizations, teams, and advanced graph management are available when needed.

Graphs are managed through the GraphQL API (via hadron-web) and optionally synced from GitHub.
Nodes are stored in PostgreSQL and cloned locally for filesystem operations.

## Prerequisites

- Node.js 20+
- PostgreSQL 15+ (or SQLite for single-developer mode)

## Quick start

```bash
pnpm install
cp .env.example .env   # edit DATABASE_URL, JWT_SECRET, HADRON_ENCRYPTION_KEY
```

### PostgreSQL (default)

```bash
pnpm run db:push        # push schema to database (first time)
pnpm run dev            # http://localhost:4000
```

### SQLite (single-developer / offline)

No external database required — everything lives in a single file.

```bash
# 1. Switch the Prisma schema to SQLite and regenerate
pnpm run db:use-sqlite

# 2. Push the schema
DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" pnpm prisma db push

# 3. Start the server
DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" pnpm run dev
```

To switch back to PostgreSQL:

```bash
pnpm run db:use-pg
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
| `GOOGLE_CLIENT_ID` | — | Login-only Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | — | Login-only Google OAuth web client secret |
| `GITHUB_WEBHOOK_SECRET` | — | GitHub App webhook verification secret |
| `RESEND_API_KEY` | — | Resend API key for magic-link emails |
| `EMAIL_FROM` | `Hadron <noreply@hadrongraph.io>` | Sender address for emails |
| `JWT_EXPIRY` | `7d` | JWT token lifetime |
| `TEAM_ATTENTION_PILOT_USER_IDS` | — | Exact comma-separated User PK allowlist for the disabled-by-default #1353 pilot |
| `TEAM_ATTENTION_PILOT_APP_IDS` | — | Exact comma-separated App PK allowlist; both pilot lists must match |
| `TEAM_ATTENTION_TOKEN_SECRET` | `JWT_SECRET` | Optional separate HMAC secret for attention tokens and switchover proofs |

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

Three identity providers are supported:

- **GitHub OAuth** — `GET /auth/github` starts the flow; user is redirected back with a JWT.
- **Google OAuth** — `GET /auth/google` starts the login-only OIDC flow when configured.
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

### Google OAuth (user login)

Google login is enabled when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
set. Create a **Web application** OAuth client in a login-only Google Cloud
project and register `${BASE_URL}/auth/google/callback` as an exact authorized
redirect URI (plus `http://localhost:4000/auth/google/callback` for local
development). The client requests only `openid email profile`; do not add Gmail
scopes or reuse the Gmail mailbox-integration project.

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

On startup (and via `POST /reload`, which requires a platform ADMIN/OWNER bearer token since #556), the controller syncs all graphs that have a `sourceUrl`:

1. Obtains an installation token for the graph's organization
2. Clones (or pulls) the repo into `GRAPHS_PATH/<namespace>`
3. Walks the filesystem for `.node/` directories
4. Upserts nodes and edges into PostgreSQL

When a node is modified via the API, the change is written back to the local clone.

## Personal workspace provisioning

When a new user signs up (via GitHub OAuth or email magic link), the controller
automatically provisions a personal workspace:

1. Creates an `Organization` with `isPersonal: true`
2. Adds the user as OWNER
3. Creates a default "My Graphs" bundle
4. Creates a WORKSTATION client with an API key
5. Subscribes the client to the default bundle (READ_WRITE)
6. Stores the raw API key in a `PendingSetup` record (shown once on the setup page)

New users are redirected to `/app/setup` where they download a config file for their AI tool.

## Node version history

Every call to `upsertNode` snapshots the current node state before applying changes. This creates
a linear version history per node without requiring git branches.

- `nodeVersions(nodeId, limit)` — query version history (most recent first)
- `restoreNodeVersion(versionId)` — snapshots current state, then restores the node to a previous version

## Marketplace

The `publicGraphs` query returns all graphs with `visibility: PUBLIC`. The `addToMyGraphs` mutation
lets an authenticated user add a public graph to their personal workspace (creates a subscription
and adds the graph to their default bundle).

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | — | Health check |
| `POST /graphql` | Bearer | GraphQL API (Apollo) |
| `POST /reload` | Bearer (platform ADMIN/OWNER) | Re-sync all graphs from GitHub. Rate limited to 10/min per source address (#556) |
| `POST /sessions/:id/outcome` | Bearer (CONTRIBUTOR+ or App key) | Report a session outcome 0.0–1.0 (#556) |
| `GET /auth/github` | — | Start GitHub OAuth flow |
| `GET /auth/github/callback` | — | OAuth callback |
| `GET /auth/google` | — | Start Google OIDC login flow |
| `GET /auth/google/callback` | — | Google OIDC callback |
| `POST /auth/email` | — | Send magic-link email |
| `GET /auth/email/verify` | — | Verify magic link and issue JWT |
| `GET /auth/me` | Bearer | Current user info |
| `GET /setup/info` | Bearer | One-time setup info (API key, graphs) |
| `POST /github/webhook` | HMAC | GitHub App webhook receiver |
| `POST /mcp` | Bearer | MCP protocol endpoint |

## Docker deployment

### Running database migrations

Never run `prisma db push` or `prisma migrate` as part of the container entrypoint — if it fails, the container enters a restart loop. Instead, run migrations separately using `docker compose run`:

```bash
docker compose run --rm hadron-server npx prisma db push
```

This spins up a fresh container with all env vars from your compose file, runs the command, and exits.

For schema changes that require dropping and recreating (e.g. enum changes), use `--force-reset`. **This wipes all data:**

```bash
docker compose run --rm hadron-server npx prisma db push --force-reset
```

### Recovering from a restart loop

If a failed migration or startup error puts the container in a restart loop:

```bash
docker compose stop hadron-server
docker compose run --rm hadron-server npx prisma db push --force-reset
docker compose start hadron-server
```

### Re-seeding after a reset

After `--force-reset`, the database is empty. Re-seed if needed:

```bash
docker compose run --rm hadron-server npx prisma db seed
```

## Testing

Tests require a `hadron_test` PostgreSQL database. Push the current schema to it:

```bash
pnpm run db:test-setup
```

If the schema has changed in a way that can't be applied incrementally (e.g. a new
required column without a default), you'll need to force-reset the test database:

```bash
DATABASE_URL=postgresql://holger@localhost:5432/hadron_test pnpm prisma db push --force-reset
```

This drops and recreates the database — all test data is lost. Only use this on the
test database, never on production.

Then run:

```bash
pnpm test                # run all tests
pnpm run test:watch      # watch mode
pnpm run test:coverage   # with coverage report
```

Tests use Vitest with `pool: 'forks'` (one process per file) and `fileParallelism: false`
to prevent concurrent writes to the shared test database.

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm run dev` | Start dev server with hot reload (tsx watch) |
| `pnpm run build` | Compile TypeScript |
| `pnpm start` | Run compiled server |
| `pnpm test` | Run all tests |
| `pnpm run test:watch` | Watch mode |
| `pnpm run test:coverage` | Coverage report |
| `pnpm run db:generate` | Regenerate Prisma client |
| `pnpm run db:push` | Push schema to database |
| `pnpm run db:migrate` | Run Prisma migrations (PostgreSQL) |
| `pnpm run db:studio` | Open Prisma Studio |
| `pnpm run db:use-pg` | Switch to PostgreSQL schema |
| `pnpm run db:use-sqlite` | Switch to SQLite schema |
| `pnpm run db:test-setup` | Create/update the `hadron_test` database |

## Database provider adapter

`src/integrations/db/provider.ts` abstracts the differences between the two engines.
The server reads `DB_PROVIDER` at startup:

| Feature | PostgreSQL | SQLite |
|---------|-----------|--------|
| Tags | `String[]` (native array) | `String` (JSON-serialized) |
| JSON fields | `Json` type | `String` (JSON-serialized) |
| Tag filter | Prisma `hasEvery` | `AND` + `contains` on JSON string |
| Case-insensitive search | `mode: 'insensitive'` | Omitted (SQLite LIKE is already case-insensitive) |
| Enums | `enum Role / StationType` | `String` with defaults |
