/** #3470/#3491: the one register-answer gate, shared by action answers and task warnings (cor:agt:110:03). */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import type { RegisterLookup } from './lookup.js';

export type ActionAnswer = { code: string; state: 'MAPPED' | 'UNMAPPED' | 'UNRESOLVED' | 'WITHHELD'; taskLoc: string | null; taskUrn: string | null };

/**
 * The answer, read through ONE lookup inside an open bounded read (cor:agt:110:03, rulings 0163, 0164, 0176): MAPPED,
 * UNMAPPED or UNRESOLVED only when the caller may read every system memory on the chains looked up, else WITHHELD.
 * Shared by action answers and task warnings so there is one gate. A throw is the caller's to turn into WITHHELD.
 */
export async function answerWithLookup(lookup: RegisterLookup, c: Context, code: string, agentId: string): Promise<ActionAnswer> {
  const empty: ActionAnswer = { code, state: 'UNMAPPED', taskLoc: null, taskUrn: null };
  const team = await lookup.teamMemory();
  if (!team) return empty;
  for (const id of await lookup.chain(team)) if (!await lookup.readable(c, id, 'reader')) return { ...empty, state: 'WITHHELD' };
  const entry = await lookup.entry(code);
  if (entry.state !== 'FOUND') return { ...empty, state: entry.state };
  const agent = await lookup.tx.agent.findFirst({ where: { id: agentId, deletedAt: null }, select: { systemMemoryId: true } });
  const memoryId = agent?.systemMemoryId;
  if (memoryId) {
    for (const id of await lookup.chain(memoryId)) if (!await lookup.readable(c, id, 'reader')) return { ...empty, state: 'WITHHELD' };
    const task = (await lookup.task(memoryId, entry.taskLoc))?.task;
    if (task) return { code, state: 'MAPPED', taskLoc: task.loc, taskUrn: task.urn };
  }
  return { ...empty, state: 'UNRESOLVED', taskLoc: entry.taskLoc };
}
