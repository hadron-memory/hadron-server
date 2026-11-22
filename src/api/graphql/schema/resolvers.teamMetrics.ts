/**
 * #4447 (S1 of #3781): `teamMetrics`, the counts of a team's task and worker flow
 * (hrn:node:hadronmemory.com:specs:cor:agt:150). Computed in src/lib/agentTasks/teamMetrics.ts; this file is the gate and the projection.
 *
 * AUTHORIZATION: exactly the roster's. The read goes through `withRosterAppRead` (one RepeatableRead snapshot, the same
 * refusal for an outsider, a missing App and a caller with no standing: APP_NOT_FOUND). The counts derived from tasks
 * (reports 1, 2 and 4) follow the App's task readers (`mayReadAppTasks`, cor:agt:050:21, Proposed): a reader who may see
 * the roster but not the tasks gets those null, never zeros. The worker counts follow the roster audience.
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { withRosterAppRead } from './resolvers.agentTaskMatching.js';
import { mayReadAppTasks, partyView } from './resolvers.agentTask.js';
import { MetricsWindowError, loadFlow, loadStartedOwned, loadStartedProjects, loadWorkerCounts, resolveMetricsWindow } from '../../../lib/agentTasks/teamMetrics.js';

export interface TeamMetricsArgs { appRef: string; since?: unknown; until?: unknown }

export const teamMetricsQueries = {
  teamMetrics: async (_: unknown, args: TeamMetricsArgs, ctx: Context) => {
    // The argument checks come BEFORE admission and before any transaction (as teamUtilization's, #4497): they depend only on
    // the arguments, so they answer alike for every App, readable, concealed or missing, and disclose nothing about it.
    let window: { since: Date; until: Date };
    try {
      window = resolveMetricsWindow(args.since, args.until, new Date());
    } catch (e) {
      if (e instanceof MetricsWindowError) throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT' } });
      throw e;
    }
    return withRosterAppRead(ctx, args.appRef, async (readCtx, app) => {
      const asOf = new Date();
      const db = readCtx.db;
      const canReadTasks = await mayReadAppTasks(readCtx, app.id);
      const [workers, startedOwned, projects, flow] = await Promise.all([
        loadWorkerCounts(db, app.id, asOf),
        canReadTasks ? loadStartedOwned(db, app.id) : null,
        canReadTasks ? loadStartedProjects(db, app.id) : null,
        canReadTasks ? loadFlow(db, app.id, window.since, window.until) : null,
      ]);
      return {
        appId: app.id,
        asOf,
        window,
        workers,
        projects,
        flow,
        startedOwned: startedOwned && {
          all: startedOwned.all,
          ownersTruncated: startedOwned.ownersTruncated,
          // The sanitized party projection, batched per request: never the Worker or User object.
          byOwner: await Promise.all(startedOwned.byOwner.map(async (g) => ({
            owner: await partyView(readCtx, g.workerId, g.userId),
            tasks: g.tasks, byProject: g.byProject, projectsTruncated: g.projectsTruncated,
          }))),
        },
      };
    });
  },
};
