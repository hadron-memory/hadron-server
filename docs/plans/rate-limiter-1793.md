# Shared request admission (#1793)

Build scope: `beginMergeUsersConsent` (CREDENTIALS) and the outer `findNodes` resolver (FAN_OUT_READS), including its MCP delegate. Refs #1793 only: route adoption #419, CLI #1482, production shadow/activation and spec Built follow-through remain separate.

## Configuration and deployment

Run the schema migration before starting this build. Configure **RATE_LIMIT_KEYRING** privately on every serving process before deploy: a JSON object with `current` (a key ID) and `keys` (one or two key IDs mapped to 64 lowercase hex characters representing 256 random bits). Do not use the deterministic Vitest key. Local dev must set its own keyring in .env (compose app: .env.localFs); there is no developer fallback. The disposable e2e entrypoint generates a stack-local key only after its existing empty-DB refusal check; private E2E_RATE_LIMIT_KEYRING may override it for multi-process/overlap QA. No production key is copied into a stack. This is a dedicated HMAC key, not JWT/encryption/API-key material. Missing/invalid keys or disagreement with DB manifest fingerprints refuse boot/readiness, including the read-only configuration check on the existing health probe. A transient policy-store read error alone does not fail that configuration check; the ordinary application DB-pool probe remains unchanged. No key or raw subject goes to logs/rows. Configured key errors never use R209's transient counter-store fallback.

On the first DB initialization, five policy rows seed LOG_ONLY. Optional `RATE_LIMIT_<CLASS>_PRINCIPAL`, `_KEY`, `_IP` environment variables seed positive integer limits once; DB rows win thereafter. Approved defaults:

| Class | Window seconds | Principal | Key | IP |
|---|---:|---:|---:|---:|
| CREDENTIALS | 900 | 30 | 30 | 60 |
| OUTBOUND | 3600 | 60 | 60 | 120 |
| WRITES | 60 | 600 | 300 | 1200 |
| FAN_OUT_READS | 60 | 300 | 120 | 600 |
| OTHER_READS | 60 | 1200 | 600 | 2400 |

Only the two named consumers adopt admission in this build. Other class rows do not claim adoption of every field. Existing route limiters, action/run/mail/SMS quotas and auth remain unchanged. IP normalization uses trusted Express req.ip, IPv4-mapped normalization and express-rate-limit's /56 grouping. Missing IP is never an internal invocation; authenticated run factories explicitly create an APP identity, no key/IP.

The operator reads `rateLimitPolicies` and edits via `setRateLimitPolicy`: full limit triple, class, expectedVersion, changeReference, optional enforcementMode. Omitted/null mode preserves the non-null stored mode. A no-op preserves version/audit; stale versions refuse CONFLICT. Platform ADMIN/OWNER human only; live role, presented UserApiKey and sign-in root are rechecked under existing authority fences. Org admin, App/run, worker session and impersonation refuse. Window/retention/prefix/key/override creation are not editable through the mutation. There is no counter reset operation.

Security proposes/reviews changes. Retain Holger's written approval for edits/activation of either fail-closed class. Approval references are audit evidence, not a new cryptographic approval system. CLI coverage is tracked in hadron-cli#1482; no MCP twin is required.

## Rollout after merge

Deploy LOG_ONLY. Every otherwise valid admitted attempt counts, including would-refuse attempts; privacy-bounded metrics name class/dimension/mode only. Existing auth/consent cap/quotas still refuse. Run the separately approved seven-day production observation, review/tune with security, then have the authorized platform operator set the chosen class to ENFORCING through the versioned mutation. No timer auto-activates it. Mode changes preserve the window's actual count. Do not activate a fail-closed class without Holger's approval. This repository change performs none of those operational steps.

Counter-store outage after reading a valid mode: savepoint rollback removes every partial write; LOG_ONLY serves, ENFORCING follows R209 (CREDENTIALS/OUTBOUND refuse, others serve). Unexpected programming/schema errors remain generic faults. Holger’s #1793 ruling: when the policy/mode itself cannot be read, CREDENTIALS/OUTBOUND refuse RATE_LIMITED even during LOG_ONLY, using the class window; fail-open classes continue, with no cached mode. A malformed/missing policy is a configuration error, not an outage.

## Transaction protocol

Existing authority/account locks → existing consent-cap lock → global shared config fence → numeric-sorted subject locks → counters. Config uses PostgreSQL's two-int advisory lock space, subjects use the disjoint one-bigint space. Subject locks are independent of window/version and include missing rows. One DB clock_timestamp is sampled after all waits, then UTC windows are derived. Check all dimensions first; refused enforcement writes none. Consent commits counters with proof; search commits admission once before core/fallback retrieval. No downstream refund/recharge.

Policy/manifest writers take the config fence exclusively, after authorization; they never acquire subject locks. Cleanup takes config shared then the same subject order, rechecks DB time and removes only expired inactive windows. It runs at most 20 bounded batches (200 each) once per minute, without a NATS dependency. Counts use checked bigint arithmetic and cannot wrap into an allowance.

## HMAC key rotation

Prepare both old/new keys on every process and remove incompatible processes from ingress before the manifest switch. `beginRateKeyOverlap(db,newKeyId)` is an operator maintenance helper, not a new public API: it takes the exclusive config fence and records the overlap start from DB time. During overlap every admission must have both keys, lock both alias sets and use max(old,new), never sum. Every successful attempt writes that max+1 to both aliases atomically; refusal writes neither. This promotes old-only counts on demand without storing/recovering raw IPs.

Keep overlap for at least 24 hours since the last old-only transaction committed. `retireRateKey(db)` takes the exclusive fence and refuses early retirement, then retains only the new alias in the manifest. Do not roll back to a single-key binary during overlap. Missing/lost old secret before safe drain is a readiness/operational recovery problem: restore the secret or hold traffic for a verified drain; never erase rows or manufacture an outage to mint allowances. Window/subject encoding/IPv6-prefix changes are unsupported in this slice and cannot reset state via env reload.

No production probe or activation is implied by these procedures. QA owns a fresh disposable stack and real multiple-process admission/mode/overlap/readiness probes at the frozen head.
