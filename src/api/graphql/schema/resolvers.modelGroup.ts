// Model groups — #2831 S1 (cor:agt:060:12). The writers and readers of the named model lists a team Agent declares and
// an App may override; the matcher filters are S2 and a worker's current groups S3.
//
// WHO: an Agent's groups are written by whoever manages the Agent (cor:dmo:050:13, the `requireAgentAccess(...,
// 'ADMIN')` door `updateAgent` uses), re-decided inside the deciding transaction under the Agent's authority anchors.
// An App's groups (an override by name, or the App's own) are written by whoever manages the App (cor:dmo:050:12,
// `actorManagesApp`), also decided inside the transaction. An App manager is not thereby an Agent manager.
//
// WHAT A WRITE DOES: it stores one list of patterns under one name for one owner. Nothing is copied at install, and no
// group is ever an authorization input. An App cannot delete an Agent's group: deleting an App's row of that name
// only removes the override, and the Agent's group shows through again.

import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import {
  MODEL_GROUPS_PER_OWNER_MAX,
  effectiveModelGroups,
  normalizeModelGroupName,
  normalizeModelPatterns,
} from '../../../lib/agentTasks/modelGroups.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { type Context, requireAgentAccess, resolveReadableAgentRef } from './resolvers.helpers.js';
import { actorManagesApp, inTaskWriteTx, resolveParticipatedApp, taskError } from './resolvers.agentTask.js';
import { locateTeamAgent } from './resolvers.worker.js';

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);

function cleanName(raw: unknown): string {
  const name = normalizeModelGroupName(raw);
  if (!name) {
    throw badInput('name is a model group name: letters, digits, "." , "_" or "-", up to 64 characters, e.g. large.');
  }
  return name;
}

function cleanPatterns(raw: unknown): string[] {
  const r = normalizeModelPatterns(raw);
  if ('error' in r) throw badInput(r.error);
  return r.patterns;
}

const groupNotFound = (name: string): GraphQLError =>
  taskError('MODEL_GROUP_NOT_FOUND', `No model group named "${name}" is declared here.`, { name });

const limitReached = (): GraphQLError =>
  taskError('MODEL_GROUP_LIMIT_REACHED', `At most ${MODEL_GROUPS_PER_OWNER_MAX} model groups can be declared by one owner.`, {
    limit: MODEL_GROUPS_PER_OWNER_MAX,
  });

const view = (r: { name: string; patterns: string[]; updatedAt: Date | null; createdAt: Date }) => ({
  name: r.name,
  patterns: r.patterns,
  updatedAt: r.updatedAt ?? r.createdAt,
});

/** One writer per owner at a time, so the per-owner cap and the unique name never race. */
async function lockOwnerGroups(tx: Prisma.TransactionClient, ownerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`model-groups:${ownerId}`}, 0))`;
}

type AgentGate = { id: string; organizationId: string | null; ownerUserId: string | null };

/** Run an Agent group write as whoever manages the Agent, decided again inside the transaction under its anchors. */
async function writeAsAgentManager<T>(
  ctx: Context,
  agent: AgentGate,
  write: (tx: Prisma.TransactionClient, txCtx: Context) => Promise<T>,
): Promise<T> {
  return withAuthorizedTx(
    ctx,
    [
      { kind: 'agent', id: agent.id },
      ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
      ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
    ],
    async (txCtx) => {
      const current = await txCtx.db.agent.findUnique({
        where: { id: agent.id },
        select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true },
      });
      if (!current || current.deletedAt) throw new AgentNotFoundError(agent.id);
      if (current.organizationId !== agent.organizationId || current.ownerUserId !== agent.ownerUserId) {
        throw taskError(
          'AGENT_OWNERSHIP_CHANGED',
          'This Agent changed owner while the change was being made; nothing was written. Read it again and retry.',
        );
      }
      await requireAgentAccess(txCtx, current, 'ADMIN');
    },
    async (tx, txCtx) => {
      await lockOwnerGroups(tx, agent.id);
      return write(tx, txCtx);
    },
  );
}

/** The Team Agent of an App, or null when it has none; two candidates stay the typed refusal (never a guess). */
async function teamAgentIdOrNull(ctx: Context, appId: string): Promise<string | null> {
  try {
    return (await locateTeamAgent(ctx, appId, undefined)).id;
  } catch (e) {
    if (e instanceof GraphQLError && e.extensions?.code === 'TEAM_AGENT_NOT_FOUND') return null;
    throw e;
  }
}

export const modelGroupQueries = {
  /** An Agent's own groups. Reading them is managing the Agent: the list is its definition, not the App's view. */
  agentModelGroups: async (_: unknown, { agentRef }: { agentRef: string }, ctx: Context) => {
    const agent = await resolveReadableAgentRef(ctx, agentRef);
    await requireAgentAccess(ctx, agent, 'ADMIN');
    const rows = await ctx.db.modelGroup.findMany({ where: { agentId: agent.id }, orderBy: { name: 'asc' } });
    return rows.map(view);
  },

  /** The groups in force in an App, each with where it comes from. A participant of the App reads them. */
  effectiveModelGroups: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    const { app } = await resolveParticipatedApp(ctx, appRef);
    return effectiveModelGroups(ctx.db, app.id, await teamAgentIdOrNull(ctx, app.id));
  },
};

export const modelGroupMutations = {
  setAgentModelGroup: async (
    _: unknown,
    { agentRef, name, patterns }: { agentRef: string; name: string; patterns: string[] },
    ctx: Context,
  ) => {
    const group = cleanName(name);
    const list = cleanPatterns(patterns);
    const agent = await resolveReadableAgentRef(ctx, agentRef);
    await requireAgentAccess(ctx, agent, 'ADMIN');
    return writeAsAgentManager(ctx, agent, async (tx, txCtx) => {
      const existing = await tx.modelGroup.findUnique({ where: { agentId_name: { agentId: agent.id, name: group } } });
      if (!existing && (await tx.modelGroup.count({ where: { agentId: agent.id } })) >= MODEL_GROUPS_PER_OWNER_MAX) throw limitReached();
      const by = txCtx.userId ?? null;
      const row = existing
        ? await tx.modelGroup.update({ where: { id: existing.id }, data: { patterns: list, updatedBy: by } })
        : await tx.modelGroup.create({ data: { agentId: agent.id, name: group, patterns: list, createdBy: by, updatedBy: by } });
      return view(row);
    });
  },

  deleteAgentModelGroup: async (_: unknown, { agentRef, name }: { agentRef: string; name: string }, ctx: Context) => {
    const group = cleanName(name);
    const agent = await resolveReadableAgentRef(ctx, agentRef);
    await requireAgentAccess(ctx, agent, 'ADMIN');
    return writeAsAgentManager(ctx, agent, async (tx) => {
      const { count } = await tx.modelGroup.deleteMany({ where: { agentId: agent.id, name: group } });
      if (count === 0) throw groupNotFound(group);
      return true;
    });
  },

  /** An App's group of this name: an override of the Agent's (replacing its whole list), or an App-only group. */
  setAppModelGroup: async (
    _: unknown,
    { appRef, name, patterns }: { appRef: string; name: string; patterns: string[] },
    ctx: Context,
  ) => {
    const group = cleanName(name);
    const list = cleanPatterns(patterns);
    const { app, actor } = await resolveParticipatedApp(ctx, appRef);
    return inTaskWriteTx(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.', { appRef }), async (tx, txCtx, freshApp) => {
      if (!(await actorManagesApp(txCtx, freshApp, actor))) {
        throw taskError('APP_MANAGER_REQUIRED', 'Only whoever manages the App declares its model groups.');
      }
      await lockOwnerGroups(tx, freshApp.id);
      const existing = await tx.modelGroup.findUnique({ where: { appId_name: { appId: freshApp.id, name: group } } });
      if (!existing && (await tx.modelGroup.count({ where: { appId: freshApp.id } })) >= MODEL_GROUPS_PER_OWNER_MAX) throw limitReached();
      const by = txCtx.userId ?? null;
      const row = existing
        ? await tx.modelGroup.update({ where: { id: existing.id }, data: { patterns: list, updatedBy: by } })
        : await tx.modelGroup.create({ data: { appId: freshApp.id, name: group, patterns: list, createdBy: by, updatedBy: by } });
      return view(row);
    });
  },

  /** Remove the App's group of this name: an override reverts to the Agent's group; an App-only group goes. */
  deleteAppModelGroup: async (_: unknown, { appRef, name }: { appRef: string; name: string }, ctx: Context) => {
    const group = cleanName(name);
    const { app, actor } = await resolveParticipatedApp(ctx, appRef);
    return inTaskWriteTx(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.', { appRef }), async (tx, txCtx, freshApp) => {
      if (!(await actorManagesApp(txCtx, freshApp, actor))) {
        throw taskError('APP_MANAGER_REQUIRED', 'Only whoever manages the App declares its model groups.');
      }
      await lockOwnerGroups(tx, freshApp.id);
      const { count } = await tx.modelGroup.deleteMany({ where: { appId: freshApp.id, name: group } });
      if (count === 0) throw groupNotFound(group);
      return true;
    });
  },
};
