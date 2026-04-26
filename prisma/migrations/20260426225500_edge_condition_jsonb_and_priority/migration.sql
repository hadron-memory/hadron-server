-- AlterTable: change Edge.condition from TEXT (Mustache string) to JSONB
-- (JSONLogic JSON value). Per the edge-condition spec (no migration), legacy
-- values are dropped — they were experimental and not used in production.
-- Also add the priority column for stable edge-resolution ordering.

ALTER TABLE "edges" DROP COLUMN "condition";
ALTER TABLE "edges" ADD COLUMN "condition" JSONB;
ALTER TABLE "edges" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
