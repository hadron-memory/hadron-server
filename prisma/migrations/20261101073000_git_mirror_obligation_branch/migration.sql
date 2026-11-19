-- #3042: drain ALL old writers before applying. Old success DELETEs are branch-agnostic.
-- No backfill from current config: empty branch preserves legacy unknown identity.
-- Forward fixes only; running old code on this PK can erase other-branch debt.
ALTER TABLE git_mirror_obligations ADD COLUMN branch TEXT NOT NULL DEFAULT '';
ALTER TABLE git_mirror_obligations DROP CONSTRAINT git_mirror_obligations_pkey;
ALTER TABLE git_mirror_obligations ADD CONSTRAINT git_mirror_obligations_pkey PRIMARY KEY (memory_id, node_id, kind, remove_loc, branch);
