# Operation-key caller inventory and removal rollout

Observed 2026-10-12. Documentation deliverable for server [#1814](https://github.com/hadron-memory/hadron-server/issues/1814), supporting [#1796](https://github.com/hadron-memory/hadron-server/issues/1796). Inventory publication does not establish caller migration or release completion. #1814 remains open until the identified caller migration and rollout evidence are accepted.

The governing rule is [cor:sec:040:04](https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:specs:cor:sec:040:04): a key is never a query or mutation field. Transitional server #1817 (merged 1cedfa2e) retains deprecated dataKey arguments on startAgentSession and linkMemoryToUser while accepting x-hadron-operation-key. encryptMemory is unchanged; its replacement follows #1259.

## Inventory and ownership

The accompanying [scan manifest](operation-key-caller-inventory.json) pins the default-branch head of all 45 repositories visible to this authenticated organization listing, records empty repositories and matching paths. Searches covered startAgentSession, linkMemoryToUser and x-hadron-operation-key in text files up to 10 MB; binary files were excluded. This is source evidence, not evidence of installed versions, runtime traffic or externally maintained custom clients. No separately named maintained GraphQL SDK/package repository was identifiable in the visible inventory. The URN libraries are identifier libraries, not GraphQL clients.

| Surface | Evidence at recorded head | Owner and disposition |
| --- | --- | --- |
| hadron-cli 88f86855 | internal/api/queries/memories.graphql:389 names dataKey on LinkMemoryToUser; internal/api/gen/generated.go embeds it; internal/cmd/memory/linkuser.go invokes the generated operation. No startAgentSession operation document/call; it is in unbound-ops and SDL. | Joran, CLI #846: migrate document, regenerate client, implement per-call header, land and release against transitional server. ALL old link-user requests break at removal, including plaintext requests. OPEN at inventory time. |
| hadron-portal f6396664 | Only schema/schema.graphql matches; no executable caller of either operation in the current default branch. | Portal maintenance: regenerate snapshot at removal; future portal#884 session work must follow the header contract. No caller migration claimed. |
| hadron-docs e5d79f95 | docs/reference/graphql/schema.graphql and schema.md retain the argument on both operations. | Taylor/docs maintenance: regenerate BOTH published reference artifacts from the removal SDL in the removal slice. Other session mentions are explanatory. |
| docs private-encrypted-memories how-to | dataKey refers to encryptMemory, hadron_unlock_memory and x-hadron-memory-keys, not either migrating operation. | Preserve these supported paths until their own replacement. Do not blanket-replace dataKey. |
| hadron-server 36eee480 | Resolver definitions, shared request staging and tests; src/mcp matches are gate comments/tests, not a GraphQL caller of these operations. | Server removal author: remove only the two deprecated arguments after gates; update fixtures and exported SDL. MCP staging coverage is still a residual, not verified by this inventory. |
| hadron-client b562b7e2; mobile/mac/browser clients; tool sidecars | No operation/header matches in pinned default branches. hadron-client is an MCP proxy, not an identified operation-document caller. | No migration inferred; source scan cannot establish absence in external custom code. |
| urn-lib-js 0a4090f2 / urn-lib-go 199e6cfd | No operation/header matches. | No GraphQL migration. |
| hadron-concept; retired spec-kits; hadronmem-specs | Historical designs/spec source mention old signatures. | Preserve historical discussions. Route current-law API signature consistency to the specs owner; this document does not alter or mint law. |
| External SDK/generated/custom callers | Not observable from the organization source inventory. | Eden coordinates supported consumers and cutover notice. Require explicit migration/release acknowledgement for identified maintained consumers; do not equate zero repository matches with verified external clients. |

## Rollout and removal gates

1. Keep transitional server deployed while CLI #846 lands and releases. CLI migration must omit dataKey from the document and variables even when null/absent, use canonical base64 for exactly 32 bytes, set the header only for the intended request, and refuse explicit empty/malformed input before sending. Never persist it as a client default or expose it in logs/errors. Joran owns CLI evidence; Ralion's security pre-read at team #9428 additionally requires cross-host/insecure redirects refused, including no-token clients, and a header-free GetMemory pre-read and later requests.
2. Record the released CLI version/tag and deployment availability, its frozen PR head, and QA evidence. At this inventory snapshot #846 is OPEN: none of these are complete or certified here. Inventory review (Emerson blind, Xylon local, Celine verification) and consumer rollout acknowledgement gate #1814 completion. Any newly discovered maintained caller gets an owner and migration evidence before closure.
3. Eden authorizes the removal window only after CLI release and #1814 closure. Announce that old documents naming the removed argument fail GraphQL validation BEFORE writes, even with a null/absent key value; SECRET session callers without header supply are refused. Publish the oldest supported migrated client version and upgrade instruction using the actual released version, not a predicted one. Arbitrary external custom clients must change their own documents.
4. In the server removal slice, remove the two arguments and temporary resolver legacy plumbing; regenerate server export, CLI/portal snapshots and hadron-docs docs/reference/graphql/schema.graphql AND schema.md. Coordinate reference publication with the deployed removal schema. Do not regenerate them prematurely into a claim that deployed transitional arguments are absent. encryptMemory replacement is separate and #1259-dependent.
5. Verify migrated clients against both transitional and removal candidates, retain failure evidence, and confirm no header on subsequent calls. If rollout fails, hold removal and keep the transitional server; a removed-schema deployment rollback is a coordinator decision backed by client/server compatibility evidence.

No executable migration or schema modification is included here. T1 Standard: blind Emerson, local Xylon, QA Celine; UX waived and section 10 n/a. Anything beyond documentation/inventory landing in any repository triggers T2 Standard plus section 10 before that PR dispatches; CLI #846 already has its separate T2 plus section 10 dispatch.

## QA handoff: five acceptance controls

Celine verifies the manifest/inventory against recorded heads. For each migrated caller, run raw-client probes on a disposable stack and record server/client heads, setup, request shape (redacted), response code, DB effect and pass/fail. Source inspection and prior #1817 tests are supporting evidence, not a claim of fresh caller QA.

| Control | Required observation |
| --- | --- |
| New encrypted session | Authenticated App in SECRET mode sends header-only startAgentSession with no dataKey in document/variables. Session and encrypted personal memory created with the supplied key; unauthorized/no-key paths refuse. No key value in evidence. |
| Existing-key verification | Same caller reuses existing memory with correct header key; wrong key refuses WRONG_KEY before session writes. A warm session cache without request key must not substitute authority. |
| Encrypted promotion | Header-only linkMemoryToUser promotes live anonymous memory with authorized App identity, preserves/encrypts content as required; wrong App/invalid inputs refuse before mutation writes. CLI encrypted link is the known maintained caller control. |
| No-key plaintext | Header-free USER_ID session and plaintext link succeed where authorized; documents omit dataKey entirely. CLI plaintext document must validate on the removal candidate. |
| Header absence later | Pre-read and every subsequent unrelated request omit the header; concurrent requests are isolated. Capture fake-server headers/document/variables and verify no secret/log/error/redirect leakage. |

For session controls with no maintained session caller found, probe raw GraphQL as server contract controls and explicitly label them raw-client checks. Celine owns execution evidence; no new probes were run by this inventory author. Preserve the below unpinned coverage as open follow-up; do not convert it into a passed control.

## Transitional compatibility notice

Cycle-1 compatibility details (PR #1817; Eden #9340):
- Header supply is single-consumption: only one key-consuming field per request. A second consumption is BAD_UNLOCK_INPUT before that field's writes; normal GraphQL serial semantics allow an already-committed first field to stand. Send the header only for the intended operation, never as a persistent client default.
- Legacy missing-key / USER_ID-mode-key failures that were plain Error now carry BAD_UNLOCK_INPUT with different text. Wrong-key session verification now carries WRONG_KEY with different text. Match extensions.code rather than old error strings.
- Header validation, dual-supply mismatch, an explicit empty dataKey beside the header, and a second header consumption return BAD_UNLOCK_INPUT.
- A signed-in non-App user sending the header gets FORBIDDEN, including on a query. Impersonated supply is also FORBIDDEN. Unauthenticated supply is UNAUTHENTICATED, before format parsing.
- Empty legacy dataKey alone continues to mean absent; beside a header it remains an explicit BAD_UNLOCK_INPUT refusal. Null/omitted legacy input with the header remains supported.
- Canonical-base64 encoding is required; a noncanonical string that decodes to the same bytes is still refused.
- A later link field cannot opt into plaintext after the header was consumed: the spent header still causes BAD_UNLOCK_INPUT before that field writes. Put plaintext links in a separate header-free request.
- Both mutation return types are non-null. A refused second field nulls the whole GraphQL data response even when the authorized first field already committed; clients must not infer rollback from data being null.

- **Legacy-only malformed supply stays untyped.** With NO header present, a malformed legacy `dataKey` propagates `parseDataKey`'s raw error — only the header and dual paths answer typed `BAD_UNLOCK_INPUT` (in `resolveRequestOperationKey`, the `dataKey ? parseDataKey(dataKey) : null` branch has no catch; the dual branch wraps its parse). Callers matching on `extensions.code` must except this one path.
- **An empty header is not an omitted header.** `stageRequestOperationKey` returns early only on `undefined`; sending `x-hadron-operation-key: ""` is present-and-malformed → `BAD_UNLOCK_INPUT`, which also blocks an otherwise-valid legacy argument in the same request. Transitional callers must OMIT the header, never send it empty.
- **Unpinned (same P3):** differing-key snapshots cover only three tables; no cache-substitution test for `linkMemoryToUser`; concurrent dual-supply on the SAME memory; MCP transport staging.


These notices apply to #1817's transitional behavior. Argument removal eliminates the legacy supply branches; revise the cutover notice accordingly while retaining the header/authentication and single-consumption contract. Supplying an operation header is not an authorization grant.

Institutional context: [findings:provisioning-key-header-needs-operation-scope](https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:hadron-server:findings:provisioning-key-header-needs-operation-scope) separates provisioning from existing-memory unlock and identifies the plaintext CLI document break.
