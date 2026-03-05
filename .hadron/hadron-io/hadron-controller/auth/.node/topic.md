## Authentication & Authorization

The controller supports two authentication mechanisms and three roles.

### Mechanisms

#### 1. GitHub OAuth (human users)

Flow:
1. Client visits `GET /auth/github?redirect=/` → server generates a CSRF state, redirects to GitHub
2. GitHub redirects back to `GET /auth/github/callback?code=...&state=...`
3. Server exchanges code for a GitHub access token, fetches the GitHub user profile
4. If `GITHUB_ORG` is set, checks org membership (403 if not a member)
5. Upserts `User` record in DB (preserving role from previous logins)
6. Signs a JWT (HS256, 7-day expiry) with `{ sub, login, role, githubId }`
7. Redirects to `FRONTEND_URL?token=<jwt>`

Relevant files: `src/auth/github.ts`, `src/auth/jwt.ts`, `src/server.ts`

#### 2. Client API Keys (machine clients)

For AI agents, CI tools, IoT devices, and cloud services. Each `Client` record stores:
- `label` — human-readable name (e.g., `mmdata-ci`)
- `keyHash` — bcrypt hash of the opaque token (the raw key is shown once at creation)
- `type` — `WORKSTATION | CLOUD | IOT | AGENT`
- `role` — the client's permission level
- `namespace` — optional namespace restriction for CONTRIBUTOR clients

The raw key is a 32-byte random hex string (64 characters). Created via the `createClient` GraphQL mutation (admin only).

Relevant files: `src/middleware/auth.ts`, `src/api/graphql/schema/resolvers.ts`

### Token Detection

`src/middleware/auth.ts` distinguishes token types by structure:
- **JWT** — contains dots (`header.payload.signature`) → verify with `jose`
- **API key** — no dots → bcrypt-compare against all `Client` records

### Roles (RBAC)

| Role | Permissions |
|---|---|
| `READER` | Read-only — query nodes, sessions, usage events |
| `CONTRIBUTOR` | Read + write — upsert/delete nodes, start/end sessions, record usage; scoped to a namespace if `namespace` is set |
| `ADMIN` | Full access — manage clients, change user roles, read everything |

Roles are checked in resolvers via `requireRole(ctx, 'ADMIN')`. The role order is `READER < CONTRIBUTOR < ADMIN`.

### Environment Variables

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | HMAC secret for signing/verifying JWTs |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `GITHUB_ORG` | If set, only members of this org can sign in |
| `BASE_URL` | Server's own public URL (for the OAuth callback URL) |
| `FRONTEND_URL` | Where to redirect after OAuth (the web app) |
