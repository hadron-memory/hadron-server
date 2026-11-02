/**
 * #3125 S3 — `untrackedTaskItems` and `claimUntrackedTaskItems` (cor:agt:120:03; plan
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:plans:server-3125-task-integrations §S3).
 *
 * One implementation behind two fields: a list cannot write in a GraphQL query, so the claim is its own mutation.
 *
 * Who may ask (V38). Listing and claiming: a participant of the App (a person, or a worker through its session), the
 * App's own live key (`withReadableApp`, the agentTasks read gate) and, through the run tool, a headless run of the App
 * (`withRunTaskApp`). A person or a worker claims for themselves. #3132 (V41, V45 point 12): a key or a run names the
 * assignee (TASK_ASSIGNEE_REQUIRED) and, unless a run acts for a person, the owner (TASK_OWNER_REQUIRED); its claim
 * writes under the key or run as creator (`createStartedClaimFor`), the key's one task write (cor:agt:050:23). Anyone
 * else, and another App's key, is answered APP_NOT_FOUND, the same whether or not the App has an integration. The
 * integration is looked up in the resolved App's own properties only.
 *
 * Judged in this order, each before any GitHub call: the gate, the integration name, the repository, the team, a key's
 * or run's assignee and owner, the page bounds. Any App may hold task integrations (rulings:0071 = B); one with no organization has no GitHub App installation
 * to read through, so it is GITHUB_NOT_INSTALLED after those checks, as an organization with none is. GitHub calls run OUTSIDE any database transaction; the read of the App's claimed external ids that
 * follows re-runs the gate, so a key revoked during the GitHub read is refused rather than answered.
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import {
  TASK_TITLE_MAX,
  createStartedClaim,
  createStartedClaimFor,
  requireRunOwnApp,
  requireWritable,
  resolveClaimParties,
  resolveParticipatedApp,
  resolveTaskWorkerId,
  taskError,
  withReadableApp,
  withRunTaskApp,
  type ClaimParties,
  type ClaimPartiesInput,
  type KeyCreator,
  type RunCreator,
  type TaskActor,
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

type Resolved = { app: TaskApp; organizationId: string | null; integration: StoredTaskIntegration; filters: UntrackedFilters };

/** The integration and filters, judged against the resolved App (on `c`, the gate's own client). */
async function resolveIntegration(c: Context, app: TaskApp, args: Args): Promise<Resolved> {
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
  return { app, organizationId: app.organizationId, integration, filters: { repository, teamLabel, ready: args.ready ?? 'ANY' } };
}

function bounded(value: number | null | undefined, def: number, min: number, max: number, field: string): number {
  if (value == null) return def;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw badInput(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}

/**
 * Who is asking, and the read gate for them. `participant`: a person or a worker session; `appKey`: the App's own key
 * (both through GraphQL, gated by `withReadableApp`); `run`: a headless run through its run tool, gated to its own App.
 */
export type UntrackedCaller =
  | { kind: 'graphql' }
  | { kind: 'run'; run: { id: string; appId: string } };

type ReadGate = <T>(body: (c: Context, app: TaskApp) => Promise<T>) => Promise<T>;

async function readGate(ctx: Context, caller: UntrackedCaller, appRef: string | null | undefined): Promise<ReadGate> {
  if (caller.kind === 'run') {
    await requireRunOwnApp(ctx, caller.run, appRef);
    return (body) => withRunTaskApp(ctx, caller.run, body);
  }
  return (body) => withReadableApp(ctx, appRef as string, body);
}

/** The read itself: GitHub (outside any transaction), then the App's claimed ids under the re-run read gate. */
async function readUntracked(ctx: Context, gate: ReadGate, r: Resolved) {
  // No organization, no installation: the same code an organization without one gets, before any GitHub call.
  const organizationId = r.organizationId;
  if (!organizationId) {
    throw new GraphQLError('This App belongs to no organization, so it has no GitHub App installation.', { extensions: { code: 'GITHUB_NOT_INSTALLED' } });
  }
  try {
    return await listUntrackedItems(ctx.db, {
      organizationId,
      integration: r.integration,
      filters: r.filters,
      claimedIn: (urls) => gate(async (c, app) => {
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

/** A run names no App (its own is implied), so appRef is optional below. */
type CallerArgs = Omit<Args, 'appRef'> & { appRef?: string | null };

/** #3132: the list, for any caller the read gate admits (GraphQL's participant or key, or a run's tool). */
export async function listUntracked(
  ctx: Context,
  caller: UntrackedCaller,
  args: CallerArgs & { skip?: number | null; limit?: number | null },
) {
  const gate = await readGate(ctx, caller, args.appRef);
  const resolved = await gate((c, app) => resolveIntegration(c, app, args as Args));
  const skip = bounded(args.skip, 0, 0, Number.MAX_SAFE_INTEGER, 'skip');
  const limit = bounded(args.limit, UNTRACKED_PAGE_DEFAULT, 1, UNTRACKED_PAGE_MAX, 'limit');
  const list = await readUntracked(ctx, gate, resolved);
  return {
    items: list.items.slice(skip, skip + limit),
    total: list.items.length,
    complete: list.complete,
    incompleteReason: list.incompleteReason,
  };
}

type ClaimArgs = CallerArgs & ClaimPartiesInput & { limit?: number | null };

/** Who writes each claim: the person or worker itself, or a key or run for the parties it named. */
type Claimer =
  | { kind: 'actor'; actor: TaskActor }
  | { kind: 'creator'; creator: KeyCreator | RunCreator; parties: ClaimParties };

/**
 * #3125 S3 / #3132: the claim, for a person or worker (GraphQL), the App's own key (GraphQL) or a headless run (its
 * tool). Every refusal named in the header is judged before any GitHub call.
 */
export async function claimUntracked(ctx: Context, caller: UntrackedCaller, args: ClaimArgs) {
  const key = caller.kind === 'graphql' ? appKeyCaller(ctx) : null;
  let app: TaskApp;
  let resolved: Resolved;
  let claimer: Claimer;
  let gate: ReadGate;
  if (caller.kind === 'graphql' && !key) {
    const p = await resolveParticipatedApp(ctx, args.appRef as string);
    app = p.app;
    requireWritable(ctx, app);
    // A person or a worker claims for themselves (cor:agt:120:03); naming parties is a key's or a run's.
    if (args.owner || args.assignee) throw badInput('A person or a worker claims for themselves: assignee and owner are named only by an App key or a run.');
    resolved = await resolveIntegration(ctx, app, args as Args);
    claimer = { kind: 'actor', actor: p.actor };
    gate = await readGate(ctx, caller, args.appRef);
  } else {
    gate = await readGate(ctx, caller, args.appRef);
    const creator: KeyCreator | RunCreator = key ? { kind: 'appKey', appKeyId: key.appKeyId } : { kind: 'run', runId: (caller as { run: { id: string } }).run.id };
    // A key acts for nobody; a run for the person it runs for, if any.
    const actsFor = creator.kind === 'run' ? ctx.userId ?? null : null;
    ({ app, resolved, claimer } = await gate(async (c, a) => {
      requireWritable(c, a);
      const r = await resolveIntegration(c, a, args as Args);
      const parties = await resolveClaimParties(c, a, { owner: args.owner, assignee: args.assignee }, actsFor);
      return { app: a, resolved: r, claimer: { kind: 'creator' as const, creator, parties } };
    }));
  }
  const limit = bounded(args.limit, UNTRACKED_CLAIM_DEFAULT, 1, UNTRACKED_CLAIM_MAX, 'limit');
  const list = await readUntracked(ctx, gate, resolved);

  const tasks = [];
  let incompleteReason: UntrackedIncompleteReason | 'claim_refused' | 'claim_failed' | null = list.incompleteReason;
  let refusalCode: string | null = null;
  for (const item of list.items) {
    if (tasks.length === limit) break;
    try {
      const claimed = { title: claimTitle(item), url: item.url };
      const task = claimer.kind === 'actor'
        ? await createStartedClaim(ctx, app, claimer.actor, claimed)
        : await createStartedClaimFor(ctx, app, claimer.creator, claimed, claimer.parties);
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
      // The error's name only: its message may carry tracker text or row values.
      const error = e instanceof Error ? e.name : typeof e;
      console.error('untracked.claim_failed', { appId: app.id, integration: resolved.integration.name, claimed: tasks.length, error });
      incompleteReason = 'claim_failed';
      break;
    }
  }
  return { tasks, complete: incompleteReason === null, incompleteReason, refusalCode };
}

export const untrackedTaskItemQueries = {
  untrackedTaskItems: (
    _: unknown,
    args: Args & { skip?: number | null; limit?: number | null },
    ctx: Context,
  ) => listUntracked(ctx, { kind: 'graphql' }, args),
};

export const untrackedTaskItemMutations = {
  claimUntrackedTaskItems: (
    _: unknown,
    args: Args & ClaimPartiesInput & { limit?: number | null },
    ctx: Context,
  ) => claimUntracked(ctx, { kind: 'graphql' }, args),
};
