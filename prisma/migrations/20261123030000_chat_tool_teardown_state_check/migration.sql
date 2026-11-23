-- #4945 (hadron-server#4927 review P3, cor:int:030:03 clause 4): the intent's `state` is one of PENDING, CONFIRMED or CAPPED, and the
-- database now says so. CAPPED stays admitted: a capped intent is never dropped, an operator requeues it (clause 4).
-- Prisma cannot model a CHECK; post-push.sql carries the same two statements for dev and test.
--
-- A row holding any other value would make ADD CONSTRAINT fail, and a plain failure would stop boot and crash-loop on restart (#3770):
-- so the preflight refuses with SQLSTATE HDPRF, boot then serves the schema it has and the next boot retries. Nothing in the code
-- writes another value (the column default is PENDING; every UPDATE sets one of the three), so this is a refusal on corrupt data only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM chat_tool_teardown_intents WHERE state NOT IN ('PENDING', 'CONFIRMED', 'CAPPED')) THEN
    RAISE EXCEPTION 'chat_tool_teardown_intents holds a state other than PENDING, CONFIRMED or CAPPED: repair those rows, then the constraint applies'
      USING ERRCODE = 'HDPRF';
  END IF;
END $$;

ALTER TABLE chat_tool_teardown_intents DROP CONSTRAINT IF EXISTS chk_chat_tool_teardown_state;
ALTER TABLE chat_tool_teardown_intents ADD CONSTRAINT chk_chat_tool_teardown_state
  CHECK (state IN ('PENDING', 'CONFIRMED', 'CAPPED'));
