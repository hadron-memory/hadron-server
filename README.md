# hadron-server

The server behind [Hadron](https://hadronmemory.com), a memory platform for people and AI agents.
It serves a GraphQL API, an [MCP](https://modelcontextprotocol.io) endpoint, and the
background jobs that keep both running, on top of PostgreSQL with the pgvector extension.

This repository is public and MIT-licensed (see [LICENSE](LICENSE)). It is the server only:
the web portal and the command-line client live in their own repositories.

> **Public and private material.** Everything in this repository is public. Hadron itself,
> including the team's internal memories and some linked repositories, requires a login.
> References in code comments to issue numbers (`#1234`) point at this repository's GitHub
> issues; references to "specs" or Hadron memories may not be readable without an account.
> A change should never depend on you being able to open one of those.

## What is in here

| Path | What it holds |
|------|---------------|
| `src/api/graphql/` | The GraphQL schema and resolvers served at `/graphql` |
| `src/mcp/` | The MCP server served at `/mcp` |
| `src/auth/` | Sign-in, tokens and OAuth |
| `src/jobs/` | Background loops (sweeps, schedulers) |
| `prisma/` | The database schema (`schema.prisma`), migrations and raw SQL that Prisma cannot express |
| `scripts/` | Development, CI and disposable-test-stack scripts |

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- [pnpm](https://pnpm.io) (the exact version is pinned in `package.json`; `corepack enable` picks it up)
- PostgreSQL 15 or newer with the [pgvector](https://github.com/pgvector/pgvector) extension
  available. The Docker Compose file uses the `pgvector/pgvector:pg17` image if you would
  rather not install it yourself.
- `psql`, which the setup script calls

## Run it locally

These steps use throwaway values. Do not reuse them anywhere that holds real data.

**1. Install dependencies**

```bash
pnpm install
```

**2. Create a database**

Create an empty database on your PostgreSQL server. The role you connect with needs to be
able to create tables and, for the `vector` extension, to create extensions (a superuser
or the database owner on most installs):

```bash
createdb hadron
```

**3. Create your `.env`**

```bash
cp .env.example .env
```

Then edit `.env` and set at least these four values. Everything else in the file is
optional for a first run. The server refuses to start without the last one.

| Variable | What to put there |
|----------|-------------------|
| `DATABASE_URL` | Your connection string, for example `postgresql://YOUR_USER@localhost:5432/hadron` |
| `JWT_SECRET` | Any random string of 32 or more characters. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `HADRON_ENCRYPTION_KEY` | 32 random bytes as hex, generated with the same command |
| `RATE_LIMIT_KEYRING` | A one-key JSON keyring for the rate limiter. `.env.example` does not list this variable. Generate the whole line with `node -e "console.log('RATE_LIMIT_KEYRING=' + JSON.stringify({current:'dev1',keys:{dev1:require('crypto').randomBytes(32).toString('hex')}}))"` and paste it into `.env` as printed |

`.env` is ignored by git. Never commit it, and never paste its contents into an issue.

**4. Create the schema**

```bash
pnpm db:dev-setup
```

This runs `prisma/pre-push.sql`, applies the schema, and then runs the raw SQL in `prisma/post-push.sql`, which creates the
`vector` extension, the vector index and the database constraints Prisma cannot model.
**Use this script, not a bare `pnpm db:push`:** a bare push silently drops the vector index.
`pnpm db:dev-setup` is safe to run again after a schema change; it does not wipe data.

**5. Start the server**

```bash
pnpm dev
```

The server prints three lines when it is up:

```
hadron-server listening on http://localhost:4000
GraphQL: http://localhost:4000/graphql
MCP:     http://localhost:4000/mcp
```

**6. Check that it works**

```bash
curl -s http://localhost:4000/health
```

A healthy server answers with HTTP 200. `/health` checks the database connection, so a
failure here usually means `DATABASE_URL` is wrong or Postgres is not running.

Sign-in providers (GitHub, Google, email links) and the other integrations in `.env.example`
are all optional and need credentials of your own. The server starts without them; the
sign-in routes you have not configured simply refuse requests.

## Tests

```bash
pnpm test
```

You need a local PostgreSQL with pgvector and a role that may create databases. No setup
step is needed: the test run builds a template database from an empty one for the schema in
your checkout and clones it for each worker, and it never touches the database named in
your `.env`. If you have little memory or share the machine, limit the workers with
`HADRON_TEST_MAX_WORKERS=2`.

Other checks that CI runs:

```bash
pnpm tsc --noEmit
node scripts/check-loc-scope.mjs
pnpm check:sdl-enums
pnpm check:sdl-hash-docs
```

## Disposable stack

`scripts/e2e/stack.sh` builds this checkout into a private, seeded stack with its own
database, for trying a change end to end without touching your development database. See
[scripts/e2e/README.md](scripts/e2e/README.md).

## Useful scripts

| Script | What it does |
|--------|--------------|
| `pnpm dev` | Start the server with hot reload |
| `pnpm build` / `pnpm start` | Compile, then run the compiled server |
| `pnpm db:dev-setup` | Sync your development database to the current schema without wiping it |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:studio` | Browse your development database in Prisma Studio |
| `pnpm test` | Run the test suite |

## Contributing and security

- Want to change something? Read [CONTRIBUTING.md](CONTRIBUTING.md).
- Found a vulnerability? Do not open an issue. Follow [SECURITY.md](SECURITY.md).
- Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
