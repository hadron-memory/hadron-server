-- DRAFT ONLY, #3852: separately gated data operation. Not part of #3847.
-- Requires its own gate, refusal/HDPRF assessment and production preflight.
-- #3813 / ruling 0265 / cor:acl:140:08: the preceding migration admits this
-- exact erased-person NULL transition. Clean links left by pre-deploy erasures;
-- live requester links, signed terms and signature records remain unchanged.
-- Idempotent at the row level. This is not a claim about erasures by an old
-- image after this migration has run; rollout-window cleanup is a separate limit.
UPDATE grants AS g
SET requested_by_user_id = NULL
WHERE g.requested_by_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM users AS u
    WHERE u.id = g.requested_by_user_id AND u.deleted_at IS NULL
  );
