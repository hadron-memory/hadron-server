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
use `down` then `up`; do not restart the initializer on an established DB.
Failed startup leaves the named stack available for `logs` and `down`.

Give **every concurrent stack a different name, API port and portal port**.
For example, `chip 18401 18501` runs alongside `charles 18400 18500`.
Compose project names, DB/graph/credential volumes and networks are scoped to
`hadron-e2e-NAME`. `down` destroys only that stack, including its volumes.
There are no fixed container names, host DB connections or broad process kills.

On orca1 the script automatically uses the restricted Incus `qa-docker`
image and Docker Compose inside a disposable instance. It copies tracked
server/schema/dependency files and this E2E directory, excluding local secrets,
Git metadata and host dependencies. A per-stack Node HTTP forwarder binds host
`127.0.0.1`, forwarding to the instance's bridge IP. The project forbids Incus
proxy devices; the script does not change those permissions. Its PID is stored
under `$XDG_RUNTIME_DIR/hadron-e2e-UID` (or `/tmp`), and teardown checks its
command before stopping it. Requirements: `incus`, `qa-docker`, Node, Git,
Bash and tar. On a host with Docker, Compose v2 is used directly.
Set `E2E_BACKEND=incus` or `E2E_BACKEND=docker` to choose explicitly and keep
that choice consistent for teardown. Docker publication binds host loopback;
the Incus publication binds the disposable instance's interfaces, reachable
only through the private QA bridge and the host-loopback forwarder.

The first slice includes server and DB. Run a local portal as described below;
MinIO, NATS, external-provider mocks, git-source fixtures and automated browser
suites are not part of this slice. Mail, LLM spend and headless workers are off.
No CI wiring or production snapshots are used.

## Fixture inventory

All users have platform **READER**. Org administrators are not platform admins,
so tenant journeys exercise normal membership access. Emails are
`HANDLE@e2e.test` (synthetic); there are no passwords or real identities.

| Handle | e2e-alpha | e2e-beta |
| --- | --- | --- |
| alpha-admin | ADMIN | — |
| alpha-member | CONTRIBUTOR | — |
| beta-admin | — | ADMIN |
| beta-member | — | CONTRIBUTOR |
| shared | READER | READER |
| outsider | — | — |
| visitor | — | — |

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

`outsider` and `visitor` each own a separate free-standing private memory
with a welcome node. The API check verifies their own memory and empty org
membership lists. Every user has one `hdr_user_*` credential; each team App
has one `hdr_app_*` credential. IDs and fixture content are deterministic;
credentials are freshly random on every new stack.

`up` prints raw credentials **once at the end** after health and inventory
checks. Only hashes are stored in DB, with raw values in a stack-scoped
credential volume for check scripts. Seed and application logs do not print
the raw credentials. Capture the final output privately if needed; `down`
removes the credential volume. Signing and encryption keys are also randomly generated inside each fresh
app launch, so a JWT from one stack does not authenticate to another. These
fixtures belong only in this local environment.

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

Use a separate browser profile, or log out between identities. The existing
flag/non-production/loopback gates are unchanged; a container-private loopback
proxy makes published-port requests local to the dev-login handler. Do not
publish the stack on a public interface. `check` tests the handoff redemption, authenticated API identities and MCP
initialize/tools discovery for a user and an App key; independent QA must also exercise the
rendered portal and concurrent stacks before calling the issue done.

## Adding fixtures

Edit `seed.ts` and this inventory together. Preserve synthetic `.test` emails,
READER platform roles and the memory CHECK invariants. Update `check()` for
the expected DB shape and `verify.mjs` for observable API/login behavior.
Run `down`/`up`/`check` on a fresh stack. Keep epic-specific fixtures (passkeys,
virtual authenticators, comments) in their later slices; do not change the
canonical dev seed or shared `hadron_test` database for an E2E fixture.
