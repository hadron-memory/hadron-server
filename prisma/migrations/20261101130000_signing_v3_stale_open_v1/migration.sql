-- #1632 S2b-2 (R81, cor:dmo:130:03 S19): signing requests pin their payload version, and v3 is now the only
-- version a server builds or verifies (R80). A request still open with a v1 pin when v3 deploys can never
-- complete, and re-pinning it would change the signed bytes under a link the requester already sent, so it
-- ends stale, kept as an ended record, and the requester asks again.
--
-- The signing_request_guard trigger stamps ended_at from the database clock (or, for a request already past its
-- deadline, ends it expired at that deadline: the truth). The WHERE clause makes a rerun a no-op. The count
-- is written to the deploy output so the number of requesters who must ask again is on record.
DO $$
DECLARE ended integer;
BEGIN
  UPDATE signing_requests SET state = 'stale'
   WHERE state = 'open' AND payload_version = 'hadron-signature-v1';
  GET DIAGNOSTICS ended = ROW_COUNT;
  RAISE NOTICE 'signing v3 deploy: ended % open hadron-signature-v1 signing request(s) as stale (R81)', ended;
END $$;
