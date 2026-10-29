/** #2677: one routed pick over #2608's candidates; a read only, never assignment or delivery. */
import { Prisma } from '../../../generated/prisma/index.js';
import { type Context, requireReadableAgent, withoutRequestCaches } from './resolvers.helpers.js';
import { loadRoleCandidates } from './resolvers.registerRoleCandidates.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { appManagerUserIds, managesApp } from '../../../lib/auth/appManagement.js';
import { compareRank, loadWorkerWorkStates, matchable } from '../../../lib/agentTasks/matcher.js';

type Entry = { kind: 'WORKER' | 'USER'; id: string };

async function agentReadable(tx: Prisma.TransactionClient, c: Context, agentId: string): Promise<boolean> {
  const agent = await tx.agent.findUnique({ where: { id: agentId } });
  try { await requireReadableAgent(c, agent, agentId); return true; }
  catch (e) { if (e instanceof AgentNotFoundError) return false; throw e; }
}

export const registerRolePickQueries = {
  registerRolePick: async (_: unknown, args: { appRef: string; code: string; workerRef?: string | null }, ctx: Context) =>
    ctx.db.$transaction(async (tx) => {
      const c = withoutRequestCaches(ctx, tx);
      const { appId, app, candidates, agentOf } = await loadRoleCandidates(tx, c, args.appRef, args.code, { bySession: true });
      const result = (entries: Entry[]) => ({ appId, code: args.code, entries });
      // Eligibility is the matcher's own predicate (cor:agt:060:05), role from the open session's placement (#2458).
      const states = (await loadWorkerWorkStates(tx as never, appId, new Date(), { bySession: true })).filter((w) => w.free && matchable(w));
      const eligible = new Map(states.map((w) => [w.id, w]));
      const pickOne = (ids: string[]): Entry[] => {
        const best = ids.map((id) => eligible.get(id)).filter((w): w is NonNullable<typeof w> => !!w).sort(compareRank)[0];
        return best ? [{ kind: 'WORKER', id: best.id }] : [];
      };

      // 1. A named worker wins only as a candidate for this code (the task in its chain; readable and
      //    not retired by #2608's gate) AND free (cor:agt:110:05); otherwise it reads as naming nobody.
      if (args.workerRef && candidates.some((x) => x.worker.id === args.workerRef)) {
        const hit = pickOne([args.workerRef]);
        if (hit.length) return result(hit);
      }
      // 2. The role holders: lowest depth with an eligible worker, then the next depth.
      for (const depth of [...new Set(candidates.map((x) => x.depth))].sort((a, b) => a - b)) {
        const hit = pickOne(candidates.filter((x) => x.depth === depth).map((x) => x.worker.id));
        if (hit.length) return result(hit);
      }
      // 3. The coordinator role holders (placement role, case-insensitive), picked the same way.
      const coordinators: string[] = [];
      for (const w of states) {
        if ((w.role ?? '').toLowerCase() !== 'coordinator') continue;
        const agentId = agentOf.get(w.id);
        if (agentId && await agentReadable(tx, c, agentId)) coordinators.push(w.id);
      }
      const coord = pickOne(coordinators);
      if (coord.length) return result(coord);
      // 4. The App's managers, users, in the helper's order; only a manager caller sees them.
      if (await managesApp({ ...c, db: tx } as never, app as never)) {
        return result((await appManagerUserIds(tx, app as never)).map((id) => ({ kind: 'USER' as const, id })));
      }
      return result([]);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 }),
};
