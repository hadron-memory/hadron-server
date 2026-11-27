// The hosts of a team App — #5259 (V1 of #5209): the platform's own record of each host and its settings
// (hrn:node:hadronmemory.com:specs:cor:agt:070:01, Proposed). The rules shared by these doors are in
// src/lib/hostOperations/teamHosts.ts. GraphQL only: no host surface is an MCP tool.
//
// JOIN and REMOVE issue and revoke a host's key, so they take createAppKey's gate exactly (gate decision Q1;
// hrn:node:hadronmemory.com:specs:cor:agt:070:07, hrn:node:hadronmemory.com:specs:cor:dmo:050:12): whoever manages
// the App, as a person acting as themselves. A worker session in any shape, a run, an impersonation and an App key are
// refused with createAppKey's own `Forbidden`. Both hold the App's authority anchor EXCLUSIVE, as a scope grant does
// (an App key's reads hold it shared), so a key revoked here is refused from its next call.
//
// UPDATE changes settings, not keys: whoever manages the App, as a person or through their held worker on an
// instruction (assignHostWorker's gate), refusing AGENT_TEAM_HOST_NOT_PERMITTED; an App key is refused first.
//
// READS: whoever reads the App's tasks. A HOST KEY reads only its own host's row (cor:agt:070:04): for the one-host read
// another host's id, an unknown one and a revoked grant answer the same HOST_NOT_FOUND, decided before any lookup. Every
// host-key read is a use, recorded apart from the read; a refused one in its own write after the rollback
// (recordingRefusal).
//
// No refusal repeats the caller's App reference or host id (#5168).

import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { recordInstructedManagerAct, taskError, withReadableApp } from './resolvers.agentTask.js';
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import type { ActInstruction } from '../../../lib/auth/instructedAct.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { requirePersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { isAppRefResolutionFailure } from '../../../lib/auth/workerRead.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { appendTeamHostEvent } from '../../../lib/agentTasks/events.js';
import { lockAppLapseCheckIns } from '../../../lib/agentTasks/hosts.js';
import { lockHostSetup } from '../../../lib/hostOperations/assignments.js';
import { HOST_ID_PATTERN } from '../../../lib/hostOperations/types.js';
import { keyEverHeldHostOperate, keyHostId, recordHostKeyUseApart } from '../../../lib/hostOperations/hostKey.js';
import {
  TeamHostArgsError,
  endRemovedHost,
  hostHasOpenSession,
  insertOrLockTeamHost,
  joinIdentity,
  liveHostKeyIds,
  loadLiveTeamHosts,
  lockTeamHost,
  revokeKeys,
  validateSettings,
  type TeamHostRow,
} from '../../../lib/hostOperations/teamHosts.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { createAppKeyRow, lockAppKeyManagerMemberships, newAppKeyMaterial, requireAppKeyIssuer } from './appKeyManagement.js';
import { grantScopeRow, hostNotFound } from './resolvers.appKeyScope.js';
import { asSetupManager } from './resolvers.hostAssignment.js';
import { recordingRefusal } from './resolvers.hostOperation.js';

const appNotFound = () => taskError('APP_NOT_FOUND', 'App not found.');
const badArgs = (message: string) => taskError('BAD_AGENT_TEAM_HOST_ARGS', message);
const exists = () =>
  taskError('AGENT_TEAM_HOST_EXISTS', 'This host is already joined to the App and holds a live key. Pass replace to issue a new key, which revokes the old one.');
const notPermitted = () => taskError('AGENT_TEAM_HOST_NOT_PERMITTED', "Only whoever manages the App changes its hosts' settings.");
const openSessions = () =>
  taskError('AGENT_TEAM_HOST_HAS_OPEN_SESSIONS', 'A worker of this host has an open session. End it first, or pass force to remove the host anyway.');

/** The caller's own argument, typed; never a value of theirs in the message. */
function args<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TeamHostArgsError) throw badArgs(e.message);
    throw e;
  }
}

function hostIdArg(raw: unknown): string {
  const hostId = typeof raw === 'string' ? raw.trim() : '';
  if (!HOST_ID_PATTERN.test(hostId)) throw badArgs('hostId is a host token: letters, digits, ".", "_", ":" or "-", up to 128 characters.');
  return hostId;
}

type KeyApp = { id: string; organizationId: string | null; ownerUserId: string | null };

/** The App a join or remove names. An unknown reference answers APP_NOT_FOUND without repeating it. */
async function loadKeyApp(ctx: Context, appRef: string): Promise<KeyApp> {
  let appId: string;
  try {
    ({ id: appId } = await resolveAppRef(ctx.db, appRef));
  } catch (e) {
    if (isAppRefResolutionFailure(e)) throw appNotFound();
    throw e;
  }
  const app = await ctx.db.app.findUnique({ where: { id: appId }, select: { id: true, organizationId: true, ownerUserId: true } });
  if (!app) throw appNotFound();
  return app;
}

/**
 * The person-only manager write a join and a removal share: createAppKey's gate before the transaction and again inside
 * it, under the App's anchors EXCLUSIVE and the caller's deciding memberships (createAppKey's `afterLock`), then `write`.
 */
async function asKeyIssuer<T>(
  ctx: Context, appRef: string, act: 'app-key.mint' | 'agent-team-host.remove',
  write: (tx: Prisma.TransactionClient, app: KeyApp, userId: string) => Promise<T>,
): Promise<T> {
  const app = await loadKeyApp(ctx, appRef);
  await requireAppKeyIssuer(ctx, app, act);
  return withAuthorizedTx(
    ctx,
    [{ kind: 'app', id: app.id }, ...(app.organizationId
      ? [{ kind: 'org' as const, id: app.organizationId }]
      : [{ kind: 'user' as const, id: app.ownerUserId! }])],
    async (txCtx) => {
      const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: app.id } });
      if (current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) {
        throw new Error('App ownership changed; retry');
      }
      await requireAppKeyIssuer(txCtx, current, act);
      // Joining grants scopes: giving a grant is person-only too (cor:dmo:050:12, ruling 0099 A). Same predicate, same refusal.
      if (act === 'app-key.mint') await requirePersonOnlyAct(txCtx, 'grant.give', authorizationDenied);
    },
    (tx) => write(tx, app, ctx.userId!),
    { lockMode: 'exclusive', afterLock: async (tx) => { await lockAppKeyManagerMemberships(tx, ctx, app); } },
  );
}

type JoinInput = { appRef: string; hostId?: string | null; label?: string | null; replace?: boolean | null };
type UpdateInput = { appRef: string; hostId: string; label?: string | null; pollIntervalSeconds?: number | null; deliveryEnabled?: boolean | null };
type RemoveInput = { appRef: string; hostId: string; force?: boolean | null };

export const agentTeamHostMutations = {
  /**
   * #5259 — make a machine a host of the App: its record (created, or revived when removed: gate decision Q6), a new
   * App key, and that key's `host:operate` for this host and `attention:deliver`. The raw key is in the answer once and
   * nowhere else. A live host, or a live key operating as this host without a record (builder's note N2), answers
   * AGENT_TEAM_HOST_EXISTS unless `replace`, which revokes every live key of this host before the new one is issued.
   */
  joinAgentTeamHost: async (_: unknown, { input }: { input: JoinInput }, ctx: Context) => {
    if (!input) throw badArgs('input is required.');
    const id = args(() => joinIdentity(input));
    const material = newAppKeyMaterial();
    const host = await asKeyIssuer(ctx, input.appRef, 'app-key.mint', async (tx, app, userId) => {
      const now = new Date();
      // The host-setup lock, as every writer of a host's record and of its assignments takes it.
      await lockHostSetup(tx, app.id, 'exclusive');
      const { row, created } = await insertOrLockTeamHost(tx, { appId: app.id, hostId: id.hostId, label: id.label, createdByUserId: userId, now });
      if (!created && row.removedAt === null && !input.replace) throw exists();
      const live = await liveHostKeyIds(tx, app.id, id.hostId);
      if (live.length > 0 && !input.replace) throw exists();
      await revokeKeys(tx, live, now);
      let joined: TeamHostRow = row;
      if (!created && row.removedAt !== null) {
        joined = await tx.agentTeamHost.update({
          where: { id: row.id },
          data: { label: id.label, pollIntervalSeconds: null, deliveryEnabled: null, createdByUserId: userId, removedAt: null, removedByUserId: null, updatedAt: now },
        });
      } else if (!created && id.labelGiven && id.label !== row.label) {
        joined = await tx.agentTeamHost.update({ where: { id: row.id }, data: { label: id.label, updatedAt: now } });
      }
      const key = await createAppKeyRow(tx, { appId: app.id, label: `host ${id.hostId}`, createdBy: userId, material });
      await grantScopeRow(tx, { keyId: key.id, scope: 'host:operate', userId, hostId: id.hostId });
      await grantScopeRow(tx, { keyId: key.id, scope: 'attention:deliver', userId, hostId: null });
      await appendTeamHostEvent(tx, { appId: app.id, type: 'host.joined', hostId: id.hostId, actorUserId: userId, replaced: live.length > 0, createdAt: now });
      return joined;
    });
    return { host, rawKey: material.rawKey };
  },

  /**
   * #5259 — change a host's settings: omitted keeps, null clears to the product default (the label is never cleared).
   * Stored only: the server consumes none of them (the host reads its own record and applies them; liveness follows the
   * interval registerHost declares). Refusals, in order: AGENT_TEAM_HOST_NOT_PERMITTED (an App key),
   * BAD_AGENT_TEAM_HOST_ARGS, APP_NOT_FOUND, AGENT_TEAM_HOST_NOT_PERMITTED (not a manager), HOST_NOT_FOUND.
   */
  updateAgentTeamHost: async (_: unknown, { input, instruction }: { input: UpdateInput; instruction?: ActInstruction | null }, ctx: Context) => {
    if (appKeyCaller(ctx)) throw notPermitted();
    if (!input) throw badArgs('input is required.');
    const hostId = hostIdArg(input.hostId);
    const settings = args(() => validateSettings(input));
    const { result } = await asSetupManager(ctx, input.appRef, instruction, async (tx, _txCtx, freshApp, actor) => {
      await lockHostSetup(tx, freshApp.id, 'exclusive');
      const row = await lockTeamHost(tx, freshApp.id, hostId);
      if (!row || row.removedAt !== null) throw hostNotFound();
      const now = new Date();
      const updated = await tx.agentTeamHost.update({ where: { id: row.id }, data: { ...settings, updatedAt: now } });
      await recordInstructedManagerAct(tx, freshApp.id, actor, 'agent-team-host.update');
      await appendTeamHostEvent(tx, {
        appId: freshApp.id, type: 'host.updated', hostId, actorUserId: ctx.userId ?? null,
        actorWorkerId: actor.kind === 'worker' ? actor.workerId : null, createdAt: now,
      });
      return updated;
    }, 'shared', notPermitted);
    return result;
  },

  /**
   * #5259 — remove a host from the App, in one transaction: refused while a worker of the host has an open session
   * (gate decision Q4) unless `force`; ends its registration (`host.lost`), fails its issued and collected operations
   * (HOST_REMOVED), revokes its keys, removes its assignments, stamps the record. A removed or unknown host:
   * HOST_NOT_FOUND. True when removed.
   */
  removeAgentTeamHost: async (_: unknown, { input }: { input: RemoveInput }, ctx: Context) => {
    if (!input) throw badArgs('input is required.');
    const hostId = hostIdArg(input.hostId);
    return asKeyIssuer(ctx, input.appRef, 'agent-team-host.remove', async (tx, app, userId) => {
      const now = new Date();
      // The lapse count first (fenceHostDecision's order: lapse, then host setup, then the registrations).
      const checkIns = await lockAppLapseCheckIns(tx, app.id);
      await lockHostSetup(tx, app.id, 'exclusive');
      const row = await lockTeamHost(tx, app.id, hostId);
      if (!row || row.removedAt !== null) throw hostNotFound();
      // Every registration of the App, in id order, before the open-session read (sessionRunsOn's requirement).
      await tx.$queryRaw`SELECT id FROM host_registrations WHERE app_id = ${app.id} ORDER BY id FOR SHARE`;
      if (!input.force && (await hostHasOpenSession(tx, { appId: app.id, hostId, now, checkIns }))) throw openSessions();
      await endRemovedHost(tx, { appId: app.id, hostId, now });
      await tx.agentTeamHost.update({ where: { id: row.id }, data: { removedAt: now, removedByUserId: userId, updatedAt: now } });
      await appendTeamHostEvent(tx, { appId: app.id, type: 'host.removed', hostId, actorUserId: userId, createdAt: now });
      return true;
    });
  },
};

export const agentTeamHostQueries = {
  /** #5259 — the App's live hosts. A host key reads only its own (a revoked grant: FORBIDDEN, as hostSetup answers). */
  agentTeamHosts: (_: unknown, a: { appRef: string }, ctx: Context) =>
    recordingRefusal(ctx, 'read', null, async () => {
      const rows = await withReadableApp(ctx, a.appRef, async (c, app) => {
        const key = appKeyCaller(c);
        if (key && (await keyEverHeldHostOperate(c.db, key.appKeyId))) {
          const own = await keyHostId(c.db, key);
          if (!own) throw taskError('FORBIDDEN', "A host key reads only its own host's record.");
          return loadLiveTeamHosts(c.db, app.id, own);
        }
        return loadLiveTeamHosts(c.db, app.id);
      });
      const key = appKeyCaller(ctx);
      if (key) await recordHostKeyUseApart(ctx.db, key, 'read', { count: rows.length });
      return rows;
    }),

  /**
   * #5259 — one live host. For a host key the grant is decided before any lookup, so another host, an unknown one and
   * a revoked grant answer the same HOST_NOT_FOUND (hrn:node:hadronmemory.com:specs:cor:agt:070:04).
   */
  agentTeamHost: (_: unknown, a: { appRef: string; hostId: string }, ctx: Context) =>
    recordingRefusal(ctx, 'read', null, async () => {
      const hostId = typeof a.hostId === 'string' ? a.hostId.trim() : '';
      const row = await withReadableApp(ctx, a.appRef, async (c, app) => {
        const key = appKeyCaller(c);
        if (key && (await keyEverHeldHostOperate(c.db, key.appKeyId)) && (await keyHostId(c.db, key)) !== hostId) throw hostNotFound();
        if (!HOST_ID_PATTERN.test(hostId)) throw hostNotFound();
        const [found] = await loadLiveTeamHosts(c.db, app.id, hostId);
        if (!found) throw hostNotFound();
        return found;
      });
      const key = appKeyCaller(ctx);
      if (key) await recordHostKeyUseApart(ctx.db, key, 'read', { count: 1 });
      return row;
    }),
};
