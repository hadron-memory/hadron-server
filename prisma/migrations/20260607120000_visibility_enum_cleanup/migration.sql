-- 035-visibility-enum-cleanup
--
-- 1. Give Agent its own AgentVisibility enum {PUBLIC, ORGANIZATION, PERSONAL}.
-- 2. Make memories.visibility nullable + remap (knowledge PRIVATE -> ORGANIZATION;
--    every non-knowledge/group class -> NULL).
-- 3. Shrink MemoryVisibility to {PUBLIC, ORGANIZATION, GROUP} (drop PERSONAL,
--    PRIVATE — Postgres can't DROP VALUE, so swap the type).
-- 4. Reconcile + drop the vestigial memories.type column and MemoryType enum
--    (branch on `class` instead).
-- 5. Add chk_memory_visibility_class.
--
-- Hand-written: Prisma's generator can't express enum-value drops, the USING
-- casts, or the data remaps.

-- ── 0. Reconcile class from the legacy type column BEFORE dropping it ──────
-- type and class diverge today: the create-chatbot wizard sets
-- type='AGENT_SYSTEM' on a memory whose class stayed 'knowledge'. Make class
-- authoritative so the post-drop `class='system'` reads are correct.
UPDATE "memories"
  SET "class" = 'system'
  WHERE "type" = 'AGENT_SYSTEM' AND "class" <> 'system';

-- ── 1. agents.visibility -> AgentVisibility ───────────────────────────────
CREATE TYPE "AgentVisibility" AS ENUM ('PUBLIC', 'ORGANIZATION', 'PERSONAL');

ALTER TABLE "agents" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "agents"
  ALTER COLUMN "visibility" TYPE "AgentVisibility"
  USING (
    CASE "visibility"::text
      WHEN 'PUBLIC' THEN 'PUBLIC'
      WHEN 'ORGANIZATION' THEN 'ORGANIZATION'
      ELSE 'PERSONAL'   -- PRIVATE / PERSONAL / GROUP / anything -> PERSONAL
    END
  )::"AgentVisibility";
ALTER TABLE "agents" ALTER COLUMN "visibility" SET DEFAULT 'PERSONAL';

-- ── 2. memories.visibility -> nullable + remap ────────────────────────────
ALTER TABLE "memories" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "memories" ALTER COLUMN "visibility" DROP NOT NULL;

-- knowledge PRIVATE (the old creator-only default) -> ORGANIZATION.
UPDATE "memories"
  SET "visibility" = 'ORGANIZATION'
  WHERE "class" = 'knowledge' AND "visibility" IN ('PRIVATE', 'PERSONAL');
-- Every non-knowledge/group class loses its (now meaningless) visibility.
UPDATE "memories"
  SET "visibility" = NULL
  WHERE "class" NOT IN ('knowledge', 'group');

-- ── 3. Swap MemoryVisibility to {PUBLIC, ORGANIZATION, GROUP} ──────────────
-- Safe now: agents no longer use the type, and no memory row references
-- PERSONAL/PRIVATE. chk_memory_group_visibility compares `visibility` to a
-- 'GROUP' enum literal, so it must be dropped before the rename (otherwise the
-- literal stays bound to the renamed-old type and the column re-type fails with
-- `operator does not exist: MemoryVisibility = MemoryVisibility_old`). It is
-- re-added against the new type in step 5.
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_group_visibility";

ALTER TYPE "MemoryVisibility" RENAME TO "MemoryVisibility_old";
CREATE TYPE "MemoryVisibility" AS ENUM ('PUBLIC', 'ORGANIZATION', 'GROUP');
ALTER TABLE "memories"
  ALTER COLUMN "visibility" TYPE "MemoryVisibility"
  USING ("visibility"::text::"MemoryVisibility");
DROP TYPE "MemoryVisibility_old";

-- ── 4. Drop the legacy memories.type column + MemoryType enum ─────────────
ALTER TABLE "memories" DROP COLUMN "type";
DROP TYPE "MemoryType";

-- ── 5. Re-add visibility CHECK constraints against the new enum ────────────
-- chk_memory_group_visibility (dropped in step 3 for the enum swap) — same
-- definition, now bound to the new MemoryVisibility. visibility is nullable now,
-- so a non-group row with NULL visibility makes the `visibility <> 'GROUP'` arm
-- evaluate to NULL; the CHECK passes (a CHECK fails only on FALSE), which is the
-- intended behavior.
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_group_visibility"
  CHECK (
    (class = 'group' AND visibility = 'GROUP')
    OR
    (class <> 'group' AND visibility <> 'GROUP')
  );

-- chk_memory_visibility_class: visibility is non-null ONLY for knowledge/group.
-- (Loose form — it forbids non-null on other classes but does not require
-- non-null on knowledge/group; application code defaults knowledge to
-- ORGANIZATION.)
ALTER TABLE "memories"
  DROP CONSTRAINT IF EXISTS "chk_memory_visibility_class";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_visibility_class"
  CHECK ("visibility" IS NULL OR "class" IN ('knowledge', 'group'));
