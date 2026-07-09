# 045 — Sign in with LinkedIn (OAuth login)

Status: **planned** (drafted 2026-07-09; sequenced after 044 Microsoft —
see the shared-machinery decision there, which shapes this plan's Phase 0).
Provider roadmap: GitHub (live) → Google (#581) → Apple (#584) → Microsoft
(spec 044) → **LinkedIn (this plan)** → Spotify.

Governing finding:
[`findings:oidc-login-sub-is-identity-email-is-not`](https://hadronmemory.com/app/u/hrn:node:hadronmemory.com::hadron-server::findings:oidc-login-sub-is-identity-email-is-not)
— the three account-linking guards from the Google PR apply to every OIDC
login provider. `resolveGoogleUser` in `src/auth/google.ts` remains the
reference implementation.

## Goal

Login-only Sign in with LinkedIn as the fifth social provider, using
LinkedIn's **"Sign In with LinkedIn using OpenID Connect"** product (the
legacy `r_liteprofile`/`r_emailaddress` flow is deprecated — do not build
against it). Identity from the **verified ID token** (jose + LinkedIn JWKS),
never a bare decode and no LinkedIn API calls. Login-only scopes
(`openid profile email`) — any future LinkedIn data tooling would be a
separate capability tool with its own registration, same separation as
Google login vs the Gmail tool.

## Why LinkedIn is the easy one

Unlike Microsoft (spec 044), LinkedIn is a **textbook OIDC provider** for
our purposes — closer to Google than any provider so far:

- **Static issuer** (`https://www.linkedin.com/oauth`) — jose's `issuer:`
  option works as-is; none of Microsoft's per-tenant template validation.
- **`email_verified` is asserted** in the ID token — the standard Google
  linking gate applies directly; none of Microsoft's nOAuth/`xms_edov`
  machinery.
- **`picture` claim present** — avatar gap-fill like Google (Apple and
  Microsoft have none).
- Standard static client secret, GET callback with query params.

Endpoints (from LinkedIn's OIDC discovery document,
`https://www.linkedin.com/oauth/.well-known/openid-configuration`):

- authorize: `https://www.linkedin.com/oauth/v2/authorization`
- token: `https://www.linkedin.com/oauth/v2/accessToken`
- JWKS: `https://www.linkedin.com/oauth/openid/jwks`

## Shape

Same contract as the Google pair (see spec 044's "Shape" section for the
shared checklist — state-CSRF map, `client_state` requirement, 503 when
unconfigured, `isServerLocalPath` on `return_to`, personal-workspace
provisioning with P2002 tolerance, Option-C cookie / handoff-code sinks,
`BASE_URL || localhost` redirect URI):

- Account resolution (#581 match order): by `linkedinId` (the `sub` claim)
  → by verified email, only when the row has no `linkedinId` yet → fresh
  user, email stored only when verified. Fresh-user create races resolve to
  the P2002 winner.
- `sub` is LinkedIn's member identifier — an opaque string; store as
  `linkedinId TEXT`. Treated as stable for our client; pin the
  opaque-string assumption in the schema comment.
- Email lowercased at the single producer (`verifyLinkedInIdToken`), same
  rationale as google.ts:98.
- Profile `name`/`picture` fill gaps only (secondary provider must not
  overwrite an existing name/avatar).

### Implementation-time verifications (encode as tests, not assumptions)

1. **`email_verified` claim type.** LinkedIn documents the claim, but some
   providers emit `"true"` as a string. Our gate is boolean-strict and
   fails closed (google.ts precedent), so a string value means linking
   silently never happens — verify against a real token during
   implementation and, if LinkedIn emits strings, make the deliberate
   call there (documented + tested), not an implicit one.
2. **Localhost redirect.** Confirm LinkedIn accepts an
   `http://localhost:4000` redirect URL for dev. If it refuses plain http
   (as Apple does), dev round-trips need the tunnel flow from #584
   (`BASE_URL` set to the tunnel origin) — a known path, just note it in
   the env-table row.

## Changes

### Phase 0 — shared provider machinery (decision from spec 044)

Spec 044 flags extracting the per-provider route machinery (pendingStates
map, start-route guards, callback envelope: provision → JWT → cookie/handoff)
before LinkedIn, which would otherwise be **copy #5**. If that extraction is
approved:

- Extract from the four live flows into a provider-parameterized helper
  (e.g. `src/auth/providerLogin.ts`): `registerOidcLoginRoutes(app, {name,
  buildAuthUrl, exchangeCode, verifyIdToken, resolveUser, callbackMethod})`.
  Apple's form_post callback and GitHub's userinfo-based flow define the
  variance the interface must carry; Spotify (no ID token, GitHub-shaped)
  later reuses the GitHub variant.
- Ship as its own refactor PR (byte-equivalent behavior, existing tests
  green) **before** the LinkedIn PR.

If not approved, LinkedIn lands as copy #5 of the Google pair — everything
below is unchanged either way.

### Phase 1 — hadron-server

| File | Change |
|---|---|
| `prisma/schema.prisma` | `LINKEDIN` added to `IdentityProvider` (+ the enum's doc comment); `linkedinId String? @unique @map("linkedin_id")` on User. |
| `prisma/migrations/<ts>_user_linkedin_id/migration.sql` | Hand-typed timestamp. `ALTER TYPE "IdentityProvider" ADD VALUE 'LINKEDIN';` + `ADD COLUMN "linkedin_id" TEXT` + unique index. Single file is safe — the enum-add + CHECK two-file rule doesn't bite because nothing in the migration references the new value (same reasoning as the Apple migration's header comment). |
| `src/auth/linkedin.ts` (new) | `buildLinkedInAuthUrl`, `exchangeLinkedInCode`, `verifyLinkedInIdToken` (static issuer + audience via jose; injectable `getKey`), `resolveLinkedInUser` + private `createFreshUser`. Scopes: `openid profile email`. |
| `src/auth/linkedin.test.ts` (new) | Mirror `google.test.ts`: URL shape, verifier (bad signature / audience / issuer throw; `email_verified` fails closed on non-boolean — see verification 1), the three resolve branches + refusal cases, P2002 winner. Local JWKS via jose — no network. |
| `src/server.ts` | `GET /auth/linkedin` + `GET /auth/linkedin/callback` — via the Phase-0 helper, or as the fifth copy of the Google pair. |
| `CLAUDE.md` | Env-table row. |

Env: `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` (both required
together; unset ⇒ `/auth/linkedin` answers 503). Register in Doppler
(dev + prd). No tenant knob — LinkedIn has no Microsoft-style tenancy.

No GraphQL change (provider ids aren't exposed for the other providers
either).

### Phase 2 — hadron-portal (separate repo)

`/auth/start/linkedin` route + signin/signup buttons. Spec 044 proposes
batching the Google + Apple + Microsoft portal wiring into one portal PR —
LinkedIn joins that batch if it hasn't shipped yet.

### Phase 3 — app registration (ops, LinkedIn Developer portal)

1. Create the app at developers.linkedin.com. **A LinkedIn Company Page is
   required** to create an app — use the Hadron company page (create one if
   none exists; this is the only provider so far with such a prerequisite).
2. Add the **"Sign In with LinkedIn using OpenID Connect"** product
   (self-serve, no review queue — unlike LinkedIn's data products).
3. Authorized redirect URLs: `${BASE_URL}/auth/linkedin/callback` (prod) +
   the dev URL per verification 2 above.
4. Client secret → Doppler. No documented forced expiry (unlike Entra's
   24-month cap), so no rotation calendar entry needed.

## Open decisions (Holger)

1. **Phase 0 extraction** — this is spec 044's open decision 3; it gates
   whether LinkedIn is a config object or copy #5. Recommendation there:
   extract before LinkedIn.
2. **Company Page** — which LinkedIn Company Page owns the app (existing
   Hadron page vs create one). Pure ops, but it's a public-facing surface
   (the page shows on the consent screen).

## Verification

- `pnpm test` (new suite + existing auth suites), `pnpm tsc --noEmit`.
- Dev schema sync via `pnpm db:dev-setup` (never bare `db push`).
- Manual round-trip against a real LinkedIn app: fresh user, email-link to
  an existing magic-link account (asserting `email_verified` arrives as a
  boolean — verification 1), returning login, and the picture/name gap-fill
  on a linked account.
