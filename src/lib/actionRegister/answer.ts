/** #3449: optional code-to-role-task projection, read as the caller (cor:agt:110:03). */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { withoutRequestCaches } from '../../api/graphql/schema/resolvers.helpers.js';
import { boundedRead } from '../../api/graphql/schema/resolvers.taskWarnings.js';
import { RegisterLookup } from './lookup.js';

export type ActionAnswer = { code: string; state: 'MAPPED' | 'UNMAPPED' | 'UNRESOLVED' | 'WITHHELD'; taskLoc: string | null; taskUrn: string | null };

/** Post-commit guidance: a failed/expired read never reverses an accepted event. */
export async function resolveActionAnswer(ctx: Context, appId: string, code: string, agentId: string | null): Promise<ActionAnswer> {
  const empty: ActionAnswer = { code, state: 'UNMAPPED', taskLoc: null, taskUrn: null };
  // Holger ruling 0159: a caller with no Agent gets code only, with no lookup.
  if (!agentId) return { ...empty, state: 'WITHHELD' };
  try {
    return await boundedRead(ctx, async (tx, deadline) => {
      const c = withoutRequestCaches(ctx, tx);
      const lookup = new RegisterLookup(tx, c, appId, deadline);
      const team = await lookup.teamMemory();
      if (!team) return empty;
      for (const id of await lookup.chain(team)) if (!await lookup.readable(c, id, 'reader')) return { ...empty, state: 'WITHHELD' };
      const entry = await lookup.entry(code);
      if (entry.state !== 'FOUND') return { ...empty, state: entry.state };
      const agent = await tx.agent.findFirst({ where: { id: agentId, deletedAt: null }, select: { systemMemoryId: true } });
      const memoryId = agent?.systemMemoryId;
      if (memoryId) {
        for (const id of await lookup.chain(memoryId)) if (!await lookup.readable(c, id, 'reader')) return { ...empty, state: 'WITHHELD' };
        const task = (await lookup.task(memoryId, entry.taskLoc))?.task;
        if (task) return { code, state: 'MAPPED', taskLoc: task.loc, taskUrn: task.urn };
      }
      return { ...empty, state: 'UNRESOLVED', taskLoc: entry.taskLoc };
    });
  } catch {
    // Fixed category only: never log the caller, code, task loc or private failure details.
    console.warn('action_register.answer_failed');
    return { ...empty, state: 'WITHHELD' };
  }
}
