# 044 — Sign in with Microsoft (OAuth login)

Status: **planned** (drafted 2026-07-09; open decisions below need Holger's
call before implementation). Provider roadmap: GitHub (live) → Google (#581,
merged, portal wiring pending) → Apple (#584, merged, portal wiring pending)
→ **Microsoft (this plan)** → LinkedIn → Spotify.

Governing finding:
[`findings:oidc-login-sub-is-identity-email-is-not`](https://hadronmemory.com/app/u/hrn:node:hadronmemory.com::hadron-server::findings:oidc-login-sub-is-identity-email-is-not)
— written from the Google PR, states its three account-linking guards "apply
verbatim to the future Microsoft login." `resolveGoogleUser` in
`src/auth/google.ts` is the reference implementation this plan mirrors.

## Goal

Login-only Sign in with Microsoft as the fourth social provider. Identity
from the **verified ID token** (jose + Microsoft JWKS), never a bare decode
or a Graph API call. No Microsoft Graph scopes on this client, ever — same
separation as Google login vs the Gmail tool (#580) and Exchange (#396):
the existing `hadrontool-ms-exchange` app registration is a **different
client in a different trust tier**; do not reuse it for login.

## Shape — near-verbatim sibling of the Google pair

The Google flow is the closest template (GET callback with query params —
none of Apple's form_post machinery):

- `GET /auth/microsoft` — 503 when unconfigured; `return_to` validated by
  `isServerLocalPath`; `client_state` mandatory on the portal-handoff path
  (#477 / Codex #504 P2); own `pendingMicrosoftStates` map (state minted for
  one provider must never replay against another's callback); 10-min expiry
  with prune-on-hit.
- `GET /auth/microsoft/callback` — code→token exchange, verify ID token,
  `resolveMicrosoftUser`, personal-workspace provisioning with P2002
  tolerance, same JWT claim shape, Option-C `hadron_token` cookie on the
  `returnTo` branch, single-use handoff code otherwise.
- Redirect URI from `BASE_URL || http://localhost:${PORT || 4000}` (`||` not
  `??` — the empty-string fallback is deliberate, see google.ts).
- Account resolution (#581 match order): by `microsoftId` (the `sub` claim)
  → by verified email, only when the row has no `microsoftId` yet (recycled-
  email takeover guard) → fresh user, email stored **only when verified**.
  Fresh-user create races resolve to the P2002 winner.
- Profile: `name` claim fills gaps only (secondary provider must not
  overwrite). No avatar — v2.0 ID tokens carry no picture claim and fetching
  the Graph photo would need an API call + scope this client must not have
  (Apple precedent: avatarUrl stays null).
- Email lowercased at the single producer (`verifyMicrosoftIdToken`), same
  rationale as google.ts:98.

## Microsoft-specific deltas

These are the only parts that are not a mechanical copy:

### 1. Multi-tenant issuer validation (the real work)

Endpoints (Microsoft identity platform v2.0), with `{tenant}` from
`MICROSOFT_TENANT` (default `common`):

- authorize: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
- token: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
- JWKS: `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`

With `common`, the ID token's `iss` is **per-tenant**
(`https://login.microsoftonline.com/{tid}/v2.0`), so jose's static
`issuer:` option cannot be used. Instead: `jwtVerify` with signature +
`audience` (our client id) only, then manually enforce:

- `payload.tid` is a UUID (regex),
- `payload.iss === `https://login.microsoftonline.com/${payload.tid}/v2.0``,
- `payload.sub` is a non-empty string.

Fail closed — any mismatch throws, exactly like the Google verifier. Pin all
three checks in tests (wrong-issuer, issuer/tid mismatch, missing tid).

### 2. Email trust — the "nOAuth" hazard

Entra's `email` claim is **mutable and unverified by default** (a tenant
admin can put any address on a user — the nOAuth account-takeover class).
There is no reliable `email_verified` claim. Gate linking on:

- `xms_edov === true` (the "email domain owner verified" **optional claim**
  — must be enabled on the app registration's ID-token optional claims,
  alongside `email`), **or**
- `tid === '9188040d-6c67-4c5b-b112-36a304b66dad'` (the consumer/MSA
  tenant — personal-account emails are the verified login identifier).

Boolean-strict on `xms_edov`, same as google.ts's `email_verified === true`
(a string `"true"` must not authorize linking). Everything else ⇒
`emailVerified: false` ⇒ no email-linking, no email stored on a fresh row —
the user gets an email-less account and can link later, same fall-through
the Google flow ships.

### 3. `sub` is pairwise per app registration

Microsoft's `sub` is stable per user **per client** — fine as the unique
key (matches the one-column pattern), but replacing the app registration
later would orphan every `microsoftId`. Note it in the column's schema
comment. (The `oid`+`tid` pair is the registration-independent alternative;
not worth a two-column special case for login.)

### 4. Client secret expiry (ops)

Entra client secrets have a **maximum 24-month lifetime** — unlike GitHub/
Google. Record the expiry date + rotation reminder when registering the
secret in Doppler (an `ops:` node in `hadronmemory.com::dev` alongside the
registration step).

## Changes

### Phase 1 — hadron-server

| File | Change |
|---|---|
| `prisma/schema.prisma` | `microsoftId String? @unique @map("microsoft_id")` on User. `IdentityProvider.MICROSOFT` **already exists** (baseline migration) — no enum change, so the enum-add + CHECK two-file rule doesn't apply; single migration file. |
| `prisma/migrations/<ts>_user_microsoft_id/migration.sql` | Hand-typed timestamp; `ADD COLUMN "microsoft_id" TEXT` + unique index only (simpler than the Apple migration — no `ALTER TYPE`). |
| `src/auth/microsoft.ts` (new) | `buildMicrosoftAuthUrl`, `exchangeMicrosoftCode`, `verifyMicrosoftIdToken` (injectable `getKey` for tests), `resolveMicrosoftUser` + private `createFreshUser`. Scopes: `openid email profile`. |
| `src/auth/microsoft.test.ts` (new) | Mirror `google.test.ts`: URL shape (login-only scopes, BASE_URL-derived redirect_uri), verifier (bad signature / audience / issuer-tid mismatch throw; `xms_edov` + MSA-tenant gates fail closed), the three resolve branches + refusal cases, P2002 winner. Local JWKS via jose — no network. |
| `src/server.ts` | `pendingMicrosoftStates` + the `GET /auth/microsoft` / `GET /auth/microsoft/callback` pair, copied from the Google pair. |
| `CLAUDE.md` | Env-table row for the three vars. |

Env: `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` (both required
together; unset ⇒ `/auth/microsoft` answers 503) + `MICROSOFT_TENANT`
(default `common`). Register in Doppler (dev + prd).

No GraphQL change — `googleId`/`appleId` aren't exposed either.

### Phase 2 — hadron-portal (separate repo)

`src/routes/auth/start/` today has only `github/` and `email/` — the
Google/Apple buttons are **also still unwired**. Add
`/auth/start/microsoft` (clone of `start/github`: mint `client_state`
cookie, redirect to the server route) + the signin/signup buttons. Worth
batching Google + Apple + Microsoft portal wiring into one portal PR.

### Phase 3 — app registration (ops, Entra portal)

1. New app registration in a **login-only** tenant/registration (not the
   ms-exchange one). Supported account types per the tenant decision below.
2. Web platform redirect URIs: `${BASE_URL}/auth/microsoft/callback` (prod)
   + `http://localhost:4000/auth/microsoft/callback` (Entra allows plain
   http for localhost — no tunnel needed, unlike Apple).
3. ID-token **optional claims**: `email`, `xms_edov`.
4. Client secret → Doppler; note the expiry date (delta 4 above).

## Open decisions (Holger)

1. **Supported account types / tenant.** Recommend `common` (work/school +
   personal), env-overridable via `MICROSOFT_TENANT` for single-tenant
   deploys. `consumers`-only would dodge the whole nOAuth surface but shuts
   out the business audience, which seems wrong for Hadron.
2. **Email-linking gate.** Recommend the `xms_edov` ∨ MSA-tenant gate above.
   The stricter alternative — never link by email for Microsoft in v1 — is a
   two-line change if preferred.
3. **(Optional) extract the shared provider machinery first.** Microsoft is
   the 4th copy of the pendingStates/route pair, and LinkedIn (OIDC — same
   shape as Google/Microsoft) + Spotify (plain OAuth2, no ID token — GitHub-
   shaped, userinfo fetch) are queued behind it. A provider-parameterized
   helper (state map, start-route guards, callback envelope) would make each
   of the next three a config object + a `resolve<Provider>User`. Costs a
   refactor PR touching the three live flows now, saves three copies later.
   Default if no call: ship Microsoft as copy #4, extract before LinkedIn.

## Verification

- `pnpm test` (new suite + existing auth suites), `pnpm tsc --noEmit`.
- Dev schema sync via `pnpm db:dev-setup` (never bare `db push`).
- Manual round-trip against a real Entra registration on localhost (http
  localhost redirect works, so no tunnel), covering: fresh MSA user,
  fresh Entra user, email-link to an existing magic-link account with
  `xms_edov`, refusal without it, returning login.
