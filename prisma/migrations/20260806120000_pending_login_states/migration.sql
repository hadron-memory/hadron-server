-- Durable pending login state for the first-party auth flows (GitHub /
-- Google / Apple). Replaces the in-process `pendingStates` Maps in
-- server.ts, which lost every in-flight login on deploy/restart (the
-- provider callback then answered 400 "Invalid or expired state" — the
-- failure mode behind the Apple App Review login rejection). Rows are
-- single-use: the callback claims one with an atomic DELETE by PK.
-- Expired rows are lazily swept by the start routes.

-- CreateTable
CREATE TABLE "pending_login_states" (
    "state" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "redirect" TEXT,
    "return_to" TEXT,
    "client_state" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_login_states_pkey" PRIMARY KEY ("state")
);
