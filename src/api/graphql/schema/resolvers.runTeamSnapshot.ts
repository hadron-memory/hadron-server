/** #2925 / ruling0112: only a managing person opts an App's automation into team reads. */
import { type Context, requireOwnerOrOrgRole } from './resolvers.helpers.js';
import { actorManagesApp, resolveParticipatedApp, taskError, loadApp } from './resolvers.agentTask.js';
import { writeInApp } from './resolvers.ticker.js';
import { requirePersonAsThemselves } from '../../../lib/auth/personAsThemselves.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { GraphQLError } from 'graphql';

export const runTeamSnapshotMutations = {
  setAppRunTeamSnapshotEnabled: async (_: unknown, { appRef, enabled }: { appRef: string; enabled: boolean }, ctx: Context) => {
    const refuse = () => taskError('FORBIDDEN', 'Only a person who manages this App may change its run team snapshot setting.');
    await requirePersonAsThemselves(ctx, refuse);
    const { app, actor } = await resolveParticipatedApp(ctx, appRef);
    return writeInApp(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, c, fresh) => {
      await requirePersonAsThemselves(c, refuse);
      if (!(await actorManagesApp(c, fresh, actor))) throw refuse();
      return tx.app.update({ where: { id: fresh.id }, data: { runTeamSnapshotEnabled: enabled } });
    }, { lockMode: 'exclusive' });
  },
};

export const runTeamSnapshotAppResolvers = {
  runTeamSnapshotEnabled: async (parent: { id: string }, _: unknown, ctx: Context) => {
    // Nested App fields have no reliable outer gate. Read afresh and mask unauthorized callers.
    const app = await loadApp(ctx, parent.id);
    if (!app || app.deletedAt) return null;
    try { await requireOwnerOrOrgRole(ctx, app, 'READER'); }
    catch (e) {
      if (!(e instanceof GraphQLError) || e.extensions.code !== 'FORBIDDEN') throw e;
      if (!await managesApp(ctx, app)) return null;
    }
    return app.runTeamSnapshotEnabled;
  },
};
