# Operation-key argument removal: cutover notes

Server #1824 removes the deprecated dataKey argument from startAgentSession and linkMemoryToUser. The deprecation window ends when this slice merges. Supply the key only through x-hadron-operation-key, one canonical base64-encoded 32-byte key, on the intended operation request. Never store it as a persistent client header or include it in GraphQL documents, variables, logs or errors.

**Upgrade to hadron-cli v0.21.0 or later before the removal deployment.** Older CLI link-user documents name dataKey even on plaintext invocations and fail unknown-argument validation before writes. This includes memory link-user --data-key; null/absent argument values do not avoid the break. Custom/generated callers must remove the argument from their documents entirely. SECRET session callers without a request key remain refused. encryptMemory retains its arguments pending its separate replacement.

Single consumption, auth refusals and header validation remain unchanged. A second key-consuming field refuses before its own writes; GraphQL serial mutations may already have committed the first field, even when the non-null return makes the whole response data null. An empty header is malformed, not omitted. Do not retry a multi-field mutation assuming null data means rollback.

The migrated CLI requires header-capable server #1817 (main 1cedfa2e) or newer for --data-key. Older servers or header-stripping proxies can complete a plaintext App-scoped promotion irreversibly. CLI v0.21.0 reports that outcome loudly; it cannot repair it. Preflight prevention is tracked separately in hadron-cli#849, to be revisited before this removal releases.

Gate-4 follow-ups: [hadron-docs#376](https://github.com/hadron-memory/hadron-docs/issues/376), Taylor/docs maintenance, refreshes BOTH published reference artifacts; [hadron-portal#1082](https://github.com/hadron-memory/hadron-portal/issues/1082), portal maintenance coordinated by Eden, refreshes its SDL. The CLI's inert vendored SDL is deferred to its next regeneration after merge; Andi files the follow-up at merge, with Joran owning CLI work. unbound-ops is unchanged because operation names are unchanged. Vera updates LIVE cor:api:010:01 and the mirrored corpus in the cutover window before Eden declares it complete. Follow-ups require the merged removal schema; their completion is not claimed by this server PR.

For source inventory, rollout evidence and remaining coverage gaps see [the caller inventory](operation-key-caller-inventory.md). The inventory records a historical snapshot, not current migration state: CLI #846 is now closed with released v0.21.0; CLI #847 merged and its release is published. Five caller/raw-client controls belong to the assigned fresh-stack QA seat.

Current carried coverage residuals are **linkMemoryToUser cache-substitution** and **MCP transport staging**, tracked in [server#1814](https://github.com/hadron-memory/hadron-server/issues/1814) and the [#1825 PR residual dispositions](https://github.com/hadron-memory/hadron-server/pull/1825). These remain open; the historical inventory is not a claim that they were tested. Celine's cycle-0 QA pins warm-cache refusal for startAgentSession, which does not close the linkMemoryToUser cache-substitution residual.

## encryptMemory: the last key arguments are removed (#1796 step 2)

**Breaking change.** `encryptMemory(memoryRef)` no longer accepts `dataKey` or `passphrase`. A document that names either is refused by GraphQL validation (`Unknown argument`) before any resolver runs, whatever the value. No alias is kept.

- **CLI floor: hadron-cli v0.56.0.** It sends the secret only in `X-Hadron-Memory-Keys` (strict owner: a `dataKey` or `passphrase` entry naming the memory; a first encryption is established by that entry) or `X-Hadron-Operation-Key` (the owning App's completion). A CLI older than v0.56.0 can no longer run `memory encrypt`.
- The header paths are unchanged: first encryption by the strict owner, completion by the owner, completion by the owning App key. A non-owner still gets the missing-memory answer.
- `hadron-client` and the portal have no caller. After this slice no Query or Mutation field in the schema takes a `dataKey` or `passphrase` argument; the schema test (`resolvers.keyHeader1796.test.ts`) pins that with an empty exception list.
- The server deploys on merge. Generated or custom callers must drop both arguments from their documents and move the secret to the header.
