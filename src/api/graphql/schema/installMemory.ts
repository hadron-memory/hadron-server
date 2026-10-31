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
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { NO_INSTALL_AUDIENCE, installMemoryAudience, isInstallMemoryRow } from '../../../lib/auth/installMemory.js';
import { lockAgentDefinitionAuthority } from '../../../lib/auth/managedSystemMemory.js';
import { liveTxContext, withAuthorizedTx } from './authorizedTx.js';
import { isWriteBeyondRead } from '../../../mcp/access-control.js';
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
      isInstallMemory: true,
      userId: null,
      createdBy: txCtx.userId ?? null,
    },
    select: { id: true },
  });
}

/**
 * May the caller WRITE this install memory, decided on the authority as it stands NOW?
 *
 * Every writer re-runs its write gate inside its own transaction, so that is where the
 * fence belongs (Diego P2 on #2064). On a transaction client this takes the anchors the
 * revokers hold exclusively (the App, its Agent, its tenant, the actor) and the rows they
 * change, FOR SHARE, and only then reads the audience with the actor's CURRENT platform
 * roles: a `deleteApp`, uninstall or demotion either committed before (the write is
 * refused) or waits for this write's commit. On the pooled client (a cheap pre-flight)
 * there is nothing to hold, so it just evaluates; the in-transaction recheck decides.
 */
export async function installWriteAllowed(ctx: Context, memory: InstallMemoryRef): Promise<boolean> {
  return (await fencedInstallAudience(ctx, memory)).write;
}

/** The manual-deletion twin (R45, Xan on #2064): same fence, so a demoted or revoked manager cannot delete. */
export async function installDeleteAllowed(ctx: Context, memory: InstallMemoryRef): Promise<boolean> {
  return (await fencedInstallAudience(ctx, memory)).delete;
}

type InstallMemoryRef = { id: string; class: string; appId: string | null; installOfAgentId: string | null; isInstallMemory: boolean; organizationId: string | null; ownerUserId: string | null };

async function fencedInstallAudience(ctx: Context, memory: InstallMemoryRef) {
  const db = ctx.db as unknown as Prisma.TransactionClient & { $transaction?: unknown };
  if (typeof db.$transaction === 'function' || !memory.appId) {
    const audience = await installMemoryAudience(ctx.db as never, ctx, memory);
    // A pooled-client WRITE decision is a cheap pre-flight, honoured only for a door that
    // rechecks inside its own fenced transaction. Any other writer fails closed (Xan on #2064).
    return ctx.installWritePreflight ? audience : { ...audience, write: false };
  }
  const tx = db as Prisma.TransactionClient;
  if (!(await lockInstallAuthority(tx, ctx, memory))) return NO_INSTALL_AUDIENCE;
  const live = await liveTxContext(ctx, tx);
  return installMemoryAudience(tx as never, live, memory);
}

/**
 * Take the authority a write or delete of this install memory depends on: the anchors the
 * revokers hold exclusively (App, Agent, tenant, actor), then the rows they change, FOR SHARE.
 * False when the App is gone. Idempotent within a transaction.
 *
 * ORDER (Diego's delta on #2064): authority BEFORE memory/node/loc rows, the protocol's order
 * (`withAuthorizedTx`), or a writer holding a memory row and waiting for an anchor can cycle with a
 * revoker (account erasure) holding the anchor and waiting for the memory row. So a writer enters
 * this at the TOP of its transaction (`lockInstallAuthorityFirst`), and the in-gate call above is
 * then a no-op re-acquire.
 */
async function lockInstallAuthority(tx: Prisma.TransactionClient, ctx: Context, memory: InstallMemoryRef): Promise<boolean> {
  const app = await tx.app.findUnique({
    where: { id: memory.appId! },
    select: { organizationId: true, ownerUserId: true },
  });
  if (!app) return false;
  await lockAuthorityAnchors(tx, [
    { kind: 'app', id: memory.appId! },
    ...(memory.installOfAgentId ? [{ kind: 'agent' as const, id: memory.installOfAgentId }] : []),
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ...(ctx.userId ? [{ kind: 'user' as const, id: ctx.userId }] : []),
  ], 'shared');
  await tx.$queryRaw`SELECT id FROM apps WHERE id = ${memory.appId} FOR SHARE`;
  if (memory.installOfAgentId) {
    await tx.$queryRaw`SELECT app_id FROM app_agents WHERE app_id = ${memory.appId} AND agent_id = ${memory.installOfAgentId} FOR SHARE`;
  }
  if (ctx.userId && !ctx.impersonation) {
    await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${memory.appId} AND user_id = ${ctx.userId} FOR SHARE`;
    if (app.organizationId) {
      await tx.$queryRaw`SELECT 1 FROM org_members WHERE organization_id = ${app.organizationId} AND user_id = ${ctx.userId} FOR SHARE`;
    }
  }
  return true;
}

/**
 * #2043 (Dara's P2-1 on #2235) — the authority anchors {@link lockInstallAuthority} takes for this
 * memory, for a door whose transaction opens with `withAuthorizedMemoryTx`: passed as its
 * `otherAnchors`, they are acquired in the SAME ordered call as the memory/org anchors, so App and
 * Agent come first (anchor kind order) exactly as the revokers take them, and the in-gate
 * `lockInstallAuthority` is then a no-op re-acquire. For a live Agent's own system memory, the anchors
 * lockAgentDefinitionAuthority takes (#2206 parity). Empty for any other memory. A plain read of the
 * identity, no lock.
 */
export async function memoryAuthorityAnchors(
  db: Pick<PrismaClient, 'memory' | 'app' | 'agent'>,
  ctx: Pick<Context, 'userId'>,
  memoryId: string,
): Promise<AuthorityAnchor[]> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, appId: true, installOfAgentId: true, isInstallMemory: true },
  });
  if (!memory) return [];
  if (!isInstallMemoryRow(memory)) {
    // #2206 parity: a live Agent's own system memory takes the anchors lockAgentDefinitionAuthority takes (the Agent,
    // its tenant, the actor), so an approval's deciding gate is ordered after a transfer or demotion that won.
    if (memory.class !== 'system') return [];
    const agents = await db.agent.findMany({
      where: { systemMemoryId: memoryId, deletedAt: null },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    if (agents.length === 0) return [];
    return [
      ...agents.flatMap((agent) => [
        { kind: 'agent' as const, id: agent.id },
        ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
        ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
      ]),
      ...(ctx.userId ? [{ kind: 'user' as const, id: ctx.userId }] : []),
    ];
  }
  if (!memory.appId) return [];
  const app = await db.app.findUnique({ where: { id: memory.appId }, select: { organizationId: true, ownerUserId: true } });
  if (!app) return [];
  return [
    { kind: 'app', id: memory.appId },
    ...(memory.installOfAgentId ? [{ kind: 'agent' as const, id: memory.installOfAgentId }] : []),
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ...(ctx.userId ? [{ kind: 'user' as const, id: ctx.userId }] : []),
  ];
}

/**
 * #2734: acquire the COMPLETE multi-memory authority set before taking any of
 * its rows. Calling the one-memory helper in source/destination order could
 * invert App/Agent anchors across two install memories. Existing row helpers
 * then re-enter the already-owned anchors before locking audience rows.
 */
export async function lockInstallAuthoritiesFirst(tx: Prisma.TransactionClient, ctx: Context, memoryIds: readonly string[]): Promise<void> {
  const ids = [...new Set(memoryIds)].sort();
  const anchors = (await Promise.all(ids.map(id => memoryAuthorityAnchors(tx as never, ctx, id)))).flat();
  await lockAuthorityAnchors(tx, anchors, 'shared');
  for (const id of ids) await lockInstallAuthorityFirst(tx, ctx, id);
}

/**
 * The first statement of any transaction that will write or delete `memoryId`: if it is an install memory, or (#2206)
 * a live Agent's own system memory, take its authority before any memory, node or loc lock. A plain read of the
 * identity (no lock), so an ordinary memory costs one or two indexed selects.
 */
export async function lockInstallAuthorityFirst(tx: Prisma.TransactionClient, ctx: Context, memoryId: string): Promise<void> {
  const row = await tx.memory.findUnique({
    where: { id: memoryId },
    select: { id: true, class: true, appId: true, installOfAgentId: true, isInstallMemory: true, organizationId: true, ownerUserId: true },
  });
  if (row && isInstallMemoryRow(row) && row.appId) await lockInstallAuthority(tx, ctx, row);
  else if (row?.class === 'system') await lockAgentDefinitionAuthority(tx, ctx.userId ?? null, row.id);
}


/**
 * The RESPONSE of a write is a READ of the node, so it is held to the memory's content read audience wherever a writer
 * may write without reading. A caller who cannot read the content gets the identity and attribution of what they
 * wrote, with every content-bearing field and relation blanked; a reader gets the node unchanged. Not a new grant: it
 * only withholds. Two memories have such writers:
 *  - an App's install memory (#2064 §10, Riana P2-1): a manager may write it without being a participant (record,
 *    write and delete are not content access);
 *  - a user-owned Agent's system memory (#2206 case 2): a platform admin manages the Agent and so writes it
 *    (cor:dmo:050:13), but reads its content only once #1734 builds that read. Judged by the canonical content gate,
 *    so the full projection returns by itself when #1734 widens it.
 */
export async function concealWriteBeyondRead<T extends { memoryId: string }>(ctx: Context, node: T): Promise<T> {
  const memory = await ctx.db.memory.findUnique({
    where: { id: node.memoryId },
    select: { id: true, class: true, appId: true, installOfAgentId: true, isInstallMemory: true, organizationId: true, ownerUserId: true },
  });
  if (!memory) return node;
  if (isInstallMemoryRow(memory)) {
    if ((await installMemoryAudience(ctx.db as never, ctx, memory)).read) return node;
    return concealedInstallNode(node as unknown as Record<string, any>) as unknown as T;
  }
  if (await isWriteBeyondRead(ctx.db, ctx, memory.id)) {
    return concealedInstallNode(node as unknown as Record<string, any>) as unknown as T;
  }
  return node;
}

/** Marks a Node parent whose every content-derived field must read as empty (see {@link withInstallConcealment}). */
export const INSTALL_CONCEALED = '__installConcealed';

/**
 * The ONLY fields of a written node that survive concealment (#2064 §10, Ruth P2): its address and
 * revision counter, which the writer supplied or chose. An ALLOWLIST, so a field the Node type
 * gains later is concealed until someone decides it is not content; the earlier blocklist let a
 * preexisting title (`name`) through on a partial update. `name` is set to the loc, never the title.
 */
const CONCEALED_NODE_KEEPS = ['id', 'memoryId', 'loc', 'nodeType', 'objectType', 'revision', 'revSeq', 'isLink', 'isPlaceholder', 'createdAt', 'updatedAt'] as const;

function concealedInstallNode(node: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { [INSTALL_CONCEALED]: true, tags: [], outgoingEdges: [], incomingEdges: [], embeddingAttempts: 0 };
  for (const key of CONCEALED_NODE_KEEPS) out[key] = node[key];
  out.name = node.loc;
  return out;
}

type ConcealResolver = (parent: any, args?: any, ctx?: any, info?: any) => unknown;

/** Node field → what a concealed install-write node returns, whatever its resolver would load by id. */
const CONCEALED_FIELDS: Record<string, () => unknown> = {
  memory: () => null,
  moveLinkWarnings: () => null,
  authorship: () => null,
  createdByWorker: () => null,
  createdByAgent: () => null,
  updatedByWorker: () => null,
  updatedByAgent: () => null,
  updatedByUser: () => null,
  asComment: () => null,
  asset: () => null,
  inheritedFrom: () => null,
  signingRequests: () => [],
  outgoingEdges: () => [],
  incomingEdges: () => [],
  commentSummary: () => ({ openThreads: 0, resolvedThreads: 0, comments: 0, viewerOpenThreadId: null }),
  approvalStatus: () => ({ state: 'NOT_APPLICABLE', approval: null }),
  mintStatus: () => ({ minted: false, mintedAt: null, mintedBy: null, mintedByInfo: null, revision: null, hash: null }),
  signatureStatus: () => ({ state: null, signatures: [], integrityProblems: 0 }),
  contentValidation: () => ({ state: 'UNVALIDATED', latestReport: null }),
};

/** Fields in {@link CONCEALED_FIELDS}, for the drift pin. */
export const INSTALL_CONCEALED_FIELDS = Object.keys(CONCEALED_FIELDS);

/**
 * Wrap the merged Node resolver map: on a concealed parent, every field whose resolver loads by node
 * id (comments, signatures, approvals, attribution, edges, asset, memory) reads as empty, so the
 * response of an install-memory write by a non-participant carries nothing derived from content.
 */
export function withInstallConcealment<T extends Record<string, any>>(node: T): T {
  const out: Record<string, ConcealResolver> = { ...node };
  for (const [field, empty] of Object.entries(CONCEALED_FIELDS)) {
    const original: ConcealResolver = node[field] ?? ((parent) => parent[field]);
    out[field] = (parent, args, ctx, info) => (parent?.[INSTALL_CONCEALED] ? empty() : original(parent, args, ctx, info));
  }
  return out as T;
}
