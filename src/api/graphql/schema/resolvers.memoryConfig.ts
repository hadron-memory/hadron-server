/**
 * #1325 part (b) — the MemoryConfig / NodeRoleRule API.
 *
 * A memory has exactly one config (#1325 H4): its role rules, one row per role
 * or declared sub-role (H1). This module is the management surface the CLI
 * (hadron-cli#716) and the portal consume. Templates are part (c); applying one
 * is #1334; enforcement on node writes is #1328/#1330/#1331 and reads the
 * tables directly, not through here.
 *
 * ## Who may see and change a config: the MANAGE gate
 *
 * Holger's H3/H4 (#1325, 2026-09-25): a config is read and changed only by the
 * people who manage the memory —
 *   - personal/private: the STRICT owner (`Memory.userId`) only, as for
 *     `deleteMemory`/`encryptMemory`. NOT the org admins `updateMemory` admits;
 *   - everything else: `requireOwnerOrOrgRole(…, 'ADMIN')`, `updateMemory`'s gate
 *     (a user-owned memory's owner, else an org ADMIN/OWNER or platform admin).
 * "Whoever can read the memory" is deliberately NOT the read rule (H4): a writer
 * who cannot see the rules is served by the actionable refusal on write (#1329).
 *
 * Everyone else gets the answer a MISSING memory gets — `memoryConfig` throws the
 * same `MEMORY_NOT_FOUND` `resolveMemoryRef` would, `Memory.config` is null, and a
 * rule mutation's not-found is the same as for a rule that does not exist — so the
 * API is never an existence oracle for memories or rules the caller cannot manage.
 *
 * ## Lazy materialization
 *
 * The config ROW is created by the first rule write, in that write's
 * transaction (`ON CONFLICT DO NOTHING`, so two first writes cannot race into
 * two rows or abort each other). Until then every read synthesizes the empty
 * config (`id: null`, no rules) — which is exactly what an absent row means, so
 * no creation site and no backfill is involved (#1325 design §3).
 *
 * ## Task and description references
 *
 * Accepted as a node ref (id or URN), stored as the node id (so they survive
 * `moveNode`, even across memories), and returned as a URN. The SAVER must be
 * able to read the referenced node's memory (the node-content gate); an
 * unreadable node answers exactly like a missing one (`NODE_NOT_FOUND`, the
 * #1319 concealment rule), and only then is runnability checked, so a rule
 * mutation cannot probe other tenants' nodes. On read each reference carries a
 * state (cli#716 Q1–Q9): NONE (not configured), OK (URN given), BROKEN (was
 * configured, the node is gone — `*Required` holds after the FK's SET NULL, or
 * the node is soft-deleted; H5 fail-closed), UNREADABLE (exists, not yours to
 * read; URN withheld).
 */
import { GraphQLError } from 'graphql';
import { Prisma, type NodeRoleRule, type PrismaClient } from '../../../generated/prisma/index.js';
import { type Context, isMemoryReadableCached, requireOwnerOrOrgRole } from './resolvers.helpers.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { EntityNotFoundError, MemoryNotFoundError, NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { assertValidRuleRole } from '../../../lib/governedRole.js';
import { nodeUrnRoundTrips, safeNodeUrnV2 } from '../../../lib/urnEmit.js';
import { generateId } from '../../../lib/id.js';

type Writers = 'ALL' | 'OWNER' | 'ADMIN';
type Validator = 'AGENT' | 'PLATFORM';
type RefState = 'NONE' | 'OK' | 'BROKEN' | 'UNREADABLE';

export interface CreateNodeRoleRuleInput {
  role: string;
  authorTaskRef?: string | null;
  validationTaskRef?: string | null;
  descriptionNodeRef?: string | null;
  strictSubRoles?: boolean | null;
  writers?: Writers | null;
  validateBy?: Validator | null;
  enabled?: boolean | null;
}

/** Omitted = unchanged. A ref given as null or "" CLEARS it; `validateBy: null` clears it. */
export type UpdateNodeRoleRuleInput = Omit<CreateNodeRoleRuleInput, 'role'>;

/** A rule that does not exist, or that the caller may not manage — one answer for both. */
export class NodeRoleRuleNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('NOT_FOUND', ref);
    this.name = 'NodeRoleRuleNotFoundError';
  }
}

type MemoryGateRow = {
  id: string;
  class: string;
  userId: string | null;
  organizationId: string | null;
  ownerUserId: string | null;
};

/** The MANAGE gate (H3/H4). Boolean, so every caller can conceal a refusal as not-found. */
async function canManageMemoryConfig(ctx: Context, memory: MemoryGateRow): Promise<boolean> {
  if (memory.class === 'personal' || memory.class === 'private') {
    // Strict owner. Impersonation is a read-only support view (#876) and never
    // speaks for the owner of a personal memory.
    return !ctx.impersonation && !!ctx.userId && memory.userId === ctx.userId;
  }
  try {
    await requireOwnerOrOrgRole(ctx, memory, 'ADMIN');
    return true;
  } catch {
    return false;
  }
}

const MEMORY_GATE_SELECT = { id: true, class: true, userId: true, organizationId: true, ownerUserId: true } as const;

/** Resolve a memory ref the caller may MANAGE, or throw the missing-memory answer. */
async function managedMemory(ctx: Context, memoryRef: string): Promise<MemoryGateRow> {
  const { id } = await resolveMemoryRef(ctx.db, memoryRef);
  const memory = await ctx.db.memory.findFirst({ where: { id, deletedAt: null }, select: MEMORY_GATE_SELECT });
  if (!memory || !(await canManageMemoryConfig(ctx, memory))) throw new MemoryNotFoundError(memoryRef);
  return memory;
}

/** Resolve a rule ref (its id) the caller may MANAGE, or throw the missing-rule answer. */
async function managedRule(ctx: Context, ref: string): Promise<NodeRoleRule> {
  const rule = await ctx.db.nodeRoleRule.findUnique({
    where: { id: ref },
    include: { config: { select: { memory: { select: { ...MEMORY_GATE_SELECT, deletedAt: true } } } } },
  });
  const memory = rule?.config.memory;
  if (!rule || !memory || memory.deletedAt || !(await canManageMemoryConfig(ctx, memory))) {
    throw new NodeRoleRuleNotFoundError(ref);
  }
  const { config: _config, ...row } = rule;
  return row;
}

/** Mutations stamp the actor; impersonation is read-only (#876). */
function requireWriter(ctx: Context): string {
  if (ctx.impersonation) throw new Error('Forbidden');
  if (!ctx.userId) throw new Error('Unauthenticated');
  return ctx.userId;
}

type RefKind = 'authorTask' | 'validationTask' | 'descriptionNode';

/**
 * Resolve an inbound reference for a rule write. Order matters: existence and
 * READABILITY are one indistinguishable answer, and runnability is judged only
 * after, so NOT_A_TASK can never reveal that an unreadable node exists.
 */
async function resolveRuleRef(ctx: Context, kind: RefKind, ref: string): Promise<string> {
  let id: string;
  try {
    ({ id } = await resolveNodeRef(ctx.db, ref));
  } catch (e) {
    if (e instanceof EntityNotFoundError) throw new NodeNotFoundError(ref);
    throw e;
  }
  const node = await ctx.db.node.findUnique({ where: { id }, select: { memoryId: true, isRunnable: true } });
  if (!node || !(await isMemoryReadableCached(ctx, node.memoryId))) throw new NodeNotFoundError(ref);
  if (kind !== 'descriptionNode' && node.isRunnable !== true) {
    throw new GraphQLError(`The ${kind === 'authorTask' ? 'author' : 'validation'} task must be a runnable task node.`, {
      extensions: { code: 'NOT_A_TASK', field: kind },
    });
  }
  return id;
}

const REF_COLUMNS: Record<RefKind, { id: 'authorTaskId' | 'validationTaskId' | 'descriptionNodeId'; required?: 'authorTaskRequired' | 'validationTaskRequired' }> = {
  authorTask: { id: 'authorTaskId', required: 'authorTaskRequired' },
  validationTask: { id: 'validationTaskId', required: 'validationTaskRequired' },
  descriptionNode: { id: 'descriptionNodeId' },
};

/**
 * The column writes for the references present in `input`. A given ref sets
 * the id and, for a task, its fail-closed `*Required` marker (H5); a null/""
 * ref is an explicit clear and drops both. An omitted ref yields nothing.
 */
async function refWrites(
  ctx: Context,
  input: UpdateNodeRoleRuleInput,
): Promise<Partial<Record<string, string | boolean | null>>> {
  const out: Partial<Record<string, string | boolean | null>> = {};
  for (const kind of Object.keys(REF_COLUMNS) as RefKind[]) {
    const key = `${kind}Ref` as const;
    if (!(key in input) || input[key] === undefined) continue;
    const raw = input[key];
    const cols = REF_COLUMNS[kind];
    if (raw === null || raw.trim() === '') {
      out[cols.id] = null;
      if (cols.required) out[cols.required] = false;
    } else {
      out[cols.id] = await resolveRuleRef(ctx, kind, raw.trim());
      if (cols.required) out[cols.required] = true;
    }
  }
  return out;
}

/**
 * "`validateBy` needs a validation task" (#1325 design §2): judged on the
 * RESULTING state, and on a CONFIGURED task rather than a live one — a
 * validation task deleted since (BROKEN, `validationTaskRequired` still set)
 * must not block an unrelated edit to the rule; #1328 refuses writes of that
 * role until a manager repoints it.
 */
function assertValidateByHasTask(state: { validateBy: Validator | null; validationTaskId: string | null; validationTaskRequired: boolean }): void {
  if (state.validateBy != null && state.validationTaskId == null && !state.validationTaskRequired) {
    throw new GraphQLError('`validateBy` needs a validation task: set `validationTaskRef`, or clear `validateBy`.', {
      extensions: { code: 'BAD_USER_INPUT', field: 'validateBy', reason: 'VALIDATION_TASK_REQUIRED' },
    });
  }
}

/** Create the config row if absent — race-safe, never a second row, never an aborted transaction. */
async function materializeConfig(tx: Prisma.TransactionClient, memoryId: string, actor: string): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO "memory_configs" ("id", "memory_id", "created_by", "updated_by")
    VALUES (${generateId()}, ${memoryId}, ${actor}, ${actor})
    ON CONFLICT ("memory_id") DO NOTHING`;
  const row = await tx.memoryConfig.findUniqueOrThrow({ where: { memoryId }, select: { id: true } });
  return row.id;
}

function translateRoleTaken(e: unknown, role: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new GraphQLError(`This memory's config already has a rule for role "${role}"; update it instead.`, {
      extensions: { code: 'NODE_ROLE_RULE_EXISTS', role },
    });
  }
  throw e;
}

/** The synthesized config for a memory with no row yet (#1325 design §3). */
function emptyConfig(memoryId: string) {
  return { id: null, memoryId, createdAt: null, updatedAt: null, createdBy: null, updatedBy: null };
}

async function configForManagedMemory(db: PrismaClient, memoryId: string) {
  return (await db.memoryConfig.findUnique({ where: { memoryId } })) ?? emptyConfig(memoryId);
}

/**
 * `refView`, memoized per rule object and reference within one request, so a
 * selection of both `authorTask` and `authorTaskState` costs one lookup.
 */
const refViewCache = new WeakMap<object, Map<string, Promise<{ urn: string | null; state: RefState }>>>();
function refViewOnce(
  ctx: Context,
  rule: NodeRoleRule,
  kind: RefKind,
): Promise<{ urn: string | null; state: RefState }> {
  let perRule = refViewCache.get(rule);
  if (!perRule) refViewCache.set(rule, (perRule = new Map()));
  let pending = perRule.get(kind);
  if (!pending) {
    const cols = REF_COLUMNS[kind];
    pending = refView(ctx, rule[cols.id], cols.required ? rule[cols.required] : false);
    perRule.set(kind, pending);
  }
  return pending;
}

/** One reference's read projection: `{ urn, state }`, the URN only when OK. */
async function refView(
  ctx: Context,
  id: string | null,
  required: boolean,
): Promise<{ urn: string | null; state: RefState }> {
  if (id == null) return { urn: null, state: required ? 'BROKEN' : 'NONE' };
  const node = await ctx.db.node.findUnique({
    where: { id },
    select: { loc: true, memoryId: true, deletedAt: true, memory: { select: { urn: true, deletedAt: true } } },
  });
  if (!node || node.deletedAt || node.memory.deletedAt) return { urn: null, state: 'BROKEN' };
  if (!(await isMemoryReadableCached(ctx, node.memoryId))) return { urn: null, state: 'UNREADABLE' };
  const urn = nodeUrnRoundTrips(node.memory.urn, node.loc) ? safeNodeUrnV2(node.memory.urn, node.loc) : null;
  return { urn, state: 'OK' };
}

export const memoryConfigQueries = {
  memoryConfig: async (_: unknown, { memoryRef }: { memoryRef: string }, ctx: Context) => {
    const memory = await managedMemory(ctx, memoryRef);
    return configForManagedMemory(ctx.db, memory.id);
  },
};

export const memoryConfigMutations = {
  createNodeRoleRule: async (
    _: unknown,
    { memoryRef, input }: { memoryRef: string; input: CreateNodeRoleRuleInput },
    ctx: Context,
  ) => {
    const actor = requireWriter(ctx);
    const memory = await managedMemory(ctx, memoryRef);
    const role = input.role;
    assertValidRuleRole(role);
    const refs = await refWrites(ctx, input);
    const state = {
      validateBy: input.validateBy ?? null,
      validationTaskId: (refs.validationTaskId as string | null | undefined) ?? null,
      validationTaskRequired: (refs.validationTaskRequired as boolean | undefined) ?? false,
    };
    assertValidateByHasTask(state);
    try {
      const rule = await ctx.db.$transaction(async (tx) => {
        const configId = await materializeConfig(tx, memory.id, actor);
        return tx.nodeRoleRule.create({
          data: {
            id: generateId(),
            configId,
            role,
            ...refs,
            ...(input.strictSubRoles != null ? { strictSubRoles: input.strictSubRoles } : {}),
            ...(input.writers != null ? { writers: input.writers } : {}),
            validateBy: state.validateBy,
            ...(input.enabled != null ? { enabled: input.enabled } : {}),
            createdBy: actor,
            updatedBy: actor,
          },
        });
      });
      return { rule, warnings: [] };
    } catch (e) {
      translateRoleTaken(e, role);
    }
  },

  updateNodeRoleRule: async (
    _: unknown,
    { ref, input, expectedRevision }: { ref: string; input: UpdateNodeRoleRuleInput; expectedRevision?: number | null },
    ctx: Context,
  ) => {
    const actor = requireWriter(ctx);
    const current = await managedRule(ctx, ref);
    const refs = await refWrites(ctx, input);
    const data: Prisma.NodeRoleRuleUncheckedUpdateManyInput = {
      ...refs,
      ...(input.strictSubRoles != null ? { strictSubRoles: input.strictSubRoles } : {}),
      ...(input.writers != null ? { writers: input.writers } : {}),
      ...('validateBy' in input && input.validateBy !== undefined ? { validateBy: input.validateBy } : {}),
      ...(input.enabled != null ? { enabled: input.enabled } : {}),
      updatedBy: actor,
      revision: { increment: 1 },
    };
    assertValidateByHasTask({
      validateBy: ('validateBy' in data ? data.validateBy : current.validateBy) as Validator | null,
      validationTaskId: ('validationTaskId' in refs ? refs.validationTaskId : current.validationTaskId) as string | null,
      validationTaskRequired: ('validationTaskRequired' in refs
        ? refs.validationTaskRequired
        : current.validationTaskRequired) as boolean,
    });
    // The revision check and the write are ONE statement, so a concurrent
    // update cannot slip between them (cli#716 Q1).
    const { count } = await ctx.db.nodeRoleRule.updateMany({
      where: { id: current.id, ...(expectedRevision != null ? { revision: expectedRevision } : {}) },
      data,
    });
    const after = await ctx.db.nodeRoleRule.findUnique({ where: { id: current.id } });
    if (!after) throw new NodeRoleRuleNotFoundError(ref);
    if (count === 0) throw conflict(after.revision);
    return { rule: after, warnings: [] };
  },

  deleteNodeRoleRule: async (
    _: unknown,
    { ref, expectedRevision }: { ref: string; expectedRevision?: number | null },
    ctx: Context,
  ) => {
    requireWriter(ctx);
    const current = await managedRule(ctx, ref);
    const { count } = await ctx.db.nodeRoleRule.deleteMany({
      where: { id: current.id, ...(expectedRevision != null ? { revision: expectedRevision } : {}) },
    });
    if (count === 0) {
      const now = await ctx.db.nodeRoleRule.findUnique({ where: { id: current.id }, select: { revision: true } });
      if (!now) throw new NodeRoleRuleNotFoundError(ref);
      throw conflict(now.revision);
    }
    return true;
  },
};

function conflict(currentRevision: number): GraphQLError {
  return new GraphQLError('The rule changed since you read it; re-read it and retry.', {
    extensions: { code: 'CONFLICT', currentRevision },
  });
}

export const memoryConfigFieldResolvers = {
  Memory: {
    /** Null for anyone who does not manage the memory (H4), however they reached it. */
    config: async (memory: { id: string }, _: unknown, ctx: Context) => {
      const row = await ctx.db.memory.findFirst({
        where: { id: memory.id, deletedAt: null },
        select: MEMORY_GATE_SELECT,
      });
      if (!row || !(await canManageMemoryConfig(ctx, row))) return null;
      return configForManagedMemory(ctx.db, row.id);
    },
  },
  MemoryConfig: {
    // Reached only through the manage gate above; the rows are that memory's.
    rules: async (config: { id: string | null }, _: unknown, ctx: Context) =>
      config.id == null
        ? []
        : ctx.db.nodeRoleRule.findMany({ where: { configId: config.id }, orderBy: { role: 'asc' } }),
  },
  NodeRoleRule: {
    authorTask: async (r: NodeRoleRule, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'authorTask')).urn,
    authorTaskState: async (r: NodeRoleRule, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'authorTask')).state,
    validationTask: async (r: NodeRoleRule, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'validationTask')).urn,
    validationTaskState: async (r: NodeRoleRule, _: unknown, ctx: Context) =>
      (await refViewOnce(ctx, r, 'validationTask')).state,
    descriptionNode: async (r: NodeRoleRule, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'descriptionNode')).urn,
    // A description node is documentation, not procedure: losing it is NONE, never BROKEN.
    descriptionNodeState: async (r: NodeRoleRule, _: unknown, ctx: Context) => {
      const v = await refViewOnce(ctx, r, 'descriptionNode');
      return v.state === 'BROKEN' ? 'NONE' : v.state;
    },
    sourceTemplate: async (r: NodeRoleRule, _: unknown, ctx: Context) => {
      if (r.sourceTemplateId == null) return null;
      const t = await ctx.db.memoryConfigTemplate.findUnique({
        where: { id: r.sourceTemplateId },
        select: { id: true, name: true, deletedAt: true },
      });
      return t ? { id: t.id, name: t.name, deleted: t.deletedAt != null } : null;
    },
  },
};
