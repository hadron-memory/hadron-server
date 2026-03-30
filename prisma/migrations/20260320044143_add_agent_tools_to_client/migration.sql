-- AlterTable
ALTER TABLE "stations" ADD COLUMN "agent_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];
