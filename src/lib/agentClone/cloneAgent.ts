/**
 * #2245 (S1) — `cloneAgent`: one new Agent in a target organisation, copied from a source Agent the
 * caller may clone (cor:dmo:050:18, R144-R149, R156, R169-R174, R179, R181). One transaction; any
 * failure leaves nothing behind.
 *
 * Lock order (pinned by `cloneAgentPins.test.ts`; every step releases at commit):
 *   1. authority anchors, exclusive, in one `lockAuthorityAnchors` call: target org, caller, source
 *      Agent, each import Agent, source system memory, the source's owner org/user;
 *   2. `afterAnchors`, advisory only and before ANY row lock: the source system memory's channel-host key
 *      (`lockMemoryForChannelChange`), then the base-graph lock. `setAgentBase` takes the graph lock and then
 *      the child row FOR UPDATE, so a clone holding an Agent row FOR SHARE and waiting for the graph lock
 *      would cycle with it;
 *   3. the anchor rows FOR SHARE (org, user, memory, agent), then in `afterLock` the memory rows sorted by id
 *      (system memory FOR UPDATE, each linked memory FOR SHARE), then the Agent rows (source, imports, base)
 *      FOR SHARE; the pre-read plan is re-checked against those rows;
 *   4. the live context, then the gates re-run on it; then snapshot read, write, subscribe + re-classify,
 *      validation read, audit row.
 * READ COMMITTED, so the snapshot is linearizable rather than MVCC: a fingerprint of everything copied is
 * taken before the write and again after it, and a difference rolls the clone back for a bounded retry. Each
 * fingerprint includes the rows' `xmin`, so a change that is reverted before the second read still differs
 * (a reverted update is a new tuple version); an `xmin` freeze mid-transaction can only cause a spurious retry.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { requireOrgRole, requireReadableAgent, getAccessibleMemoryIds, type Context, AGENT_INCLUDE } from '../../api/graphql/schema/resolvers.helpers.js';
import { withAuthorizedTx } from '../../api/graphql/schema/authorizedTx.js';
import { AgentUrnTakenError } from '../../api/graphql/schema/resolvers.mutation.agent.js';
import { cloneMemoryGraphInTx } from '../../controller/operations/cloneMemory.js';
import { ensureAgentOrgGrant } from '../../controller/operations/ensureAgentOrgGrant.js';
import { subscribeOrgToPublicAgentInTx } from '../../controller/operations/subscribeOrgToPublicAgent.js';
import { backfillMemoryEmbeddings } from '../../services/embedding/enqueue.js';
import { writeAgentBase, lockAgentBaseGraph } from '../agentBase.js';
import { type AuthorityAnchor } from '../auth/authorityAnchors.js';
import { classifyOrgAgentLicense } from '../auth/orgAgentInstallLicense.js';
import { lockMemoryForChannelChange } from '../channels.js';
import { resolveAgentRef } from '../entityRef/agentRef.js';
import { AgentNotFoundError } from '../entityRef/errors.js';
import { resolveOrgRef } from '../entityRef/orgRef.js';
import { resolveUserRef } from '../entityRef/userRef.js';
import { generateId } from '../id.js';
import { jsonOrDbNull } from '../nodeRevisionSnapshot.js';
import { reclaimTombstonedMemory } from '../mintedSpecPermanence.js';
import { deriveSlugFromName } from '../urn.js';
import { CLONE_BLOCKER_CODES, CLONE_SOURCE_CHANGED, cloneBlockers } from './blockers.js';

/** Whole-transaction attempts before a changing source is refused as {@link CLONE_SOURCE_CHANGED}. */
export const CLONE_MAX_ATTEMPTS = 3;

/** Thrown inside the transaction to roll it back and start over on a fresh plan. */
class CloneRetry extends Error {}

/**
 * The one place a clone target ref is read (R179): an organisation today. A user ref is a known
 * future target, so it is refused typed rather than as "not found"; the audit table already carries
 * the nullable `target_user_id` for it.
 */
export async function resolveCloneTarget(ctx: Context, ref: string): Promise<{ orgId: string; urn: string }> {
  try {
    const { id } = await resolveOrgRef(ctx.db, ref);
    const org = await ctx.db.organization.findUniqueOrThrow({ where: { id }, select: { urn: true } });
    return { orgId: id, urn: org.urn };
  } catch (orgError) {
    try {
      await resolveUserRef(ctx.db, ref);
    } catch {
      throw orgError;
    }
    throw new GraphQLError('Cloning an Agent into a user is not supported yet; clone into an organization.', {
      extensions: { code: 'CLONE_TARGET_UNSUPPORTED' },
    });
  }
}

type Plan = {
  sourceId: string;
  sourceUrn: string;
  systemMemoryId: string;
  ownerOrgId: string | null;
  ownerUserId: string | null;
  baseId: string | null;
  importIds: string[];
  linkedMemoryIds: string[];
};

/** Read (no lock) what the anchors and locks will be taken on. */
async function readPlan(db: Context['db'], sourceId: string, ref: string): Promise<Plan> {
  const a = await db.agent.findUnique({ where: { id: sourceId } });
  if (!a || a.deletedAt || !a.systemMemoryId) throw new AgentNotFoundError(ref);
  const imports = await db.agentImport.findMany({ where: { parentAgentId: sourceId }, orderBy: { position: 'asc' }, select: { importedAgentId: true } });
  const links = await db.agentMemoryItem.findMany({ where: { agentId: sourceId, deletedAt: null, memory: { deletedAt: null } }, select: { memoryId: true } });
  return {
    sourceId,
    sourceUrn: a.urn,
    systemMemoryId: a.systemMemoryId,
    ownerOrgId: a.organizationId,
    ownerUserId: a.ownerUserId,
    baseId: a.extendsAgentId,
    importIds: imports.map((i) => i.importedAgentId),
    linkedMemoryIds: links.map((l) => l.memoryId),
  };
}

const samePlan = (a: Plan, b: Plan) =>
  a.systemMemoryId === b.systemMemoryId && a.ownerOrgId === b.ownerOrgId && a.ownerUserId === b.ownerUserId &&
  a.baseId === b.baseId && a.sourceUrn === b.sourceUrn &&
  JSON.stringify(a.importIds) === JSON.stringify(b.importIds) &&
  JSON.stringify([...a.linkedMemoryIds].sort()) === JSON.stringify([...b.linkedMemoryIds].sort());

/** Fingerprints of everything the clone copies; compared before and after the write. */
async function fingerprint(tx: Prisma.TransactionClient, plan: Plan) {
  const [row] = await tx.$queryRaw<Array<Record<string, string | null>>>`
    SELECT
      (SELECT md5(coalesce(string_agg(n.id || ':' || hadron_node_revision_state_hash(n) || ':' || n.xmin::text || ':' || n.is_placeholder::text
          || ':' || coalesce(n.content_hash, '') || ':' || coalesce(n.owner_repo, '') || ':' || coalesce(n.tokens::text, ''), ',' ORDER BY n.id), ''))
         FROM nodes n WHERE n.memory_id = ${plan.systemMemoryId} AND n.deleted_at IS NULL) AS nodes,
      (SELECT md5(coalesce(string_agg(jsonb_build_array(e.id, e.source_id, e.target_id, e.loc, e.name, e.description, e.is_runnable,
          e.condition, e.priority, e.data, e.governed_kind, e.xmin::text)::text, ',' ORDER BY e.id), ''))
         FROM edges e WHERE e.memory_id = ${plan.systemMemoryId} AND e.deleted_at IS NULL) AS edges,
      (SELECT md5(coalesce(string_agg(jsonb_build_array(p.id, p.source_id, p.target_id, p.loc, p.name, p.description, p.data, p.xmin::text)::text, ',' ORDER BY p.id), ''))
         FROM pending_edges p JOIN nodes n ON n.id = p.source_id
         WHERE n.memory_id = ${plan.systemMemoryId} AND p.deleted_at IS NULL) AS pending,
      (SELECT md5(jsonb_build_array(a.name, a.description, a.system_prompt, a.type, a.surfaces, a.uses_tasks, a.register_defaults,
          a.installation_policy, a.memory_provisioning, a.persona_role, a.tasks_index_ref, a.processes_index_ref, a.extends_agent_id,
          a.system_memory_id, a.visibility, a.deleted_at, a.urn, a.xmin::text)::text) FROM agents a WHERE a.id = ${plan.sourceId}) AS agent,
      (SELECT md5(coalesce(string_agg(jsonb_build_array(i.imported_agent_id, i.position, i.required, i.xmin::text)::text, ',' ORDER BY i.position), ''))
         FROM agent_imports i WHERE i.parent_agent_id = ${plan.sourceId}) AS imports,
      (SELECT md5(coalesce(string_agg(jsonb_build_array(l.memory_id, l.role, l.xmin::text)::text, ',' ORDER BY l.memory_id), ''))
         FROM agent_memory_items l JOIN memories m ON m.id = l.memory_id
         WHERE l.agent_id = ${plan.sourceId} AND l.deleted_at IS NULL AND m.deleted_at IS NULL) AS links`;
  return row;
}

/** The first blocker as the typed error S1 throws; a retired source is "not found" (R170.4). */
function blockerError(blockers: Awaited<ReturnType<typeof cloneBlockers>>, ref: string): Error {
  const [first] = blockers;
  if (first.code === CLONE_BLOCKER_CODES.AGENT_RETIRED) return new AgentNotFoundError(ref);
  return new GraphQLError(
    first.code === CLONE_BLOCKER_CODES.AGENT_NOT_PUBLIC
      ? 'Only a PUBLIC Agent, or one you manage in the same organization, can be cloned.'
      : 'This Agent cannot be cloned.',
    { extensions: { code: first.code, blockers: blockers.map((b) => ({ code: b.code, count: b.count, subjects: b.subjects })) } },
  );
}

export type CloneAgentInput = { source: string; target: string; name?: string | null; slug?: string | null };

/** Test seam: awaited inside the transaction between the copy and the validation read; production passes none. */
export type CloneAgentHooks = { afterCopy?: (attempt: number) => Promise<void> };

/** The mutation body; see the module doc. Returns the new Agent (a PERSONAL draft, R146). */
export async function cloneAgent(ctx: Context, input: CloneAgentInput, hooks: CloneAgentHooks = {}) {
  const target = await resolveCloneTarget(ctx, input.target);
  // R144: the org gate runs BEFORE the source is resolved, so a non-admin learns nothing about the source.
  await requireOrgRole(ctx, target.orgId, 'ADMIN');
  const { id: sourceId } = await resolveAgentRef(ctx.db, input.source);
  const sourceRow = await ctx.db.agent.findUnique({ where: { id: sourceId } });
  await requireReadableAgent(ctx, sourceRow, input.source);

  for (let attempt = 0; attempt < CLONE_MAX_ATTEMPTS; attempt++) {
    const plan = await readPlan(ctx.db, sourceId, input.source);
    const anchors: AuthorityAnchor[] = [
      { kind: 'org', id: target.orgId },
      { kind: 'agent', id: plan.sourceId },
      ...plan.importIds.map((id) => ({ kind: 'agent' as const, id })),
      { kind: 'memory', id: plan.systemMemoryId },
      ...(plan.ownerOrgId ? [{ kind: 'org' as const, id: plan.ownerOrgId }] : []),
      ...(plan.ownerUserId ? [{ kind: 'user' as const, id: plan.ownerUserId }] : []),
    ];
    try {
      const created = await withAuthorizedTx(
        ctx,
        anchors,
        (txCtx) => authorizeClone(txCtx, target.orgId, input.source, plan),
        (tx, txCtx) => writeClone(ctx, txCtx, tx, target, plan, input, () => hooks.afterCopy?.(attempt)),
        {
          lockMode: 'exclusive',
          timeout: 120_000,
          // Advisory keys first, before ANY row lock (Andi/Dara P2 on #2245): setAgentBase takes the graph lock and
          // then the child row FOR UPDATE, and every channel-host key holder takes the key before a memory row.
          afterAnchors: async (tx) => {
            await lockMemoryForChannelChange(tx, plan.systemMemoryId);
            await lockAgentBaseGraph(tx);
          },
          afterLock: async (tx) => {
            const memoryLocks = [
              { id: plan.systemMemoryId, update: true },
              ...plan.linkedMemoryIds.filter((id) => id !== plan.systemMemoryId).map((id) => ({ id, update: false })),
            ].sort((a, b) => a.id.localeCompare(b.id));
            for (const m of memoryLocks) {
              if (m.update) await tx.$queryRaw`SELECT id FROM memories WHERE id = ${m.id} FOR UPDATE`;
              else await tx.$queryRaw`SELECT id FROM memories WHERE id = ${m.id} FOR SHARE`;
            }
            const agentIds = [...new Set([plan.sourceId, ...plan.importIds, ...(plan.baseId ? [plan.baseId] : [])])].sort();
            for (const id of agentIds) await tx.$queryRaw`SELECT id FROM agents WHERE id = ${id} FOR SHARE`;
            const fresh = await readPlan(tx as unknown as Context['db'], plan.sourceId, input.source);
            if (!samePlan(plan, fresh)) throw new CloneRetry();
          },
        },
      );
      // Post-commit and best-effort, like createAgent: the copied nodes are stamped for the embedding drain.
      if (created.systemMemoryId) {
        await backfillMemoryEmbeddings(ctx.db, created.systemMemoryId).catch((err) => {
          console.warn('[cloneAgent] system memory embedding backfill failed:', err);
        });
      }
      return created;
    } catch (e) {
      if (e instanceof CloneRetry) continue;
      throw mapUrnTaken(e);
    }
  }
  throw new GraphQLError('The source Agent changed while it was being cloned; try again.', {
    extensions: { code: CLONE_SOURCE_CHANGED.graphqlCode, reason: CLONE_SOURCE_CHANGED.reason, retryable: CLONE_SOURCE_CHANGED.retryable },
  });
}

function mapUrnTaken(e: unknown): unknown {
  const meta = e as { code?: string; meta?: { target?: unknown } };
  if (meta?.code === 'P2002' && String(meta.meta?.target ?? '').includes('urn')) {
    return new GraphQLError('An Agent or memory with the derived URN already exists; choose another name or slug.', { extensions: { code: 'AGENT_URN_TAKEN' } });
  }
  return e;
}

/** The gates, re-run on the live transaction context after every wait (R144, R181, R170, R172, R147). */
async function authorizeClone(txCtx: Context, targetOrgId: string, ref: string, plan: Plan): Promise<void> {
  await requireOrgRole(txCtx, targetOrgId, 'ADMIN');
  const source = await txCtx.db.agent.findUnique({ where: { id: plan.sourceId } });
  await requireReadableAgent(txCtx, source, ref);
  const blockers = await cloneBlockers(txCtx.db, plan.sourceId, { kind: 'org', orgId: targetOrgId, ctx: txCtx });
  if (blockers.length) throw blockerError(blockers, ref);
  const memory = await txCtx.db.memory.findUnique({ where: { id: plan.systemMemoryId }, select: { isEncrypted: true, deletedAt: true } });
  if (!memory || memory.deletedAt) throw new AgentNotFoundError(ref);
  if (memory.isEncrypted) {
    throw new GraphQLError('This Agent holds encrypted content and cannot be cloned.', { extensions: { code: 'CLONE_ENCRYPTED_CONTENT' } });
  }
}

async function writeClone(
  ctx: Context,
  txCtx: Context,
  tx: Prisma.TransactionClient,
  target: { orgId: string; urn: string },
  plan: Plan,
  input: CloneAgentInput,
  afterCopy: () => Promise<void> | undefined,
) {
  const actor = ctx.userId ?? ctx.clientId ?? null;
  const source = await tx.agent.findUniqueOrThrow({ where: { id: plan.sourceId } });
  const read1 = await fingerprint(tx, plan);

  // The target's URN is re-read under the org row's FOR SHARE lock: the pre-transaction read may predate a rename.
  const targetUrn = (await tx.organization.findUniqueOrThrow({ where: { id: target.orgId }, select: { urn: true } })).urn;
  const name = (input.name ?? '').trim() || source.name;
  const slug = deriveSlugFromName((input.slug ?? '').trim() || name);
  const urn = `${targetUrn}:${slug}`;
  await claimUrn(tx, urn);

  const memoryCopy = await cloneMemoryGraphInTx(tx, {
    sourceMemoryId: plan.systemMemoryId,
    name: `${name} System`,
    newUrn: `${urn}-system`,
    targetOrganizationId: target.orgId,
    ownerUserId: null,
    groupOwnerUserId: null,
    actorId: actor,
    copierReadableMemoryIds: await getAccessibleMemoryIds(txCtx),
  });

  const remap = (id: string | null) => (id ? memoryCopy.nodeIdMap.get(id) ?? null : null);
  const agent = await tx.agent.create({
    data: {
      id: generateId(),
      organizationId: target.orgId,
      urn,
      name,
      description: source.description,
      systemPrompt: source.systemPrompt,
      systemMemoryId: memoryCopy.memoryId,
      // R146: the Agent-create default, a creator-only draft; never the source's visibility.
      visibility: 'PERSONAL',
      type: source.type,
      surfaces: source.surfaces,
      usesTasks: source.usesTasks,
      registerDefaults: jsonOrDbNull(source.registerDefaults),
      installationPolicy: jsonOrDbNull(source.installationPolicy) as Prisma.InputJsonValue,
      memoryProvisioning: jsonOrDbNull(source.memoryProvisioning) as Prisma.InputJsonValue,
      personaRole: source.personaRole,
      tasksIndexRef: remap(source.tasksIndexRef),
      processesIndexRef: remap(source.processesIndexRef),
      clonedFromAgentRef: source.urn,
      createdBy: actor,
    },
    include: AGENT_INCLUDE,
  });

  // R156: linked memories stay links, copied verbatim; they are not copied as knowledge.
  const links = await tx.agentMemoryItem.findMany({ where: { agentId: plan.sourceId, deletedAt: null, memory: { deletedAt: null } } });
  for (const l of links) {
    await tx.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: l.memoryId, role: l.role, createdBy: actor } });
  }

  const imports = await tx.agentImport.findMany({ where: { parentAgentId: plan.sourceId }, orderBy: { position: 'asc' } });
  for (const imp of imports) {
    await licenseFor(txCtx, tx, target.orgId, imp.importedAgentId, actor, CLONE_BLOCKER_CODES.IMPORT_UNUSABLE);
    await tx.agentImport.create({
      data: {
        parentAgentId: agent.id, importedAgentId: imp.importedAgentId, position: imp.position, required: imp.required,
        agentOrgGrantOrgId: target.orgId, agentOrgGrantAgentId: imp.importedAgentId, createdBy: actor,
      },
    });
  }

  if (source.extendsAgentId) {
    await licenseFor(txCtx, tx, target.orgId, source.extendsAgentId, actor, CLONE_BLOCKER_CODES.BASE_UNUSABLE);
    const base = await tx.agent.findUniqueOrThrow({ where: { id: source.extendsAgentId }, select: { urn: true } });
    await writeAgentBase(tx, { childId: agent.id, childRef: urn, baseId: source.extendsAgentId, baseRef: base.urn, createdBy: actor });
  }

  await afterCopy();
  const read3 = await fingerprint(tx, plan);
  if (JSON.stringify(read1) !== JSON.stringify(read3)) throw new CloneRetry();

  await tx.agentCloneAudit.create({
    data: {
      id: generateId(),
      actorUserId: ctx.userId ?? null,
      sourceAgentId: plan.sourceId,
      newAgentId: agent.id,
      targetOrgId: target.orgId,
      nodeCount: memoryCopy.nodeCount,
      edgeCount: memoryCopy.edgeCount,
      skippedEdgeCount: memoryCopy.skippedEdgeCount,
      importCount: imports.length,
      linkCount: links.length,
    },
  });
  // The base is written after the row, so the caller gets the row as it now stands.
  return tx.agent.findUniqueOrThrow({ where: { id: agent.id }, include: AGENT_INCLUDE });
}

/** A tombstoned Agent or system memory holding the derived URN is reclaimed (as createAgent does); a live one refuses. */
async function claimUrn(tx: Prisma.TransactionClient, urn: string): Promise<void> {
  const existing = await tx.agent.findUnique({ where: { urn } });
  if (existing && !existing.deletedAt) throw new AgentUrnTakenError(urn);
  if (existing) {
    try {
      await tx.agent.delete({ where: { id: existing.id } });
    } catch {
      throw new AgentUrnTakenError(urn, `URN "${urn}" belongs to a deleted agent that still has Worker castings — their history keeps it reserved.`);
    }
  }
  const holder = await tx.memory.findUnique({ where: { urn: `${urn}-system` } });
  if (holder && !(holder.deletedAt && (await reclaimTombstonedMemory(tx, holder.id)))) {
    throw new AgentUrnTakenError(urn, `A memory with URN "${urn}-system" already exists`);
  }
}

/**
 * The authorized subscribe rule (amendment 3): classify, subscribe or provision where the rule allows it,
 * then re-classify and require LICENSED, so a revoke that lands between the two steps fails the clone
 * instead of cloning an unlicensed dependency. Inactive grants are refusals, never re-activated.
 */
async function licenseFor(
  txCtx: Context,
  tx: Prisma.TransactionClient,
  orgId: string,
  agentId: string,
  actor: string | null,
  refusal: typeof CLONE_BLOCKER_CODES.IMPORT_UNUSABLE | typeof CLONE_BLOCKER_CODES.BASE_UNUSABLE,
): Promise<void> {
  const unusable = () => new GraphQLError('A base or import of this Agent cannot be used by the target organization.', { extensions: { code: refusal } });
  const first = await classifyOrgAgentLicense(tx, orgId, agentId);
  if (first === 'SUBSCRIBABLE') await subscribeOrgToPublicAgentInTx(txCtx, tx, orgId, agentId, actor);
  else if (first === 'SAME_ORG_PROVISIONABLE') await ensureAgentOrgGrant(tx, orgId, agentId, { createdBy: actor });
  else if (first !== 'LICENSED') throw unusable();
  if ((await classifyOrgAgentLicense(tx, orgId, agentId)) !== 'LICENSED') throw unusable();
}
