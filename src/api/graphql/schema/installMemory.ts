/**
 * #2044 (S7), cor:agt:040:06 — the LIFECYCLE of an App's INSTALL MEMORY: lazy
 * creation by the App's first customisation, and the lookup that creates
 * nothing. The AUDIENCE (who reads, writes, deletes) is `lib/auth/installMemory.ts`.
 *
 * "Created on first customisation": the memory does not exist until a manager
 * writes the first node into it. `withInstallMemory` finds-or-creates it in the
 * SAME transaction as that write, under the established authority-anchor
 * protocol (`withAuthorizedTx`): the App, its Agent, its tenant and the caller
 * are held shared, the revokers (deleteApp, uninstall, member removal, role
 * change, URN reclaim) hold the same anchors exclusively, and authority is
 * re-read under them. A first write racing any of those either commits first
 * (the revoker then sees the memory) or waits and is refused: a memory is never
 * created after authority has gone. A refused write leaves no memory behind,
 * because the creation and the write roll back together.
 */
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../../../generated/prisma/index.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { agentSlugFromUrn, normalizeUrnForLookup } from '../../../lib/urn.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { resolveMemoryRoot, sharedMemoryName } from './chat-scope.js';
import { isAppParticipant, memoryWriteForbidden, type Context } from './resolvers.helpers.js';

/** The GraphQL `InstallTargetInput`, and the MCP `install: { app, agent }` after renaming. */
export type InstallTarget = { appRef: string; agentRef: string };

function installError(code: string, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** Resolve a target to ids. A deleted App or Agent is not a target (the lookups exclude them). */
export async function resolveInstallTarget(
  db: Pick<PrismaClient, 'app' | 'agent' | 'urnAlias'>,
  target: InstallTarget,
): Promise<{ appId: string; agentId: string }> {
  const [{ id: appId }, { id: agentId }] = await Promise.all([
    resolveAppRef(db, target.appRef),
    resolveAgentRef(db, target.agentRef),
  ]);
  return { appId, agentId };
}

/**
 * The live install memory of `(App, Agent)`, or null when the App has not
 * customised the Agent. Creates nothing. The caller decides what the row may
 * show (the audience gates).
 */
export async function findInstallMemory(
  db: Pick<PrismaClient, 'memory'>,
  appId: string,
  agentId: string,
) {
  return db.memory.findFirst({
    where: { class: 'system', appId, installOfAgentId: agentId, deletedAt: null },
  });
}

/**
 * Run `work` against the `(App, Agent)` install memory, creating it first if the
 * App has not customised the Agent yet. Only a manager of a LIVE App whose Agent
 * is installed gets here; anyone else is refused before anything is created.
 */
export async function withInstallMemory<T>(
  ctx: Context,
  target: InstallTarget,
  work: (tx: Prisma.TransactionClient, txCtx: Context, memory: { id: string }) => Promise<T>,
  options: { create?: boolean } = {},
): Promise<T> {
  if (!ctx.userId || isRunPrincipal(ctx)) throw memoryWriteForbidden();
  const { appId, agentId } = await resolveInstallTarget(ctx.db, target);
  const app = await ctx.db.app.findUnique({
    where: { id: appId },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app) throw new AppNotFoundError(target.appRef);
  return withAuthorizedTx(
    ctx,
    [
      { kind: 'app', id: app.id },
      { kind: 'agent', id: agentId },
      ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
      ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ],
    async (txCtx) => {
      const current = await txCtx.db.app.findUnique({
        where: { id: app.id },
        select: { id: true, organizationId: true, ownerUserId: true },
      });
      if (!current || current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) {
        throw installError('INSTALL_TARGET_CHANGED', 'The App changed owner while writing; retry.');
      }
      // Someone who cannot see the App learns nothing about it.
      if (!(await isAppParticipant(txCtx, current))) throw new AppNotFoundError(target.appRef);
      if (!(await managesApp(txCtx as never, current))) throw memoryWriteForbidden();
    },
    async (tx, txCtx) => {
      const installed = await tx.appAgent.findUnique({
        where: { appId_agentId: { appId: app.id, agentId } },
        select: { appId: true },
      });
      if (!installed) {
        throw installError('AGENT_NOT_INSTALLED', 'That Agent is not installed in this App, so there is nothing to customise.');
      }
      const memory = options.create === false
        ? await findInstallMemory(tx, app.id, agentId)
        : await ensureInstallMemory(tx, txCtx, app.id, agentId);
      if (!memory) throw installError('INSTALL_MEMORY_NOT_FOUND', 'This App has not customised that Agent yet.');
      return work(tx, txCtx, memory);
    },
    { timeout: 60_000 },
  );
}

/**
 * Find-or-create the `(App, Agent)` install memory INSIDE a transaction whose
 * authority the caller already holds (see {@link withInstallMemory}). The
 * transaction-scoped advisory lock serialises two first writes; the partial
 * unique index is the backstop.
 */
export async function ensureInstallMemory(
  tx: Prisma.TransactionClient,
  txCtx: Context,
  appId: string,
  agentId: string,
): Promise<{ id: string }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`install-memory:${appId}`}), hashtext(${agentId}))`;
  const existing = await findInstallMemory(tx, appId, agentId);
  if (existing) return existing;

  const [app, agent] = await Promise.all([
    tx.app.findUniqueOrThrow({
      where: { id: appId },
      select: { urn: true, name: true, organizationId: true, ownerUserId: true },
    }),
    tx.agent.findUniqueOrThrow({ where: { id: agentId }, select: { urn: true, name: true } }),
  ]);
  const agentSlug = agentSlugFromUrn(agent.urn);
  if (!agentSlug) {
    throw new Error(`ensureInstallMemory: agent urn "${agent.urn}" has no slug segment after the org prefix.`);
  }
  const appSlug = normalizeUrnForLookup(app.urn).split(':').pop() ?? app.urn;
  const root = await resolveMemoryRoot(tx as unknown as PrismaClient, {
    organizationId: app.organizationId, ownerUserId: app.ownerUserId, appUrn: app.urn,
  });
  // The address is minted ONCE; identity is the (appId, installOfAgentId) columns,
  // so a rename of the App or Agent can never orphan the memory (cor:agt:040:06).
  // One attempt: the advisory lock above serialises this pair, and a failed
  // INSERT would abort the surrounding transaction, so there is nothing to retry
  // inside it (a clash on the address with another pairing surfaces as the error).
  const urn = await mintMemoryUrnV2(tx as unknown as PrismaClient, {
    root, desiredSlug: `${appSlug}-install`, authorRoot: agentSlug,
  });
  return tx.memory.create({
    data: {
      organizationId: app.organizationId,
      // Owner XOR (chk_memory_owner_xor): sits in the App's own tenancy.
      ownerUserId: app.organizationId === null ? app.ownerUserId : null,
      urn,
      name: sharedMemoryName(app.name, agent.name, 'install'),
      class: 'system',
      visibility: null,
      appId,
      installOfAgentId: agentId,
      userId: null,
      createdBy: txCtx.userId ?? null,
    },
    select: { id: true },
  });
}
