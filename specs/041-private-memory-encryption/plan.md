# Spec 041 — private-memory encryption, fully implemented (caller-held keys)

Status: plan approved by Holger 2026-07-06 (D-2026-07-06-B below). Builds on the
spec-era groundwork: `src/lib/nodeCrypto.ts`, `sessionKeyCache`, the
`enc:v1:` envelope, `encryptMemory`/`startAgentSession(dataKey)`.

## D-2026-07-06-B — key custody + scope (Holger, binding)

1. **Caller-held keys, full stop.** The server NEVER persists a data key —
   no server-managed tier, no wrapping under HADRON_ENCRYPTION_KEY for node
   content. Keys exist server-side only transiently (per request / per live
   session) in the in-memory `sessionKeyCache`. This is the product promise:
   a DB dump, a backup, AND the platform operator's own database access
   reveal no private content.
2. **`class='private'` is the ONLY encryptable class.** Enforced at every
   encrypt entry point — no exceptions. OFF by default at creation; flip-later
   is an explicit product decision once experience accumulates.
   **#516 RESOLVED (2026-07-06, Holger — Option 1):** the SECRET-mode App flow
   (Tier 2.5) now *births* its per-user memories as `class='private'` (they are
   owner-only with a caller-held key — that IS the private threat model), and
   the anon→registered encrypted promotion (`linkMemoryToUser`) lands `private`
   too. The `class='personal'` grandfather in `encryptMemory` is retired; a
   data migration (`20260706220000_encrypted_memory_class_private`) flips any
   surviving `personal` + encrypted rows to `private` and asserts no other
   class holds ciphertext. Plaintext USER_ID per-user memories stay `personal`.
   One rule, no compound clause.
3. **Consequences accepted, not worked around:** headless runs on encrypted
   memories are UNAVAILABLE (no session, no key — mint should fail loud);
   keyword search (tsv) matches nothing inside encrypted fields; vector
   indexing stays gated on the FR-026 inversion ack (plaintext vectors are a
   disclosure, the owner opts in); git mirror only happens from an unlocked
   request context (the event subscriber keeps punting).
4. **Pilot corner cut:** no secrets-service integration; passphrase→key
   derivation may run server-side (passphrase transits TLS, is used, never
   stored). Client-side derivation is a later hardening, not a v1 blocker.

## What exists (survey 2026-07-06)

- Envelope: AES-256-GCM, `enc:v1:` prefix on `content`/`abstract`, `{__enc}`
  wrapper on `data`. `name/loc/alias/description/tags/properties` stay
  PLAINTEXT (tree/search/routing need them) — document this boundary loudly.
- `sessionKeyCache` (src/lib/sessionKeyCache.ts): ref-counted, keyed
  (sessionId → memoryId → key), conflict-detecting, evicted on session end.
- GraphQL write/read paths encrypt/decrypt via the cache; `SESSION_EXPIRED`
  typed error when locked. Tested (resolvers.encryption.test.ts, 547 lines).
- Key entry today: `startAgentSession(dataKey)` (SECRET-mode Apps) and
  `encryptMemory(ref, dataKey)`. Raw 32-byte base64 keys only.
- MCP bypasses encryption BOTH directions (#206). Headless/importNode/git
  subscriber punt or rely on request context.

## Gaps → work items

### Server (this spec's PRs)

1. **Class restriction** (#516 Option 1 — shipped): `encryptMemory` rejects
   non-`private` classes (typed BAD_USER_INPUT); the two App-key create-encrypted
   paths *produce* `private` — `startAgentSession` (SECRET mode) births the
   per-user memory as `class='private'` when a `dataKey` is present, and
   `linkMemoryToUser(dataKey)` promotes the anon scratch memory to
   `class='private'` + sets the owner. Migration `20260706220000` rewrites any
   surviving `personal` + encrypted rows to `private` (none expected on prod)
   and asserts no other class holds ciphertext.
2. **Passphrase support (UX foundation)**: nobody manages raw 32-byte keys.
   - `Memory.kdfSalt` (bytes, per-memory random) + `Memory.kdfParams`
     (JSON: `{alg: 'scrypt', N, r, p}`) columns — parameters, NOT secrets.
   - `Memory.keyVerifier`: `enc:v1:` encryption of the fixed string
     `hadron-key-check:v1` under the data key — lets every unlock verify the
     key/passphrase WITHOUT touching node rows; wrong passphrase is a typed
     WRONG_KEY, never garbage plaintext.
   - Derivation: node:crypto scrypt (N=2^15, r=8, p=1 default; params stored
     so they can be raised later per-memory).
   - Every surface that accepts `dataKey` also accepts `passphrase`
     (exactly one of the two).
3. **Per-request unlock for stateless surfaces (portal/CLI via GraphQL)**:
   HTTP header `x-hadron-memory-keys`: JSON array of
   `{memory: <ref>, dataKey?: <b64>, passphrase?: <string>}`. The Apollo
   context builder resolves refs, derives/verifies keys against
   `keyVerifier`, and stages them in `sessionKeyCache` under a synthetic
   per-request session id; an Apollo plugin evicts on response end. ZERO
   changes to existing encrypt/decrypt call sites (they all consult the
   cache by memoryId already). Wrong key → typed WRONG_KEY at context time.
4. **MCP unlock (#206 fix, the surface that matters for real usage)**:
   - New tool `hadron_unlock_memory(memoryUrn, passphrase | dataKey)` →
     verifies against keyVerifier, `sessionKeyCache.set(mcpSessionId, …)`.
     `hadron_lock_memory` to evict early. Eviction wired to MCP transport
     close/session eviction (find the transports-map cleanup).
   - MCP READ paths (`hadron_get_node`, `hadron_get_nodes`, `hadron_find_nodes`
     previews, `hadron_list_nodes` where content surfaces) decrypt when the
     cache has the key; locked ⇒ current behavior (ciphertext visible) plus
     a `[locked: use hadron_unlock_memory]` marker line instead of raw
     `enc:v1:` noise.
   - MCP WRITE paths (`hadron_create_node`, `hadron_update_node`,
     `hadron_update_node_data`, `hadron_replace_text`) encrypt when key
     present; locked writes to an encrypted memory REJECT (typed) — never
     store plaintext rows into an encrypted memory (today's #206 behavior).
   - Spec-032 staleness + abstract fallbacks: gate on unlocked instead of
     `!isEncrypted` where a key is available.
5. **Headless guard**: `mintAppRun` — if the entry node's memory (or, v1
   cheap version: the agent's granted memories used for assembly) is
   encrypted ⇒ RunLaunchDeniedError('ENCRYPTED_MEMORY_UNSUPPORTED'). Loud,
   documented, matches decision 3.
6. **NodeVersion audit**: verify snapshots store ciphertext for encrypted
   memories (they snapshot the row, which is ciphertext — confirm + test).
   restoreNodeVersion already requires an unlocked session.
7. **createMemory(encrypt…)**: optional `passphrase`/`dataKey` at creation
   (class must be private) so a memory can be born encrypted instead of
   convert-later. Generates salt/params/verifier; no plaintext window.

### Portal (handoff → hadron-portal memory)
Unlock dialog (passphrase entry per memory, session-scoped via the header on
subsequent GraphQL calls), lock indicator on memory cards, create-encrypted
flow with the "we cannot recover this" warning + key backup prompt.

### CLI (handoff → hadron-cli#134 addendum)
`hadron memory encrypt <ref>` (passphrase prompt), `hadron memory unlock`
(env `HADRON_MEMORY_PASSPHRASE` / keychain later), header injection on all
node ops, `--locked-ok` for scripting.

### Docs
"What encryption protects and what it doesn't" page: encrypted fields vs
plaintext fields table, lost-passphrase = lost-data statement, search/
indexing/headless consequences, the FR-026 vector ack.

## Non-goals (v1)
Key rotation; multi-key/recovery contacts; client-side derivation;
asset-byte encryption (schema comment overpromises — fix the comment);
encrypted keyword search; headless-with-key-escrow (contradicts D-1).

## Sequencing
PR-1 (server core): items 1, 2, 3, 5, 6, 7 + tests.
PR-2 (MCP): item 4 + tests (createTestableMcpServer needs handler-level
validation parity — see feedback memory).
Portal/CLI/docs ride the existing handoff tracks.
