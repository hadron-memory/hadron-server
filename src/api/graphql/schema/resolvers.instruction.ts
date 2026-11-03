import type { Context } from './resolvers.helpers.js';
import type { ActInstruction } from '../../../lib/auth/instructedAct.js';
import { resolveTaskRef, mayReadAppTasks } from './resolvers.agentTask.js';
import { readableInstructionMessageApp } from './resolvers.teamChat.js';

/** #3307: reuse the actual task/channel read gates on the transaction's caller, then narrow to this App. */
export async function readActInstruction(ctx: Context, appId: string, instruction: ActInstruction): Promise<boolean> {
  if (instruction.kind === 'TASK') {
    if (!/^hrn:agenttask:/i.test(instruction.ref)) return false;
    const taskId = await resolveTaskRef(ctx, instruction.ref);
    // The instruction gate needs the App identity, never the task's description, properties or result.
    const task = taskId ? await ctx.db.agentTask.findUnique({ where: { id: taskId }, select: { appId: true } }) : null;
    if (!task || !(await mayReadAppTasks(ctx, task.appId))) return false;
    return task.appId === appId;
  }
  if (instruction.kind === 'TEAM_CHAT_MESSAGE') {
    return (await readableInstructionMessageApp(ctx, instruction.ref)) === appId;
  }
  return false;
}
