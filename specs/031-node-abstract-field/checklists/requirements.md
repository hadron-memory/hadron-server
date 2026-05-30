# Specification Quality Checklist: Node `abstract` field

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-28
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] Focused on the implementer-facing contract (audience is the engineer who will build this,
      not a non-technical stakeholder — see Notes for the template-vs-reality reconciliation)
- [x] Tool-shape contracts (`contentScope` enum, response shapes, `Source: abstract-fallback`
      marker, `brief` interaction) are concrete enough that an implementer can build to them and a
      reviewer can test against them — these are *what the spec promises*, not "how to build it"
- [x] Concrete schema mechanics (Prisma column type, migration shape, index decisions) are
      DEFERRED to plan.md — only conceptual entity impact lives here
- [x] All mandatory sections completed (Background, User Scenarios, Requirements, Entity Impact,
      Success Criteria, Assumptions)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] All acceptance scenarios are defined (13 for US1, 4 for US2, 3 for US3 — covering each
      contentScope × abstract-state × content-state cell)
- [x] Edge cases are identified (including the content-fallback case + marker)
- [x] Scope is clearly bounded (hadron-server only; no vectorization; no portal UI; no index)
- [x] Dependencies and assumptions identified
- [x] All FR-### cross-references resolve to existing requirements (audited 2026-05-29)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] Tool-surface promises are explicit enough that a snapshot-test plan can be derived directly
      from FR-005 and FR-006

## Notes

- **Template-vs-reality reconciliation.** The default speckit `Content Quality` checklist asks for
  "No implementation details" and "Written for non-technical stakeholders". For hadron-server-
  internal specs the audience is the implementing engineer, so tool names, parameter shapes, and
  response-shape contracts are appropriate spec content — they are the contract being promised.
  The boundary held is: *what the spec promises* (tool shape, response shape, validation rules,
  cross-tool interactions) belongs here; *how the implementation gets built* (Prisma column type,
  migration mechanics, file layout, index decisions) belongs in plan.md.
- Spec references concrete file paths with line numbers (e.g. `schema.prisma:721`,
  `server.ts:2445`) as anchors for reviewers — they point at the existing code surfaces this spec
  extends, not at implementation prescriptions. **Plan + contracts use symbolic anchors**
  (function name, tool-registration block, named conditional) instead of line numbers because
  those docs target the edit sites and need to stay accurate as `server.ts` accumulates edits
  (PR-196 review item 1).
- Three NEEDS-CLARIFICATION-worthy questions were resolved into Assumptions with explicit
  rationale instead of marked inline: (1) length cap (2000 chars), (2) auto-derivation from content
  (no), (3) preview replacement vs augmentation (augmentation).
- `target-repositories` frontmatter is `hadron-server` only. Portal rendering follows as a
  localized component change once the API returns the field; flagged in Assumptions, not a separate
  spec target.
