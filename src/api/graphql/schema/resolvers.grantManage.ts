/**
 * #3711 (Grants S2b; cor:acl:140:05 Create/List/Revoke, :03 first end, rulings 0253 item 4, 0255 items 5 and 21, V56/V57): the
 * manager's grant surface on GraphQL. `appGrants` lists every grant of one App for whoever manages it; `revokeGrant` ends one (the
 * issuer, whoever manages the App, or a held worker on a validated instruction from a holder who may); `withdrawGrant` is the
 * requester ending its OWN still-pending request. The manager arm of `createGrant` lives in resolvers.grantCreate.ts and uses
 * {@link resolveGrantManager} here.
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
import { AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { UrnNotQualifiedError } from '../../../lib/urn.js';
import { getGrantForManager, getGrantForWorker, listGrantsForManager } from '../../../lib/grants/read.js';
import { endGrant, GrantManageRefusal, type GrantEnder, type LockedGrant } from '../../../lib/grants/manage.js';

export function manageRefusal(error: GrantManageRefusal): GraphQLError {
  return new GraphQLError(error.message, { extensions: { code: error.code } });
}
const notManager = () => manageRefusal(new GrantManageRefusal('GRANT_NOT_MANAGER'));
const notFound = () => manageRefusal(new GrantManageRefusal('GRANT_NOT_FOUND'));

/** An App by id or URN, or null when it is missing, malformed or soft-deleted (all one answer). Never an uninstalled-App distinction. */
async function resolveLiveApp(ctx: Context, appRef: string): Promise<TaskApp | null> {
  let id: string;
  try {
    ({ id } = await resolveAppRef(ctx.db, appRef));
  } catch (e) {
    if (e instanceof AppNotFoundError || e instanceof UrnNotQualifiedError) return null;
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
    // older doors). A run, and every write precondition (uninstalled App, impersonation, refused binding), answers as a non-manager does.
    if (!app || app.deletedAt || !actor || isRunPrincipal(ctx)) throw notManager();
    try { requireWritable(ctx, app); } catch (e) { if (e instanceof GraphQLError) throw notManager(); throw e; }
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
        const { changed } = await endGrant(tx, ref, ender, { authorize });
        if (changed) await appendCredentialInstructionEvent(tx, { appId: fresh.id, admission, act: 'grant.revoke' });
        const view = await getGrantForManager(tx, fresh.id, ref, manager);
        if (!view) throw notManager();
        return view;
      }, { ...(actor.kind === 'worker' ? { lockWorkerIds: [actor.workerId] } : {}) });
    } catch (e) {
      if (e instanceof GrantManageRefusal) throw manageRefusal(e.code === 'GRANT_NOT_FOUND' ? new GrantManageRefusal('GRANT_NOT_MANAGER') : e);
      // An App uninstalled between the read and the lock reads as the same refusal (the task door's own code would tell a non-manager).
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
            // A worker requester is matched on its worker id; a person only on a request that no worker made.
            const mine = reader ? row.requestedByWorkerId === reader.workerId : row.requestedByWorkerId === null && row.requestedByUserId === person;
            if (!mine) throw new GrantManageRefusal('GRANT_NOT_REQUESTER');
          };
          await endGrant(tx, ref, ender, { authorize, pendingOnly: true });
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
              await tx.$queryRaw`SELECT 1 FROM workers WHERE id = ${reader.workerId} FOR SHARE`;
              await lockCallerSession(tx, ctx.sessionId);
              const session = ctx.sessionId ? await tx.session.findUnique({ where: { id: ctx.sessionId }, select: { endedAt: true } }) : null;
              if (!session || session.endedAt) throw notFound();
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
