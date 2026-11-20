-- #4546: anonymous observation only; no new lifecycle state or signer identity.
ALTER TABLE grant_signing_requests ADD COLUMN last_refused_at TIMESTAMP(3);
