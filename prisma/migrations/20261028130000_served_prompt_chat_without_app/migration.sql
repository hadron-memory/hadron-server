-- #2047: a chat held in a memory with no App is recorded under no App.
ALTER TABLE "served_prompts" ALTER COLUMN "app_id" DROP NOT NULL;

-- #2047 (S10, cor:agt:040:03, Vera #42133): a chatbot chat held in a memory no App owns is still recorded, under no App.
-- A bind and a run always belong to an App (their owner-consistency foreign keys would not check a NULL), so only a chat
-- may carry none. Source of truth for this constraint; the migration carries a byte-identical copy (pinned by
-- src/lib/bootPrompt/servedPromptInvariants.test.ts) and post-push.sql includes this file after served-prompt-invariants.sql.
ALTER TABLE served_prompts DROP CONSTRAINT IF EXISTS chk_served_prompts_app;
ALTER TABLE served_prompts ADD CONSTRAINT chk_served_prompts_app CHECK (kind = 'CHAT' OR app_id IS NOT NULL);
