## Dual Database Support

The controller runs on PostgreSQL in production and SQLite for local development, with no code changes required. The abstraction lives in `src/integrations/db/provider.ts` and is driven by the `DB_PROVIDER=sqlite` environment variable.

### Why Two Databases?

- **PostgreSQL** — production-grade, used in Docker; supports native arrays, JSONB, `mode: 'insensitive'` search
- **SQLite** — zero-config local dev; no Docker needed; everything in a single file

### Schema Differences

| Feature | PostgreSQL | SQLite |
|---|---|---|
| `tags` field (Node) | `String[]` — native array | `String` — JSON-serialized (`["a","b"]`) |
| `Json` fields (`outcomeMeta`, `actionArgs`) | `Json` type (JSONB) | `String` — JSON-serialized |
| Enum types (`Role`, `ClientType`) | Native Postgres enum | `String` with default values |
| Case-insensitive search | `mode: 'insensitive'` in Prisma where | Omitted (SQLite LIKE is case-insensitive for ASCII) |

### Provider Abstraction (`src/integrations/db/provider.ts`)

```ts
export const isSqlite = process.env.DB_PROVIDER === 'sqlite';

// Tags: serialize for write, deserialize for read
serializeTags(tags: string[]) → string[] | string
deserializeTags(raw: string[] | string) → string[]

// JSON fields
serializeJson(val: unknown) → unknown   // JSON.stringify on SQLite, passthrough on PG
deserializeJson(raw: unknown) → unknown // JSON.parse if string, passthrough otherwise

// Search
searchContains(field, search) → Prisma where clause  // adds mode: 'insensitive' for PG

// Tag filtering
tagsFilter(tags) → Prisma where clause  // hasEvery on PG, AND+contains on SQLite
```

Field resolvers on `Node`, `Session`, and `UsageEvent` automatically deserialize stored values so the GraphQL API behaves identically on both databases.

### Switching Databases

```bash
# Switch to SQLite (dev)
npm run db:use-sqlite
DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" npx prisma db push
DB_PROVIDER=sqlite DATABASE_URL="file:./hadron.db" npm run dev

# Switch back to PostgreSQL
npm run db:use-pg
DATABASE_URL="postgresql://..." npx prisma migrate dev
npm run dev
```

`db:use-sqlite` and `db:use-pg` copy the appropriate schema file to `prisma/schema.prisma` and run `prisma generate`.

### Schema Files

```
prisma/
  schema.prisma              ← active symlink (copied by npm scripts)
  schema.postgresql.prisma   ← enums, String[], Json
  schema.sqlite.prisma       ← strings with defaults, TEXT fields
```

The generated Prisma client is output to `src/generated/prisma/` and is the same for both variants — the schema differences are transparent at the TypeScript level (strings in, strings out).
