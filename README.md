# Hadron Controller

GraphQL API, usage database, and node collection service for the Hadron graph.

## Quick start

```bash
npm install
```

### PostgreSQL (default)

```bash
cp .env.example .env          # edit DATABASE_URL, secrets
npx prisma migrate dev         # apply migrations
npm run dev                    # http://localhost:4000
```

### SQLite (local / single-developer)

No external database required — everything lives in a single file.

```bash
# 1. Switch the Prisma schema to SQLite
npm run db:use-sqlite

# 2. Set environment and push the schema
DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" npx prisma db push

# 3. Start the server
DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" npm run dev
```

To switch back to PostgreSQL:

```bash
npm run db:use-pg
```

## Testing SQLite mode

Once the server is running with SQLite (step 3 above), you can verify the
key operations end-to-end.

### 1. Create an API key

Mutations require authentication. Seed an admin key with a small script:

```bash
# save as seed-test-key.ts (delete after testing)
cat > seed-test-key.ts << 'SEED'
import { db } from './src/db/client.js';
import bcrypt from 'bcrypt';

const rawKey = 'test-admin-key-12345';
const keyHash = await bcrypt.hash(rawKey, 10);
await db.apiKey.create({ data: { label: 'test-admin', keyHash, role: 'ADMIN' } });
console.log('Bearer token:', rawKey);
process.exit(0);
SEED

DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" npx tsx seed-test-key.ts
```

Use the token in subsequent requests:

```bash
AUTH="Authorization: Bearer test-admin-key-12345"
```

### 2. Upsert nodes with tags

```bash
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"query": "mutation { upsertNode(input: { loc: \"acme.app.models.user\", name: \"User Model\", ownerRepo: \"acme/app\", tags: [\"core\", \"auth\"] }) { id loc name tags } }"}'
```

Expected: tags come back as `["core","auth"]`.

### 3. Filter by tags

```bash
# Insert a second node
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"query": "mutation { upsertNode(input: { loc: \"acme.app.views.login\", name: \"Login View\", ownerRepo: \"acme/app\", tags: [\"auth\", \"ui\"] }) { id loc name tags } }"}'

# Filter: nodes with tag "auth" — should return both
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"query": "{ nodes(tags: [\"auth\"]) { loc name tags } }"}'

# Filter: nodes with BOTH "auth" AND "core" — should return only User Model
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"query": "{ nodes(tags: [\"auth\", \"core\"]) { loc name tags } }"}'
```

### 4. Case-insensitive search

```bash
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"query": "{ nodes(search: \"LOGIN\") { loc name } }"}'
```

Expected: returns "Login View" (SQLite LIKE is case-insensitive for ASCII).

### 5. Sessions and usage events

```bash
# Start a session
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"query": "mutation { startSession(input: { id: \"test-001\", type: \"mcp\", repo: \"acme/app\" }) { id type } }"}'

# Record usage via GraphQL (JSON actionArgs passed as variable)
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"query": "mutation R($e: UsageEventInput!) { recordUsage(event: $e) }", "variables": {"e": {"type": "h-view-node", "nodeLoc": "acme.app.models.user", "actionArgs": {"depth": 2}, "sessionId": "test-001"}}}'

# Record usage via REST (no auth required)
curl -s http://localhost:4000/usage \
  -H 'Content-Type: application/json' \
  -d '{"type": "h-run-action", "nodeLoc": "acme.app.views.login", "actionArgs": {"action": "build"}, "sessionId": "test-001"}'
```

### 6. Session outcome (REST)

```bash
curl -s http://localhost:4000/sessions/test-001/outcome \
  -H 'Content-Type: application/json' \
  -d '{"outcome": 0.85, "outcomeRef": "CRM-123", "outcomeMeta": {"source": "crm"}}'
```

### 7. Verify round-trip

Query the session back — all JSON fields (`actionArgs`, `outcomeMeta`) should
come back as objects, not strings:

```bash
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"query": "{ session(id: \"test-001\") { id outcome outcomeRef outcomeMeta events { type nodeLoc actionArgs } } }"}'
```

### 8. Clean up

```bash
rm -f seed-test-key.ts hadron.db
npm run db:use-pg   # restore PostgreSQL as active schema
```

## Database provider adapter

The `src/db/provider.ts` module abstracts the differences between PostgreSQL
and SQLite. The server reads `DB_PROVIDER` at startup:

| Feature | PostgreSQL | SQLite |
|---------|-----------|--------|
| Tags | `String[]` (native array) | `String` (JSON-serialized) |
| JSON fields | `Json` type | `String` (JSON-serialized) |
| Tag filter (`hasEvery`) | Prisma `hasEvery` | `AND` + `contains` on JSON string |
| Case-insensitive search | `mode: 'insensitive'` | Omitted (SQLite LIKE is case-insensitive) |
| Enums | `enum Role` | `String` with defaults |

Field resolvers on `Node`, `Session`, and `UsageEvent` transparently
deserialize the stored values so the GraphQL API behaves identically
regardless of database provider.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled server |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:migrate` | Run Prisma migrations (PostgreSQL) |
| `npm run db:push` | Push schema to database |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:use-pg` | Switch to PostgreSQL schema |
| `npm run db:use-sqlite` | Switch to SQLite schema |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `POST /graphql` | GraphQL API (Apollo) |
| `POST /usage` | Ingest usage events (REST, no auth) |
| `POST /sessions/:id/outcome` | Report session outcome (REST) |
| `POST /reload` | Trigger graph reload |
