# Specification Quality Checklist: Node `abstractOriginHash` — stale-abstract detection

> **Post-ship note (#1128, 2026-09-03).** Items below record the state at sign-off. The staleness rule has since changed — an unfingerprinted node with both an abstract and a body now raises the marker — so the open questions about *legacy abstracts staying quiet* are answered differently today. Current rule: spec.md FR-010.

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-31
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] Focused on the implementer-facing contract (audience is the engineer who will build this, not a non-technical stakeholder — same convention established by spec 031)
- [x] Tool-shape contracts (`Source: abstract-stale` marker shape, `[stale-abstract]` validator message, GraphQL field exposure, importer YAML key) are concrete enough that an implementer can build to them and a reviewer can test against them
- [x] Concrete schema mechanics (Prisma column type, migration shape, NodeRevision delta) are described at the entity-impact level; implementation specifics deferred to plan.md
- [x] All mandatory sections completed (Background, User Scenarios, Requirements, Entity Impact, Success Criteria, Assumptions)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous (13 FRs each map to an integration test or contract assertion)
- [x] Success criteria are measurable (SC-001–SC-006 each name a specific test fixture and expected outcome)
- [x] All acceptance scenarios are defined (8 for US1, 6 for US2, 3 for US3)
- [x] Edge cases are identified (7 edge cases covering the null/empty combinations, hash collision, restored-version legacy)
- [x] Scope is clearly bounded (`hadron-server` only; h-find-nodes annotation, automated refresh, and bulk backfill explicitly OUT of scope per Assumptions)
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (write path → read surfacing → bulk validation, three USs)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] Tool-surface promises are explicit enough that a snapshot-test plan can be derived directly from FR-010 (marker shape) and FR-011 (validator message)

## Notes

- **Spec sequenced before the RAG follow-up.** Vectorising stale abstracts is a confidently-misleading failure mode that this spec exists to prevent. The RAG spec will consume `abstractOriginHash` directly and encode a "skip / re-queue stale embeddings" policy on top of the signal this spec exposes. Spec ordering: 032 (this) → RAG follow-up.
- **NodeRevision lesson from spec 031 is applied from day one.** FR-002 + Entity Impact note explicitly call out the curated-subset gotcha. The plan/tasks for this spec MUST treat NodeRevision as a first-class entity from the start (vs. spec 031 where it surfaced during implementation as a planning gap).
- **Two open questions deliberately deferred to planning** (not raised as `[NEEDS CLARIFICATION]` because the spec has sensible defaults — but worth surfacing for `/speckit-plan`):
  1. Should `restoreNodeRevision` recompute `abstractOriginHash` from the restored content when the version's stored hash is null (legacy version restored after this spec ships)? Trade-off documented in the Edge Cases section.
  2. Should the `h-validate` stale-abstract check be gated by a flag (so users can opt out of staleness warnings on memories where many legacy abstracts haven't been refreshed)? Out of scope for v1; tracked here.
- **Branch/spec-dir number divergence (199 vs 032)** is documented in the Feature Branch header so a confused reviewer reaches the explanation in one click. Future readers should treat the spec-dir number as authoritative.
- **Three rejected alternatives** worth noting (not included in the spec to keep it tight):
  - "Compute the hash on read instead of storing it" — defeats the encrypted-memory case (encryption would need to decrypt on every read to compute the hash; current pattern stores `contentHash` for the same reason)
  - "Use a full SHA256 instead of truncated" — overkill for change-detection at the row count this database handles; the existing `contentHash` precedent dominates
  - "Make abstractOriginHash mutable via NodeInput so admin tools can fix bad rows" — defeats the staleness invariant (a writeable field can be lied to); admin fix-ups can run raw SQL if/when needed
