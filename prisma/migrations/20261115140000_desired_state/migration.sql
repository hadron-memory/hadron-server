-- #4224 (S3 of #4229): the Agent lifecycle, the per-worker leave-alone marker and the App's sweep mode.
-- Additive, every default is today's behaviour (LONG_LIVED, not marked, OFF). No row is rewritten beyond the
-- column defaults, and nothing here refuses on data.

-- CreateEnum
CREATE TYPE "AgentLifecycle" AS ENUM ('LONG_LIVED', 'SHORT_LIVED');

-- CreateEnum
CREATE TYPE "SweepMode" AS ENUM ('OFF', 'OBSERVE', 'APPLY');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "lifecycle" "AgentLifecycle" NOT NULL DEFAULT 'LONG_LIVED';

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "sweep_mode" "SweepMode" NOT NULL DEFAULT 'OFF';

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "leave_alone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leave_alone_reason" TEXT,
ADD COLUMN     "leave_alone_by" TEXT,
ADD COLUMN     "leave_alone_at" TIMESTAMP(3);

-- The marker's fields travel together: a marked worker says when it was marked; an unmarked one carries nothing.
ALTER TABLE "workers" ADD CONSTRAINT "chk_workers_leave_alone_shape" CHECK (
  (leave_alone AND leave_alone_at IS NOT NULL)
  OR (NOT leave_alone AND leave_alone_reason IS NULL AND leave_alone_by IS NULL AND leave_alone_at IS NULL)
);
