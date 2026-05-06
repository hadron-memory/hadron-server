-- Issue #100 #5: clean up two orphan nodes in 'hadronmemory.com:dev' that
-- were created by the malformed-parentRel bug. Two structurally invalid
-- locs (a literal `""` segment and a wrong-type `urn:memory:` segment
-- embedded as path segments) ended up persisted because the MCP write
-- path didn't validate parentRel input.
--
-- The class of bug is now blocked by:
--   - hadron-server fix/100-2-add-node-parentrel-validation
--     (validateParentRel rejects literal-quotes / urn:<wrong-type>:)
--   - hadron-portal  fix/100-4-portal-rename-strip-memory-urn
--     (cleanLocInput strips wrong-type urn:memory: in rename/move)
--
-- This migration cleans up the two known existing orphans. It is
-- idempotent: re-running on a DB where the rows are already gone is a
-- no-op. Cascades on Edge / PendingEdge / NodeVersion clean up dependent
-- rows; UsageEvent.node_id is SetNull on delete.

DELETE FROM "nodes"
WHERE "memory_id" IN (
        SELECT "id" FROM "memories" WHERE "urn" = 'hadronmemory.com:dev'
      )
  AND "loc" IN (
        '"":urn-format',
        'urn:memory:hadronmemory.com:dev:urn-format'
      );
