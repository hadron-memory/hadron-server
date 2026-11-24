-- #4921 slice A (cor:agt:060:16 is the precedent): the App's role lists, one per purpose (link a defect, the register
-- pick's role route, withdraw a negative review verdict). Additive (expand-safe): an empty array for every existing App,
-- and no door reads them in this slice, so nothing existing changes until a manager sets a list.
ALTER TABLE "agent_task_stall_schedule" ADD COLUMN "defect_link_roles" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "agent_task_stall_schedule" ADD COLUMN "register_pick_roles" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "agent_task_stall_schedule" ADD COLUMN "review_withdraw_roles" TEXT[] DEFAULT ARRAY[]::TEXT[];
