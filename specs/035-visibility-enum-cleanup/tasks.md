# Spec 035 — tasks

- [x] T001 Schema (`prisma/schema.prisma`): add `enum AgentVisibility {PUBLIC,
  ORGANIZATION, PERSONAL}`; `Agent.visibility AgentVisibility @default(PERSONAL)`;
  `MemoryVisibility → {PUBLIC, ORGANIZATION, GROUP}`; `Memory.visibility
  MemoryVisibility?` (nullable, no default); remove `Memory.type` + `enum
  MemoryType`.
- [x] T002 Migration `20260607120000_visibility_enum_cleanup`: backfill
  `class='system'` from `type='AGENT_SYSTEM'`; agents.visibility → AgentVisibility
  (PRIVATE→PERSONAL); memories.visibility nullable + remap (knowledge PRIVATE→
  ORGANIZATION, others→NULL); swap MemoryVisibility enum; drop memory.type +
  MemoryType; add `chk_memory_visibility_class`.
- [x] T003 Sync `chk_memory_visibility_class` into `prisma/post-push.sql` +
  `src/test/globalSetup.ts`.
- [x] T004 `src/enums.ts`: keep `MemoryVisibility` {PUBLIC, ORGANIZATION} aligned
  (drop nothing it doesn't have); add `AgentVisibility`.
- [x] T005 `typeDefs.ts`: add `AgentVisibility`; `Memory.visibility:
  MemoryVisibility` → nullable; `Agent.visibility: AgentVisibility!`;
  `createAgent`/`updateAgent` visibility arg → `AgentVisibility`; drop `MemoryType`
  + `Memory.type` field + `createMemory(type:)`.
- [x] T006 `resolvers.ts`: createMemory visibility (knowledge→ORGANIZATION,
  personal/private→null, drop `type`); agent visibility casts → `AgentVisibility`,
  default PERSONAL; stop writing visibility onto system memories + set
  `class:'system'` on wizard attach; replace `type='AGENT_SYSTEM'` reads with
  `class='system'`; chat/session personal/app visibility → null; rewrite
  `getAccessibleMemoryIds` org clauses (userMemoryOfAgentId gating).
- [x] T007 `chat-scope.ts`: app-class memory `visibility:'PRIVATE'` → null.
- [x] T008 `resolveMemoryAuthorization.ts`: `MemoryForAuth.visibility` →
  `'PUBLIC'|'ORGANIZATION'|'GROUP'|null`.
- [x] T009 Sweep tests (`'PERSONAL'`/`'PRIVATE'`/`AGENT_SYSTEM`/`MemoryType`);
  seed.ts (personal `visibility:'PERSONAL'`→null; system memories already null).
- [x] T010 Validate: tsc, db push + post-push, full test.
- [x] T011 Docs: platform-specs `data-model:entities:memory` + `access-control:memory`
  + agent nodes; api-surface SDL; write finding + update handoff.
