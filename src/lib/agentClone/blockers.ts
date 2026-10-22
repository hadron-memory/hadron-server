/**
 * #2245 (S1) / #2246 (S2) — the one predicate behind `cloneAgent`'s refusals and the offer reasons
 * the portal lists: what stops `source` being cloned. Both slices read {@link CLONE_BLOCKER_CODES};
 * S2's enum is asserted equal to it as a set, so neither slice can rename a code alone.
 *
 * Eligibility (R181, amendment 2) lives only here: a non-PUBLIC source passes only for a caller who
 * manages it AND clones into the source's own organisation. The `outsider` audience (S2's field)
 * never gets that exemption. Redaction: a subject is named only when `audience.ctx` may read it;
 * otherwise only its position and the count are given.
 */
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { canReadMemoryRecord, requireAgentAccess, requireReadableAgent } from '../../api/graphql/schema/resolvers.helpers.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { classifyOrgAgentLicense } from '../auth/orgAgentInstallLicense.js';
import { AgentNotFoundError } from '../entityRef/errors.js';

/** Raw blocker -> the public code S1 throws and S2 shows. */
export const CLONE_BLOCKER_CODES = {
  AGENT_NOT_PUBLIC: 'AGENT_NOT_PUBLIC',
  AGENT_RETIRED: 'AGENT_RETIRED',
  LINKED_MEMORY_ENCRYPTED: 'CLONE_LINKED_MEMORY_ENCRYPTED',
  LINKED_MEMORY_UNREADABLE: 'CLONE_LINKED_MEMORY_UNREADABLE',
  BASE_UNUSABLE: 'CLONE_BASE_UNUSABLE',
  IMPORT_UNUSABLE: 'CLONE_IMPORT_UNUSABLE',
} as const;

export type CloneBlockerCode = (typeof CLONE_BLOCKER_CODES)[keyof typeof CLONE_BLOCKER_CODES];

/** A clone whose source changed under it past the retry budget: not a blocker, a retryable conflict. */
export const CLONE_SOURCE_CHANGED = { graphqlCode: 'CONFLICT', reason: 'AGENT_CLONE_SOURCE_CHANGED', retryable: true } as const;

export type CloneAudience =
  | { kind: 'org'; orgId: string; ctx: Context }
  | { kind: 'outsider'; ctx: Context };

export type CloneBlocker = {
  code: CloneBlockerCode;
  /** How many subjects block. */
  count: number;
  /** One per subject, in stable order; `name` only when the reading caller may read the subject. */
  subjects: Array<{ position: number; name?: string }>;
};

type Db = Pick<PrismaClient, 'agent' | 'agentMemoryItem' | 'agentImport' | 'agentOrgGrant'>;

const blocker = (code: CloneBlockerCode, subjects: CloneBlocker['subjects']): CloneBlocker => ({ code, count: subjects.length, subjects });

/** Whether `audience` may use `agentId` as a base or import: the licence classifier, or PUBLIC for an outsider. */
async function usable(db: Db, audience: CloneAudience, agentId: string): Promise<boolean> {
  if (audience.kind === 'org') {
    const license = await classifyOrgAgentLicense(db, audience.orgId, agentId);
    return license === 'LICENSED' || license === 'SAME_ORG_PROVISIONABLE' || license === 'SUBSCRIBABLE';
  }
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { visibility: true, deletedAt: true } });
  return !!agent && !agent.deletedAt && agent.visibility === 'PUBLIC';
}

/** The Agent read gate as a boolean, for naming a subject only to a caller who may read it. */
async function mayReadAgent(ctx: Context, agentId: string): Promise<{ name: string } | null> {
  const agent = await ctx.db.agent.findUnique({ where: { id: agentId } });
  try {
    await requireReadableAgent(ctx, agent, agentId);
  } catch (e) {
    if (e instanceof AgentNotFoundError) return null;
    throw e;
  }
  return { name: agent!.name };
}

/**
 * Everything that stops `sourceAgentId` being cloned for `audience`, in the fixed order
 * not-public, retired, encrypted links, unreadable links, base, imports. Empty = clonable.
 * Reads the source afresh and never trusts a parent row. Throws {@link AgentNotFoundError} for an absent id.
 */
export async function cloneBlockers(db: Db, sourceAgentId: string, audience: CloneAudience): Promise<CloneBlocker[]> {
  const source = await db.agent.findUnique({ where: { id: sourceAgentId } });
  if (!source) throw new AgentNotFoundError(sourceAgentId);
  const out: CloneBlocker[] = [];

  if (source.visibility !== 'PUBLIC') {
    const exempt = audience.kind === 'org' && audience.orgId === source.organizationId && (await manages(audience.ctx, source));
    if (!exempt) out.push(blocker(CLONE_BLOCKER_CODES.AGENT_NOT_PUBLIC, [{ position: 0 }]));
  }
  if (source.deletedAt) {
    out.push(blocker(CLONE_BLOCKER_CODES.AGENT_RETIRED, [{ position: 0 }]));
    return out;
  }

  const links = await db.agentMemoryItem.findMany({
    where: { agentId: sourceAgentId, deletedAt: null, memory: { deletedAt: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { memory: true },
  });
  const encrypted: CloneBlocker['subjects'] = [];
  const unreadable: CloneBlocker['subjects'] = [];
  for (const [position, { memory }] of links.entries()) {
    const readable = await canReadMemoryRecord(audience.ctx, memory);
    const subject = { position, ...(readable ? { name: memory.name } : {}) };
    if (memory.isEncrypted) encrypted.push(subject);
    else if (!readable) unreadable.push(subject);
  }
  if (encrypted.length) out.push(blocker(CLONE_BLOCKER_CODES.LINKED_MEMORY_ENCRYPTED, encrypted));
  if (unreadable.length) out.push(blocker(CLONE_BLOCKER_CODES.LINKED_MEMORY_UNREADABLE, unreadable));

  if (source.extendsAgentId && !(await usable(db, audience, source.extendsAgentId))) {
    const read = await mayReadAgent(audience.ctx, source.extendsAgentId);
    out.push(blocker(CLONE_BLOCKER_CODES.BASE_UNUSABLE, [{ position: 0, ...(read ? { name: read.name } : {}) }]));
  }

  const imports = await db.agentImport.findMany({ where: { parentAgentId: sourceAgentId }, orderBy: { position: 'asc' } });
  const bad: CloneBlocker['subjects'] = [];
  for (const [position, imp] of imports.entries()) {
    if (await usable(db, audience, imp.importedAgentId)) continue;
    const read = await mayReadAgent(audience.ctx, imp.importedAgentId);
    bad.push({ position, ...(read ? { name: read.name } : {}) });
  }
  if (bad.length) out.push(blocker(CLONE_BLOCKER_CODES.IMPORT_UNUSABLE, bad));
  return out;
}

/** The cor:dmo:050:13 manage gate as a boolean. */
async function manages(ctx: Context, agent: { organizationId: string | null; ownerUserId: string | null }): Promise<boolean> {
  try {
    await requireAgentAccess(ctx, agent, 'ADMIN');
    return true;
  } catch (e) {
    if ((e as { extensions?: { code?: string } }).extensions?.code === 'FORBIDDEN') return false;
    throw e;
  }
}
