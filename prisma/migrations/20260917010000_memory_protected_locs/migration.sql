-- #1180 — second predicate source for the spec-049 §2 S4 protected-loc write
-- gate (the first is the Channel table).
--
-- Each entry protects that loc AND its subtree; the single entry '*' protects
-- the whole memory, which is the shape a citation corpus needs (of the signals
-- identifying a spec node, only the memory survives a generic write — a
-- `node update` drops tags, hadron-cli#1152).
--
-- DEFAULT EMPTY, and per memory, deliberately: declaring a loc here refuses
-- every generic writer of it at once, including the authoring CLI until it
-- moves to the authorProtectedNode door. Empty-by-default makes this migration
-- a no-op on every existing row and lets each corpus be switched on when its
-- tooling is ready.
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "protected_locs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
