/**
 * #3125 S3 — `untrackedTaskItems` and `claimUntrackedTaskItems` (cor:agt:120:03; plan
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:plans:server-3125-task-integrations §S3).
 *
 * One implementation behind two fields: a list cannot write in a GraphQL query, so the claim is its own mutation.
 *
 * Who may ask (V38, as split by Petra #63248). Listing: a participant of the App (a person, or a worker through its
 * session) or the App's own live key (`withReadableApp`, the agentTasks read gate). Claiming: a person or a worker;
 * the App's own key is refused TASK_CLAIM_PRINCIPAL_UNSUPPORTED before anything else is read, until the key/run claim
 * slice lands (V45 point 13). Anyone else, and another App's key, is answered APP_NOT_FOUND, the same whether or not
 * the App has an integration. The integration is looked up in the resolved App's own properties only.
 *
 * Judged in this order, each before any GitHub call: the gate, the App's organization, the integration name, the repository, the team, the
 * page bounds. GitHub calls run OUTSIDE any database transaction; the read of the App's claimed external ids that
 * follows re-runs the gate, so a key revoked during the GitHub read is refused rather than answered.
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import {
  TASK_TITLE_MAX,
  createStartedClaim,
  requireWritable,
  resolveParticipatedApp,
  resolveTaskWorkerId,
  taskError,
  withReadableApp,
  type TaskApp,
} from './resolvers.agentTask.js';
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import { TASK_INTEGRATIONS_KEY, type StoredTaskIntegration } from '../../../lib/appProperties.js';
import {
  listUntrackedItems,
  type ReadyFilter,
  type UntrackedFilters,
  type UntrackedIncompleteReason,
  type UntrackedItem,
} from '../../../lib/taskIntegrations/untracked.js';
import { GithubReadError } from '../../../lib/githubIssueSnapshot.js';

export const UNTRACKED_PAGE_DEFAULT = 20;
export const UNTRACKED_PAGE_MAX = 100;
export const UNTRACKED_CLAIM_DEFAULT = 1;
export const UNTRACKED_CLAIM_MAX = 10;

const badInput = (message: string) => taskError('BAD_USER_INPUT', message);

type Args = {
  appRef: string;
  integration: string;
  team?: string | null;
  repository?: string | null;
  ready?: ReadyFilter | null;
};

type Resolved = { app: TaskApp; organizationId: string; integration: StoredTaskIntegration; filters: UntrackedFilters };

/** The integration and filters, judged against the resolved App (on `c`, the gate's own client). */
async function resolveIntegration(c: Context, app: TaskApp, args: Args): Promise<Resolved> {
  // #3125 Ask 5: the same typed refusal S1 gives a write, before the integration is looked up or GitHub is read.
  const organizationId = app.organizationId;
  if (!organizationId) {
    throw taskError('TASK_INTEGRATION_ORG_REQUIRED', 'Task integrations need an App that belongs to an organization.');
  }
  const row = await c.db.app.findUnique({ where: { id: app.id }, select: { properties: true } });
  const props = row?.properties;
  const list = props && typeof props === 'object' && !Array.isArray(props)
    ? (props as Record<string, unknown>)[TASK_INTEGRATIONS_KEY]
    : undefined;
  const integration = Array.isArray(list)
    ? (list as StoredTaskIntegration[]).find((i) => i && typeof i === 'object' && i.name === args.integration)
    : undefined;
  if (!integration) {
    throw taskError('TASK_INTEGRATION_NOT_FOUND', 'This App has no task integration of that name.');
  }
  let repository: string | null = null;
  if (args.repository != null) {
    const wanted = args.repository.trim().toLowerCase();
    if (!integration.repositories.includes(wanted)) {
      throw taskError('TASK_INTEGRATION_REPOSITORY_NOT_CONNECTED', 'That repository is not connected to this task integration.');
    }
    repository = wanted;
  }
  let teamLabel: string | null = null;
  if (args.team != null) {
    const ref = args.team.trim();
    const workerId = ref === '' ? null : await resolveTaskWorkerId(c, app.id, ref);
    const team = workerId ? (integration.teams ?? []).find((t) => t.lead === workerId) : undefined;
    // An unresolvable ref and a worker that leads no listed team answer the same.
    if (!team) throw taskError('TASK_INTEGRATION_TEAM_UNKNOWN', "That worker leads no team in this task integration's team map.");
    teamLabel = team.label;
  }
  return { app, organizationId, integration, filters: { repository, teamLabel, ready: args.ready ?? 'ANY' } };
}

function bounded(value: number | null | undefined, def: number, min: number, max: number, field: string): number {
  if (value == null) return def;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw badInput(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}

/** The read itself: GitHub (outside any transaction), then the App's claimed ids under the re-run read gate. */
async function readUntracked(ctx: Context, appRef: string, r: Resolved) {
  try {
    return await listUntrackedItems(ctx.db, {
      organizationId: r.organizationId,
      integration: r.integration,
      filters: r.filters,
      claimedIn: (urls) => withReadableApp(ctx, appRef, async (c, app) => {
        const rows = await c.db.agentTask.findMany({ where: { appId: app.id, externalId: { in: urls } }, select: { externalId: true } });
        return new Set(rows.map((t) => t.externalId as string));
      }),
    });
  } catch (e) {
    if (e instanceof GithubReadError) throw new GraphQLError(e.message, { extensions: { code: e.code } });
    throw e;
  }
}

/** A task title from tracker text: control and format characters become spaces, clipped to the title cap. */
export function claimTitle(item: Pick<UntrackedItem, 'title' | 'repository' | 'number'>): string {
  // eslint-disable-next-line no-control-regex
  const clean = item.title.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/gu, ' ').replace(/\s+/g, ' ').trim();
  const clipped = Array.from(clean).slice(0, TASK_TITLE_MAX).join('').trim();
  return clipped === '' ? `${item.repository}#${item.number}` : clipped;
}

export const untrackedTaskItemQueries = {
  untrackedTaskItems: async (
    _: unknown,
    args: Args & { skip?: number | null; limit?: number | null },
    ctx: Context,
  ) => {
    const resolved = await withReadableApp(ctx, args.appRef, (c, app) => resolveIntegration(c, app, args));
    const skip = bounded(args.skip, 0, 0, Number.MAX_SAFE_INTEGER, 'skip');
    const limit = bounded(args.limit, UNTRACKED_PAGE_DEFAULT, 1, UNTRACKED_PAGE_MAX, 'limit');
    const list = await readUntracked(ctx, args.appRef, resolved);
    return {
      items: list.items.slice(skip, skip + limit),
      total: list.items.length,
      complete: list.complete,
      incompleteReason: list.incompleteReason,
    };
  },
};

export const untrackedTaskItemMutations = {
  claimUntrackedTaskItems: async (
    _: unknown,
    args: Args & { limit?: number | null },
    ctx: Context,
  ) => {
    if (appKeyCaller(ctx)) {
      // Another App's key, or a key that may not read, is APP_NOT_FOUND exactly as for a list; the App's own key is
      // refused before its properties or GitHub are read (interim, until the key/run claim slice; V45 point 13).
      await withReadableApp(ctx, args.appRef, async () => undefined);
      throw taskError('TASK_CLAIM_PRINCIPAL_UNSUPPORTED', 'An App key cannot claim outside items yet; a person or a worker claims them.');
    }
    const { app, actor } = await resolveParticipatedApp(ctx, args.appRef);
    requireWritable(ctx, app);
    const resolved = await resolveIntegration(ctx, app, args);
    const limit = bounded(args.limit, UNTRACKED_CLAIM_DEFAULT, 1, UNTRACKED_CLAIM_MAX, 'limit');
    const list = await readUntracked(ctx, args.appRef, resolved);

    const tasks = [];
    let incompleteReason: UntrackedIncompleteReason | 'claim_refused' | 'claim_failed' | null = list.incompleteReason;
    let refusalCode: string | null = null;
    for (const item of list.items) {
      if (tasks.length === limit) break;
      try {
        const task = await createStartedClaim(ctx, app, actor, { title: claimTitle(item), url: item.url });
        // null: another caller claimed it first; take the next (D5).
        if (task) tasks.push(task);
      } catch (e) {
        // R4 / V42: each claim committed alone; a refusal stops the walk and is returned beside them, not thrown.
        if (e instanceof GraphQLError && typeof e.extensions?.code === 'string') {
          incompleteReason = 'claim_refused';
          refusalCode = e.extensions.code;
          break;
        }
        // An unexpected failure: with nothing claimed yet it surfaces as any error does; after a claim it is logged
        // (ids only) and the claims already committed are still returned (cor:agt:120:03).
        if (tasks.length === 0) throw e;
        console.error('untracked.claim_failed', { appId: app.id, integration: resolved.integration.name, claimed: tasks.length });
        incompleteReason = 'claim_failed';
        break;
      }
    }
    return { tasks, complete: incompleteReason === null, incompleteReason, refusalCode };
  },
};
