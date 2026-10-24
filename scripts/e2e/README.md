# Disposable E2E stack (#1604)

From the **hadron-server checkout whose head you want to test**:

```sh
scripts/e2e/stack.sh up charles 18400 18500
scripts/e2e/stack.sh check charles 18400 18500
scripts/e2e/stack.sh logs charles 18400 18500
scripts/e2e/stack.sh down charles
```

`up` builds this checkout, creates an empty Postgres 17/pgvector database,
uses `pre-push.sql` → Prisma schema push → `post-push.sql`, seeds it and waits
for server health. The seed verifies the HNSW index, generated `nodes.tsv`
and ownership/class CHECK constraints. It refuses a populated DB. To reset,
use `down` then `up`; restarting an initialized stack refuses explicitly before
Prisma or signing-key generation. The guard checks the public schema used by
this stack's fixed database URL and SQL; alternate Prisma schemas are unsupported.
Failed startup leaves the named stack available for `logs` and `down`.

Give **every concurrent stack a different name, API port and portal port**.
For example, `chip 18401 18501` runs alongside `charles 18400 18500`.
Compose project names, DB/graph/credential volumes and networks are scoped to
`hadron-e2e-NAME`. `down` destroys only that stack, including its volumes and locally built image.
There are no fixed container names, host DB connections or broad process kills.
Stacks launched before the recorded-path fix retain their old cached path; the
fix applies to new launches and does not migrate legacy lifecycle state.

On orca1 the script automatically uses the restricted Incus `qa-docker`
image and Docker Compose inside a disposable instance. It copies tracked (including staged)
server/schema/dependency files and this E2E directory, excluding local secrets,
Git metadata and host dependencies. A per-stack Node HTTP forwarder binds host
`127.0.0.1`, forwarding to the instance's bridge IP. The project forbids Incus
proxy devices; the script does not change those permissions. Backend, ports and forwarder ownership are stored under
`${XDG_STATE_HOME:-$HOME/.local/state}/hadron-e2e/hadron-e2e-NAME`. Teardown
uses that recorded backend even if another backend becomes available, checks
the actual spawned forwarder command before stopping it (including symlinked
checkouts), and also works on stopped instances.
Requirements: `incus`, `qa-docker`, Node, Git, Bash, curl and tar. On a host with Docker, Compose v2 is used directly.
Set `E2E_BACKEND=incus` or `E2E_BACKEND=docker` to choose explicitly and keep
that choice consistent for teardown; auto teardown uses the recorded choice. Docker publication binds host loopback;
the Incus publication binds the disposable instance's interfaces, reachable
only through the private QA bridge and the host-loopback forwarder.

On Incus, `dns-guard.sh` probes name resolution inside the fresh instance before
anything needs the network (`E2E_DNS_POLL_SECONDS`, `E2E_DNS_SEED_AFTER`,
`E2E_DNS_WAIT_PROBES`). A resolver that comes up by itself is left alone. Only
if it stays dead is `1.1.1.1` seeded, by REPLACING the instance's
`/etc/resolv.conf` (a fresh image's is a symlink into `/run/systemd/resolve/`
that can still dangle; appending through it fails with `Directory nonexistent`).
If the write fails it says so on stderr, and the run stops with `DNS not
answering` unless a later probe succeeds. Only the disposable instance is touched.

The first slice includes server and DB. Run a local portal as described below;
MinIO, NATS, external-provider mocks, git-source fixtures and automated browser
suites are not part of this slice. Mail, LLM spend and headless workers are off.
No CI wiring or production snapshots are used.

## Fixture inventory

All users have platform **READER**, except the org-less **platform-admin**,
which has platform **ADMIN**. Org administrators are not platform admins,
so tenant journeys exercise normal membership access. Emails are
`HANDLE@e2e.test` (synthetic); there are no passwords or real identities.

<!-- fixture-users -->
| Handle | e2e-alpha | e2e-beta |
| --- | --- | --- |
| alpha-owner | OWNER | — |
| alpha-admin | ADMIN | — |
| alpha-member | CONTRIBUTOR | — |
| beta-owner | — | OWNER |
| beta-admin | — | ADMIN |
| beta-member | — | CONTRIBUTOR |
| shared | READER | READER |
| outsider | — | — |
| visitor | — | — |
| multi-app | CONTRIBUTOR | CONTRIBUTOR |
| fresh-user | — | — |
| platform-admin | — | — |
| google-user | — | — |
| apple-user | — | — |
| email-code-user | — | — |
| personal-owner | — | — |
<!-- /fixture-users -->

In **each org**:

- `knowledge` (ORGANIZATION), `group` (GROUP), `personal`, `private`,
  `app` and `system` memories, each containing `welcome`. All except `app`
  are free-standing; personal/private belong to that org's admin. The admin
  owns the group membership. Group and strict-owner memories do not become
  visible to every org member merely because they have a membership.
- `team` App with its admin, coordinator and QA role agents, two cast workers
  (`Test Coordinator`, `Test Reviewer`), worker memories, an App key and a
  default team Channel in the `app` memory; runnable `tasks:check-stack`.
- `specs` memory with `rule:001` and `rule:002`: current approvals, mint
  hashes and revision fingerprints. Its `spec.rule` role has a locked
  ADMIN-writer rule, so member-authored edits are protected.

Additional principal shapes:

| Fixture key | Identity / initial state | App membership |
| --- | --- | --- |
| multi-app | EMAIL, CONTRIBUTOR in both orgs | Both `e2e-alpha:team` and `e2e-beta:team` |
| fresh-user | Created through the real email verify + handoff routes; `isNew=true`, no org or memory | None |
| platform-admin | Platform ADMIN; no fixture-org membership or owned memory | None |
| google-user | GOOGLE identity from a locally signed token, verified and provisioned by the real Google helpers | None |
| apple-user | APPLE identity from a locally signed token, verified and provisioned by the real Apple helpers | None |
| email-code-user | EMAIL identity; signs in through the actual REVIEW_DEMO code-entry form during seeding | None |
| personal-owner | EMAIL; only free-standing personal and private memories | None |
| e2e-alpha:team / e2e-beta:team | App-key-only; no User identity | The credential's own App |

`check` verifies all 16 user identities, platform roles, exact org/App membership
sets and memory record sets, both pure App credentials, and MCP switching for
multi-app. `/fixtures/principals.json` records generated handles/IDs and which
sign-in simulation ran; it contains no token. The **fresh-user** handle is
allocated by the real signup path, so use its email or the metadata when finding
it in the portal.

`outsider` and `visitor` each own a separate free-standing private memory
with a welcome node. The API check verifies their own memory and empty org
membership lists. Every user has one `hdr_user_*` credential; each team App
has one `hdr_app_*` credential. Existing fixture IDs and content are deterministic; the three signup paths
allocate their own user IDs (and fresh-user handle).
Credentials are freshly random on every new stack.

`up` prints raw credentials **once at the end** after health and inventory
checks. Only hashes are stored in DB, with raw values in a stack-scoped
credential volume for check scripts. Seed and application logs do not print
the raw credentials. Capture the final output privately if needed; `down`
removes the credential volume. Signing and encryption keys are also randomly generated inside each fresh
app launch, so a JWT from one stack does not authenticate to another. These
fixtures belong only in this local environment.

## Sign-in simulation limits

Seeding runs a temporary loopback server using the normal routes, then closes
it before the stack server starts. Test mode disables background sweeps in this
short-lived route server; the real stack server still runs in development. No mail or IdP request leaves the stack.
For **fresh-user**, only email delivery is simulated by inserting a short-lived,
browser-bound verification token; the real email verify route creates the user
and the real handoff route proves `isNew=true` and the empty initial state.
Later dev-login sessions use the existing-user handoff and report `isNew=false`,
which `check` asserts for every user. fresh-user is therefore not fresh after
seeding: a portal first-run journey needs a new signup, not this account.
Seeding the code-entry form also creates a synthetic OAuth client,
`e2e-review` (redirect `http://localhost:4000/e2e-callback`).

Google/Apple use a locally generated signing key injected through the existing
verifiers' test seam, followed by the normal find/link/create helpers. This
covers signature/issuer/audience checks and provisioning of synthetic provider
subjects. It does **not** exercise real provider JWKS, consent, code exchange,
provider callback/state transport, Apple relay mail, or actual Google/Apple
accounts. The public Google/Apple routes remain unconfigured in this stack.

Main currently has **no general delivered email-code sign-in**: ordinary email
uses a magic link. The code-entry fixture exercises the existing one-account
`REVIEW_DEMO` path with its CSRF form and signed cookie. Its random code is local
to the temporary seed process; the review bypass is disabled in the running
stack. This fixture is not evidence of a production email-OTP ceremony or a
fresh-auth/step-up guarantee.

## CLI and MCP

Use a fixture user token from the final output. A one-command environment
avoids replacing your team's normal CLI login or server configuration:

```sh
HADRON_TOKEN="$FIXTURE_USER_TOKEN" hadron --server http://localhost:18400 auth whoami
HADRON_TOKEN="$FIXTURE_USER_TOKEN" hadron --server http://localhost:18400 memory list
```

GraphQL is `http://localhost:18400/graphql`; MCP is
`http://localhost:18400/mcp` with `Authorization: Bearer <fixture token>`.
User tokens represent users; App keys represent installed team Apps, not
users. Browser portal login uses the dev-login handoff below, not an App key.

## Local portal

In a separate **hadron-portal checkout**, with its dependencies installed:

```sh
LOCAL_SERVER_URL=http://localhost:18400 PUBLIC_SERVER_URL=http://localhost:18400 \
  pnpm dev --host 127.0.0.1 --port 18500 --strictPort
```

The portal must use the port passed to `up` (FRONTEND_URL). If using a browser
on another machine, forward both localhost ports through SSH to orca1 first.
Visit, for example:

```text
http://localhost:18400/auth/dev/login?email=alpha-admin@e2e.test
http://localhost:18400/auth/dev/login?email=beta-admin@e2e.test
http://localhost:18400/auth/dev/login?email=shared@e2e.test
http://localhost:18400/auth/dev/login?email=outsider@e2e.test
```

Use a separate browser profile, or log out between identities. The fixture proxy makes published-port requests local to the dev-login handler.
Consequently, every peer that can reach the disposable Incus QA bridge can use
these synthetic logins; loopback publication does not isolate that private bridge.
Use this stack only for disposable synthetic data, never on a public interface.
The server and internal proxy are supervised together; published health and login
are verified before credentials are printed and again by `check`. `check` tests the handoff redemption, authenticated API identities and MCP
initialize/tools discovery for a user and an App key; independent QA must also exercise the
rendered portal and concurrent stacks before calling the issue done.

## Adding fixtures

The shared `catalog.ts` drives seed users, memberships and exact API access
expectations; `checkDocumentInventory()` checks this README table against it.
Edit the catalog, `seed.ts` and this inventory together. Preserve synthetic `.test` emails,
READER platform roles and the memory CHECK invariants. Update `check()` for
the expected DB shape and the catalog's golden memory sets for observable access.
Run `down`/`up`/`check` on a fresh stack. Lifecycle/forwarder regressions run with
`node --test scripts/e2e/*.test.mjs`. Keep epic-specific fixtures (passkeys,
virtual authenticators, comments) in their later slices; do not change the
canonical dev seed or shared `hadron_test` database for an E2E fixture.
