-- Phase 3 of moving Pong out of the portal database.
--
-- Pong drafts now live exclusively in the user's Outlook Drafts folder.
-- The portal no longer tracks draft state; Exchange is the state machine.
-- Confidence and reasoning are embedded in a header at the top of the draft
-- body (see src/integrations/pong/drafts.ts).
--
-- DATA LOSS WARNING: all pong_drafts rows are dropped. Any in-flight drafts
-- that existed only as database rows (without a corresponding Outlook draft)
-- are gone. Drafts that already had an outlookDraftId remain visible in the
-- user's Outlook Drafts folder and will be picked up by the new listing
-- logic on the next query.

DROP TABLE IF EXISTS "pong_drafts";
DROP TYPE IF EXISTS "PongDraftStatus";
