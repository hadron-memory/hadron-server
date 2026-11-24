/**
 * #3711 (Grants S2b; cor:acl:140:05 Create/List/Revoke, :03 first end, rulings 0253 item 4, 0255 items 5 and 21, V56/V57): the
 * manager's grant surface on GraphQL. `appGrants` lists every grant of one App for whoever manages it; `revokeGrant` ends one (the
 * issuer, whoever manages the App, or a held worker on a validated instruction from a holder who may); `withdrawGrant` is the
 * requester ending its OWN still-pending request. The manager arm of `createGrant` lives in resolvers.grantCreate.ts and uses
 * {@link resolveGrantManager} here.
 *
 * #4167 (cor:acl:140:05 Revoke, Holger 2026-11-14): a manager may revoke also while the App is UNINSTALLED (not deleted). The
 * widening is the manager arm alone — the issuer arm (below) and `withdrawGrant` keep their installed-App refusals, a deleted App
 * refuses exactly as an unknown one does, and the uninstalled-App refusal a non-manager sees is byte-identical to the installed one.
 *
 * WHO. A manager is a PERSON acting as themselves (the one person gate, `resolveGrantPerson`: not an App key, a run, an impersonated
 * session or a worker session) for whom the ONE shared predicate `managesApp` holds, judged on the transaction under the App's
 * anchors with the caller's memberships locked (a revoked membership never authorizes: `managesApp` reads `deletedAt: null`).
 * Every refusal that could tell a caller an App or grant exists is the same refusal as for one that does not.
 *
 * ISSUER. The issuer arm is deliberately narrower than the text of cor:acl:140:05 (Vera's FIT, the gate): an issuer revokes only
 * while still a LIVE member of the App's Org. Whether an issuer who left the Org may still revoke is an open ruling; this
 * door does not widen it.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { clampListTake } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { inTaskWriteTx, loadApp, requireWritable, resolveTaskActor, type TaskApp } from './resolvers.agentTask.js';
import { lockCallerSession, readActInstruction } from './resolvers.instruction.js';
import { requireInstructedAct } from '../../../lib/auth/instructedAct.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { resolveGrantPerson, resolveGrantReader } from './resolvers.grant.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';
import { lockAppManagerMemberships, managesApp } from '../../../lib/auth/appManagement.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import type { ActAdmission, ActInstruction } from '../../../lib/auth/instructedAct.js';
import { appendCredentialInstructionEvent } from '../../../lib/agentTasks/events.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { isAppRefResolutionFailure } from '../../../lib/auth/workerRead.js';
import { getGrantForManager, getGrantForWorker, listGrantsForManager } from '../../../lib/grants/read.js';
import { endGrant, GrantManageRefusal, type GrantEnder, type LockedGrant } from '../../../lib/grants/manage.js';
import { GrantRunGone } from '../../../lib/grants/create.js';
import { grantStateSql } from '../../../lib/grants/state.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';

export function manageRefusal(error: GrantManageRefusal): GraphQLError {
  return new GraphQLError(error.message, { extensions: { code: error.code } });
}
const notManager = () => manageRefusal(new GrantManageRefusal('GRANT_NOT_MANAGER'));
const notFound = () => manageRefusal(new GrantManageRefusal('GRANT_NOT_FOUND'));

/**
 * #4767 (R6): the run-made arm of `withdrawGrant`'s requester match — the locked row's holder agent equals the caller-worker's
 * role agent. FAILS CLOSED on an unread role agent: `workers.agent_id` is NOT NULL and the read runs under the worker row's
 * FOR SHARE before this judgement, so a null here means the read never happened (a gone worker row), and `null === null`
 * must never match a holder-less run-made row (Beatrix P2 on 99459f15; Antonio P3-2 — unreachable today, guarded anyway).
 */
export function runMadeRequestOfRoleAgent(row: Pick<LockedGrant, 'requestedByRunId' | 'agentId'>, roleAgentId: string | null): boolean {
  return roleAgentId !== null && row.requestedByRunId !== null && row.agentId === roleAgentId;
}

/** An App by id or URN, or null when it is missing, malformed or soft-deleted (all one answer). Never an uninstalled-App distinction. */
export async function resolveLiveApp(ctx: Context, appRef: string): Promise<TaskApp | null> {
  let id: string;
  try {
    ({ id } = await resolveAppRef(ctx.db, appRef));
  } catch (e) {
    if (isAppRefResolutionFailure(e)) return null;
    throw e;
  }
  const app = await loadApp(ctx, id);
  return app && !app.deletedAt ? app : null;
}

/**
 * The person and the App, when this request is a person acting as themselves who manages the App; null otherwise (the caller turns
 * that into its own concealing answer). Used by the list, and, before its locks, by the manager arm of create.
 */
export async function resolveGrantManager(ctx: Context, appRef: string | null | undefined): Promise<{ userId: string; app: TaskApp } | null> {
  if (!appRef) return null;
  const userId = await resolveGrantPerson(ctx);
  if (!userId) return null;
  const app = await resolveLiveApp(ctx, appRef);
  if (!app || !(await managesApp(ctx, app))) return null;
  return { userId, app };
}

/** Whether `userId` is still a live member of the App's Org (any role): the issuer arm. A user-owned App has no Org: its issuer revokes as its manager. */
async function issuerStillMember(ctx: Context, app: TaskApp, userId: string): Promise<boolean> {
  if (!app.organizationId) return false;
  const member = await ctx.db.orgMember.findFirst({ where: { organizationId: app.organizationId, userId, ...LIVE_ORG_MEMBERSHIP }, select: { userId: true } });
  return member !== null;
}

/** Whether the caller's session is open NOW: not ended and not past its hard expiry (R5), on the database clock. Read after the locks it depends on. */
async function sessionOpen(tx: Prisma.TransactionClient, sessionId: string | null | undefined): Promise<boolean> {
  if (!sessionId) return false;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sessions WHERE id = ${sessionId} AND ended_at IS NULL
    AND (expires_at IS NULL OR expires_at > (clock_timestamp() AT TIME ZONE 'UTC'))`;
  return rows.length > 0;
}

export const grantManageQueries = {
  appGrants: async (_p: unknown, { appRef, limit, offset }: { appRef: string; limit?: number | null; offset?: number | null }, ctx: Context) => {
    const manager = await resolveGrantManager(ctx, appRef);
    if (!manager) return { items: [], total: 0 };
    return listGrantsForManager(ctx.db, manager.app.id, { take: clampListTake(limit), skip: Math.max(0, offset ?? 0) });
  },
};

export const grantManageMutations = {
  /** Revoke: see the module comment. Every refusal is GRANT_NOT_MANAGER (unknown grant, unreadable grant and not allowed alike). */
  revokeGrant: async (_p: unknown, { ref, instruction }: { ref: string; instruction?: ActInstruction | null }, ctx: Context) => {
    const found = typeof ref === 'string' ? await ctx.db.grant.findUnique({ where: { id: ref }, select: { appId: true } }) : null;
    const app = found ? await loadApp(ctx, found.appId) : null;
    const actor = app ? await resolveTaskActor(ctx, app) : null;
    // A NEW door: no headless run is admitted (the gate: no headless or impersonation bypass; Xanthos' keep-runs carve-out is for main's
    // older doors). A run, and every write precondition (impersonation, refused binding), answers as a non-manager does. #4167
    // (hrn:node:hadronmemory.com:specs:cor:acl:140:05, Holger 2026-11-14) is the one exception: an UNINSTALLED (not deleted) App no
    // longer refuses this door — whoever manages the App may end its grants — and the judge below scopes that to the manager arm alone.
    if (!app || app.deletedAt || !actor || isRunPrincipal(ctx)) throw notManager();
    try {
      requireWritable(ctx, app, { allowUninstalled: true });
    } catch (e) { if (e instanceof GraphQLError) throw notManager(); throw e; }
    try {
      return await inTaskWriteTx(ctx, app, actor, notManager, async (tx, txCtx, fresh) => {
        // The caller's session row is fenced before the judgement, so a session end cannot commit between it and the write.
        await lockCallerSession(tx, txCtx.sessionId);
        await lockAppManagerMemberships(tx, txCtx.userId, fresh);
        // The holder's right: whoever manages the App, or the grant's issuer while still an Org member (issuer read unlocked here;
        // the locked row is re-judged below, since a merge can move an issuer link).
        const issuerHint = (await tx.grant.findUnique({ where: { id: ref }, select: { issuerUserId: true } }))?.issuerUserId ?? null;
        let manager = false;
        const admission: ActAdmission = await requireInstructedAct(txCtx, fresh.id, instruction, async () => {
          manager = await managesApp(txCtx, fresh);
          // #4167: while the App is UNINSTALLED (not deleted) only the manager arm is admitted — a false return
          // (issuer, instructed-worker, non-manager alike) is refused by requireInstructedAct as notManager.
          if (fresh.uninstalledAt) return manager;
          return manager || (issuerHint !== null && issuerHint === txCtx.userId && await issuerStillMember(txCtx, fresh, txCtx.userId));
        }, readActInstruction, notManager);
        const ender: GrantEnder = {
          userId: txCtx.userId!,
          workerId: admission.kind === 'instructed-worker' ? admission.workerId : null,
          sessionId: admission.kind === 'instructed-worker' ? txCtx.sessionId ?? null : null,
        };
        const authorize = async (row: LockedGrant) => {
          if (row.appId !== fresh.id) throw notManager();
          if (manager) return;
          if (row.issuerUserId === null || row.issuerUserId !== txCtx.userId || !(await issuerStillMember(txCtx, fresh, txCtx.userId!))) throw notManager();
        };
        const { changed } = await endGrant(tx, ref, ender, {
          kind: 'revoke', authorize,
          beforeStamp: async (t) => { if (admission.kind === 'instructed-worker' && !(await sessionOpen(t, txCtx.sessionId))) throw notManager(); },
        });
        if (changed) await appendCredentialInstructionEvent(tx, { appId: fresh.id, admission, act: 'grant.revoke' });
        const view = await getGrantForManager(tx, fresh.id, ref, manager);
        if (!view) throw notManager();
        return view;
      }, { allowUninstalledApp: true, ...(actor.kind === 'worker' ? { lockWorkerIds: [actor.workerId] } : {}) });
    } catch (e) {
      if (e instanceof GrantManageRefusal) throw manageRefusal(e.code === 'GRANT_NOT_FOUND' ? new GrantManageRefusal('GRANT_NOT_MANAGER') : e);
      // Reachable, not stale: inTaskWriteTx's own catch rewrites a mid-tx gate refusal (e.g. a membership that
      // lapsed between the pre-tx and in-tx actor resolves) to APP_UNINSTALLED while the App is uninstalled.
      // This door answers that as the non-manager does, so no refusal ever names the App's install state.
      if (e instanceof GraphQLError && e.extensions?.code === 'APP_UNINSTALLED') throw notManager();
      throw e;
    }
  },

  /** Withdraw: see the module comment. The requester is matched on the SEALED requested-by ids of the locked row. */
  withdrawGrant: async (_p: unknown, { ref }: { ref: string }, ctx: Context) => {
    const found = typeof ref === 'string' ? await ctx.db.grant.findUnique({ where: { id: ref }, select: { appId: true, userId: true, requestedByUserId: true, issuerUserId: true } }) : null;
    // WHO is asking: a bound worker session, or a person as themselves (no key, run, impersonation).
    const reader = await resolveGrantReader(ctx);
    const person = reader ? null : await resolveGrantPerson(ctx);
    if (!found || (!reader && !person) || !ctx.userId) throw notFound();
    const app = await loadApp(ctx, found.appId);
    if (!app || app.deletedAt) throw notFound();
    // A grant the caller cannot read answers as a missing one: a worker reads what grant(ref:) reads; a person, a grant they manage, hold, asked for or issued.
    const readable = reader
      ? reader.appId === found.appId && (await getGrantForWorker(ctx.db, reader, ref)) !== null
      : (await managesApp(ctx, app)) || found.userId === person || found.requestedByUserId === person || found.issuerUserId === person;
    if (!readable) throw notFound();
    try { requireWritable(ctx, app); } catch (e) { if (e instanceof GraphQLError) throw notFound(); throw e; }
    const callerUserId = ctx.userId;
    // #4767 (R6): the caller-worker's role agent, read under its row lock below, for the run-made arm of the requester match.
    let roleAgentId: string | null = null;
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: found.appId }],
        async (txCtx) => {
          // The gate again, under the anchor.
          if (reader) {
            const again = await resolveGrantReader(txCtx);
            if (!again || again.appId !== reader.appId || again.workerId !== reader.workerId) throw notFound();
          } else if ((await resolveGrantPerson(txCtx)) !== person) throw notFound();
        },
        async (tx, txCtx) => {
          const ender: GrantEnder = { userId: callerUserId, workerId: reader?.workerId ?? null, sessionId: reader ? txCtx.sessionId ?? null : null };
          const authorize = (row: LockedGrant) => {
            if (row.appId !== found.appId) throw notFound();
            // A worker requester is matched on its worker id; a person only on a request that no worker made. #4767 (R6): a
            // worker session bound to the agent may also withdraw what a RUN of that agent asked for — the row's holder agent
            // plus its run column (ruling 0255 item 21: a bound session's call is the agent's). Both are the ROW's facts, and
            // the two arms are exclusive on a well-formed row (a run-made request records no worker), so the worker-id match
            // above is not loosened: a worker-made request still belongs to the worker that made it. The run-made arm fails
            // closed on an unread role agent (runMadeRequestOfRoleAgent): null never matches null.
            const mine = reader
              ? row.requestedByWorkerId === reader.workerId || runMadeRequestOfRoleAgent(row, roleAgentId)
              : row.requestedByWorkerId === null && row.requestedByUserId === person;
            if (!mine) throw new GrantManageRefusal('GRANT_NOT_REQUESTER');
          };
          await endGrant(tx, ref, ender, {
            kind: 'withdraw', authorize, pendingOnly: true,
            beforeStamp: async (t) => { if (reader && !(await sessionOpen(t, txCtx.sessionId))) throw notFound(); },
          });
          // A manager sees the audit facts; a requester who does not manage reads the plain record.
          const manager = !reader && (await managesApp(txCtx, app));
          const view = await getGrantForManager(tx, found.appId, ref, manager);
          if (!view) throw notFound();
          return view;
        },
        {
          // Same order as every worker write (inTaskWriteTx): the worker's assignment lock, the caller's memberships, the worker row; the
          // caller's session row is fenced next, then judged OPEN on the locked state, so a session that ended or a worker retired
          // before this commits cannot complete its one lasting write (Belinda P2-1 on 91002379).
          afterLock: async (tx) => {
            if (reader) await lockWorkersForAssignment(tx, [reader.workerId]);
            await lockAppManagerMemberships(tx, callerUserId, app);
            if (reader) {
              // #4767: the role agent read under the same FOR SHARE the arm's judgment needs (a role change waits on this lock).
              const [wk] = await tx.$queryRaw<Array<{ agent_id: string }>>`SELECT agent_id FROM workers WHERE id = ${reader.workerId} FOR SHARE`;
              roleAgentId = wk?.agent_id ?? null;
              await lockCallerSession(tx, ctx.sessionId);
              // Open means not ended AND not past its hard expiry, on the database clock after the lock (Beckett D1); judged AGAIN just before the
              // stamp (beforeStamp below), since the grant row lock can wait past it (Dorian P2 on 9cd8772f).
              if (!(await sessionOpen(tx, ctx.sessionId))) throw notFound();
            } else {
              // The person arm fences its own session too, as the revoke door does (Belinda N1).
              await lockCallerSession(tx, ctx.sessionId);
            }
          },
        },
      );
    } catch (e) {
      if (e instanceof GrantManageRefusal) throw manageRefusal(e);
      if (e instanceof Error && e.message === 'Forbidden') throw notFound();
      throw e;
    }
  },
};

/**
 * #4767 (Grants R6; cor:acl:140:03 item 5, ruling 0255 item 21): a headless run of agent A withdraws a PENDING grant A's
 * own run asked for (`requested_by_run_id`). The run tool `hadron_withdraw_grant` is the one door onto this; GraphQL
 * `withdrawGrant` keeps refusing a run principal (its worker-session arm is the R6 door for sessions, above).
 *
 * The requester is the ROW's fact — its holder agent plus its run column — never the calling run's identity: a later run of
 * the same agent qualifies exactly as much as the one that asked. The end names no person: `revoked_by` stays NULL,
 * `withdrawn_at` pairs with `revoked_at` (the shape CHECK's rule), and the one WITHDRAW event carries the run, so the act is
 * the agent's, attributed through it. The App, its org and owner and the agent are anchored as the create arm anchors them
 * (#3753); the run row is then locked FOR SHARE and judged RUNNING in this App for this agent before the end, and the grant
 * row lock stays the LAST lock (the manage core's rule).
 *
 * Concealment: every way the grant is not this agent's own run-made request — missing, another agent's, this agent's in
 * another App, a person's or a worker's request — is the ONE GRANT_NOT_REQUESTER refusal, byte-identical to a missing id.
 * Only GRANT_NOT_PENDING differs, and it fires after the requester match, so it tells the rightful caller what it can read
 * anyway. A run that is not RUNNING, a principal naming another run or App, an agentless run, or a gone App/org/owner is the
 * create arm's concealing APP_NOT_FOUND.
 */
export async function withdrawGrantForRun(principal: Context, run: { id: string; appId: string; agentId: string | null }, input: { grantId: string }): Promise<{ id: string; status: string }> {
  const gone = () => new GraphQLError('App not found.', { extensions: { code: 'APP_NOT_FOUND' } });
  if (!isRunPrincipal(principal) || principal.appId !== run.appId || principal.clientId !== `run:${run.id}`) throw gone();
  const agentId = run.agentId;
  if (!agentId) throw gone();
  const app = await principal.db.app.findUnique({ where: { id: run.appId }, select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true } });
  if (!app || app.deletedAt) throw gone();
  const anchors: AuthorityAnchor[] = [
    { kind: 'app', id: app.id },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    { kind: 'agent', id: agentId },
  ];
  const notRequester = () => manageRefusal(new GrantManageRefusal('GRANT_NOT_REQUESTER'));
  try {
    return await withAuthorizedTx(
      principal, anchors,
      async () => { /* the run itself is judged in the body, under these locks */ },
      async (tx) => {
        // The run row, locked FOR SHARE after the anchors, must still be RUNNING in this App for this agent (the create
        // core's judgment, #3753): a run that finished refuses concealed, and one that finishes next waits on this lock.
        const runs = await tx.$queryRaw<Array<{ app_id: string; agent_id: string | null; status: string }>>`
          SELECT app_id, agent_id, status::text AS status FROM app_runs WHERE id = ${run.id} FOR SHARE`;
        if (runs.length !== 1 || runs[0]!.app_id !== app.id || runs[0]!.agent_id !== agentId || runs[0]!.status !== 'RUNNING') throw new GrantRunGone();
        const authorize = (row: LockedGrant) => {
          // The row's own facts only: this App, this agent the holder, a request a RUN made. Every other grant answers the
          // one refusal, byte-identical to a missing id (the tool's concealment, above).
          if (row.appId !== app.id || row.requestedByRunId === null || row.agentId !== agentId) throw new GrantManageRefusal('GRANT_NOT_REQUESTER');
        };
        // The end names no person: the event carries the run, the row carries the withdrawal marker.
        await endGrant(tx, input.grantId, { userId: null, workerId: null, sessionId: null, runId: run.id }, { kind: 'withdraw', authorize, pendingOnly: true });
        const [ended] = await tx.$queryRaw<Array<{ state: string }>>(Prisma.sql`SELECT ${grantStateSql('g')} AS state FROM grants g WHERE g.id = ${input.grantId}`);
        if (!ended) throw new GrantManageRefusal('GRANT_NOT_FOUND'); // unreachable under the row lock
        return { id: input.grantId, status: ended.state.toLowerCase() };
      },
    );
  } catch (error) {
    if (error instanceof GrantRunGone) throw gone();
    if (error instanceof GrantManageRefusal) {
      // GRANT_NOT_FOUND (no row, or a soft-deleted App's) reads exactly like a grant that is not this agent's request.
      throw error.code === 'GRANT_NOT_FOUND' ? notRequester() : manageRefusal(error);
    }
    if ((error instanceof GraphQLError && error.extensions?.code === 'FORBIDDEN') || (error instanceof Error && error.message === 'Forbidden')) {
      // An anchor refused under the lock: the App, org, owner or agent went. A gone App/org/owner is concealed; a gone agent
      // ended the row with its holder (the departure doors stamp in the deleting transaction), so it is not this run's to
      // withdraw — either way the concealing answers, judged on a fresh read. A Forbidden with every anchor live propagates.
      const agent = await principal.db.agent.findFirst({ where: { id: agentId, deletedAt: null }, select: { id: true } });
      const liveApp = await principal.db.app.findFirst({ where: { id: app.id, deletedAt: null }, select: { id: true } });
      const liveOrg = !app.organizationId || (await principal.db.organization.findFirst({ where: { id: app.organizationId, deletedAt: null }, select: { id: true } }));
      const liveOwner = !app.ownerUserId || (await principal.db.user.findFirst({ where: { id: app.ownerUserId, deletedAt: null }, select: { id: true } }));
      if (!liveApp || !liveOrg || !liveOwner) throw gone();
      if (!agent) throw notRequester();
    }
    throw error;
  }
}
