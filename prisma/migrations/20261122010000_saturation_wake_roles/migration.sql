-- #4777 (#3819 slice 2; cor:agt:060:16): the App's saturation-alarm wake-roles list. Additive (expand-safe):
-- an empty array for every existing App, so every existing alarm path is unchanged until a manager sets a list.
ALTER TABLE "agent_task_stall_schedule" ADD COLUMN "saturation_wake_roles" TEXT[] DEFAULT ARRAY[]::TEXT[];
