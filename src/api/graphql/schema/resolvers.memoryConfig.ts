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
 *     `deleteMemory`/`encryptMemory`/`updateMemory`;
 *   - everything else: the shared `requireMemoryManageAccess` gate
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
 * `moveNode`, even across memories), and returned as a URN and an id. The SAVER must be
 * able to read the referenced node's memory (the node-content gate); an
 * unreadable node answers exactly like a missing one (`NODE_NOT_FOUND`, the
 * #1319 concealment rule), and only then is runnability checked, so a rule
 * mutation cannot probe other tenants' nodes. On read each reference carries a
 * state (cli#716 Q1–Q9): NONE (not configured), OK (id given, and the URN
 * unless the memory's legacy URN cannot address the node), BROKEN (was
 * configured, the node is gone — `*Required` holds after the FK's SET NULL, or
 * the node is soft-deleted; H5 fail-closed), UNREADABLE (exists, not yours to
 * read; URN and id withheld).
 *
 * ## Concurrency
 *
 * Every rule mutation is one transaction: share-lock the referenced nodes and
 * re-assert them, lock the rule row, judge the revision and the validateBy
 * invariant on the row as it is then, write, and stamp the config's audit
 * fields. Lock order is nodes → rule → config everywhere, matching a hard node
 * delete (node, then the FK's SET NULL on the rule).
 */
import { GraphQLError } from 'graphql';
import { Prisma, type NodeRoleRule, type PrismaClient } from '../../../generated/prisma/index.js';
import {
  type Context,
  isMemoryReadableCached,
  isMemoryReadableFresh,
  requireOrgRole,
  requireMemoryManageAccess,
  withoutRequestCaches,
} from './resolvers.helpers.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { EntityNotFoundError, MemoryNotFoundError, NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { assertValidRuleRole, lockMemoryConfigExclusive } from '../../../lib/governedRole.js';
import { nodeUrnRoundTrips, safeNodeUrnV2 } from '../../../lib/urnEmit.js';
import { generateId } from '../../../lib/id.js';
import { forbiddenError, unauthenticatedError } from '../../../lib/refusals.js';

export type Writers = 'ALL' | 'OWNER' | 'ADMIN';
export type Validator = 'AGENT' | 'PLATFORM';
type RefState = 'NONE' | 'OK' | 'BROKEN' | 'UNREADABLE';

/** The reference columns a node-role rule and a template rule share (#1325 part c). */
export type RuleRefRow = Pick<
  NodeRoleRule,
  'authorTaskId' | 'authorTaskRequired' | 'validationTaskId' | 'validationTaskRequired' | 'descriptionNodeId'
>;

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

export type MemoryGateRow = {
  id: string;
  class: string;
  userId: string | null;
  organizationId: string | null;
  ownerUserId: string | null;
};

/**
 * The MANAGE gate (H3/H4). Boolean, so every caller can conceal a refusal as
 * not-found. Only a refusal becomes `false`: an operational failure (a
 * membership lookup that times out) propagates, so an outage never reads as
 * "no such memory".
 *
 * Impersonation (#876) is a read-only support view. It never speaks for the
 * owner of a personal/private or user-owned memory; on an org memory it READS
 * the config exactly as its target would — `requireOrgRole` already confines it
 * to the one shared org — and `requireWriter` refuses every mutation.
 */
export async function canManageMemoryConfig(ctx: Context, memory: MemoryGateRow): Promise<boolean> {
  try {
    await requireMemoryManageAccess(ctx, memory);
    return true;
  } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') return false;
    throw e;
  }
}

export const MEMORY_GATE_SELECT = { id: true, class: true, userId: true, organizationId: true, ownerUserId: true } as const;

/**
 * #1334 — LOCK authority over a memory's locked rules: the existing
 * admin/owner hierarchy. On an org memory, an org ADMIN/OWNER
 * (`requireOrgRole`, which admits a platform admin); a memory's user owner
 * who is not also an org admin manages the config but cannot move a lock.
 * A personal/private memory's config has exactly one manager, its strict
 * owner (H3), and a memory with no org is managed by its user owner alone, so
 * for both the manager IS the lock authority. Boolean, refusal-only, like the
 * MANAGE gate.
 */
export async function hasLockAuthority(ctx: Context, memory: MemoryGateRow): Promise<boolean> {
  if (memory.class === 'personal' || memory.class === 'private' || !memory.organizationId) {
    return canManageMemoryConfig(ctx, memory);
  }
  if (ctx.impersonation) return false;
  try {
    await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
    return true;
  } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') return false;
    throw e;
  }
}

/**
 * #1334 — an ordinary edit or delete of a LOCKED rule. Holger's ruling
 * (2026-09-27, option 2): nobody changes a locked rule casually, not even an
 * admin. It takes the deliberate step of `unlockNodeRoleRule` (lock authority
 * required) or re-applying a required template. The rule is readable to
 * whoever manages it, so this reveals nothing.
 */
export function ruleLocked(rule: Pick<NodeRoleRule, 'id' | 'role' | 'sourceTemplateId'>, reason?: string): GraphQLError {
  return new GraphQLError(
    reason ??
      `The rule for role "${rule.role}" is locked by a required template. Unlock it first (unlockNodeRoleRule, org admin) or re-apply the template.`,
    { extensions: { code: 'RULE_LOCKED', ruleId: rule.id, role: rule.role, sourceTemplateId: rule.sourceTemplateId } },
  );
}

/** Lock authority, asked fresh inside the write transaction on the memory row as it reads now. */
async function assertLockAuthority(
  ctx: Context,
  tx: Prisma.TransactionClient,
  memoryId: string,
  rule: NodeRoleRule,
): Promise<void> {
  const memory = await tx.memory.findFirst({ where: { id: memoryId }, select: MEMORY_GATE_SELECT });
  if (!memory || !(await hasLockAuthority(withoutRequestCaches(ctx, tx), memory))) {
    throw ruleLocked(rule, `Only an org admin can unlock the rule for role "${rule.role}".`);
  }
}

/** Resolve a memory ref the caller may MANAGE, or throw the missing-memory answer. */
export async function managedMemory(ctx: Context, memoryRef: string): Promise<MemoryGateRow> {
  const { id } = await resolveMemoryRef(ctx.db, memoryRef);
  const memory = await ctx.db.memory.findFirst({ where: { id, deletedAt: null }, select: MEMORY_GATE_SELECT });
  if (!memory || !(await canManageMemoryConfig(ctx, memory))) throw new MemoryNotFoundError(memoryRef);
  return memory;
}

/**
 * The MANAGE gate asked AGAIN inside the write transaction, after its last lock
 * wait (#1360 review, Codex P1). The pre-check authorizes the request, but a
 * write then waits on node and rule row locks for as long as their holders
 * take, and a manager demoted or removed, or a memory deleted, during that wait
 * must not still save. Asked FRESH — without the request's memos, which would
 * replay the pre-check — on the memory row as it reads now, and refused with
 * the same not-found answer as the pre-check, and on the transaction's own
 * connection (see `withoutRequestCaches`). The Memory row is locked before
 * this recheck so an ownership transfer cannot commit between it and the
 * rule write. Membership revocation still needs its own serialization.
 */
export async function reassertManage(
  ctx: Context,
  tx: Prisma.TransactionClient,
  memoryId: string,
  notFound: () => Error,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
  const memory = await tx.memory.findFirst({ where: { id: memoryId, deletedAt: null }, select: MEMORY_GATE_SELECT });
  if (!memory || !(await canManageMemoryConfig(withoutRequestCaches(ctx, tx), memory))) throw notFound();
}

/** Resolve a rule ref (its id) the caller may MANAGE, or throw the missing-rule answer. */
async function managedRule(ctx: Context, ref: string): Promise<NodeRoleRule & { memoryId: string }> {
  const rule = await ctx.db.nodeRoleRule.findUnique({
    where: { id: ref },
    include: { config: { select: { memory: { select: { ...MEMORY_GATE_SELECT, deletedAt: true } } } } },
  });
  const memory = rule?.config.memory;
  if (!rule || !memory || memory.deletedAt || !(await canManageMemoryConfig(ctx, memory))) {
    throw new NodeRoleRuleNotFoundError(ref);
  }
  const { config: _config, ...row } = rule;
  return { ...row, memoryId: memory.id };
}

/** Mutations stamp the actor; impersonation is read-only (#876). */
export function requireWriter(ctx: Context): string {
  if (ctx.impersonation) throw forbiddenError();
  if (!ctx.userId) throw unauthenticatedError();
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
        ({ id } = await resolveNodeRefForCaller(ctx, ref));
  } catch (e) {
    if (e instanceof EntityNotFoundError) throw new NodeNotFoundError(ref);
    throw e;
  }
  const node = await ctx.db.node.findUnique({ where: { id }, select: { memoryId: true, isRunnable: true } });
  if (!node || !(await isMemoryReadableCached(ctx, node.memoryId))) throw new NodeNotFoundError(ref);
  if (kind !== 'descriptionNode' && node.isRunnable !== true) throw notATask(kind);
  return id;
}

const REF_COLUMNS: Record<RefKind, { id: 'authorTaskId' | 'validationTaskId' | 'descriptionNodeId'; required?: 'authorTaskRequired' | 'validationTaskRequired' }> = {
  authorTask: { id: 'authorTaskId', required: 'authorTaskRequired' },
  validationTask: { id: 'validationTaskId', required: 'validationTaskRequired' },
  descriptionNode: { id: 'descriptionNodeId' },
};

export type ResolvedRef = { kind: RefKind; id: string; ref: string };

/**
 * The column writes for the references present in `input`. A given ref sets
 * the id and, for a task, its fail-closed `*Required` marker (H5); a null/""
 * ref is an explicit clear and drops both. An omitted ref yields nothing.
 * `resolved` lists the refs that were set, for {@link lockRuleRefs}.
 */
export async function refWrites(
  ctx: Context,
  input: UpdateNodeRoleRuleInput,
): Promise<{ cols: Partial<Record<string, string | boolean | null>>; resolved: ResolvedRef[] }> {
  const cols: Partial<Record<string, string | boolean | null>> = {};
  const resolved: ResolvedRef[] = [];
  for (const kind of Object.keys(REF_COLUMNS) as RefKind[]) {
    const key = `${kind}Ref` as const;
    if (!(key in input) || input[key] === undefined) continue;
    const raw = input[key];
    const c = REF_COLUMNS[kind];
    if (raw === null || raw.trim() === '') {
      cols[c.id] = null;
      if (c.required) cols[c.required] = false;
    } else {
      const ref = raw.trim();
      const id = await resolveRuleRef(ctx, kind, ref);
      cols[c.id] = id;
      if (c.required) cols[c.required] = true;
      resolved.push({ kind, id, ref });
    }
  }
  return { cols, resolved };
}

/**
 * Re-assert inside the rule write's transaction, under a SHARE lock, what
 * `resolveRuleRef` judged before it: each referenced node still exists, is
 * not soft-deleted, still lives in a memory the SAVER can read (a move
 * rewrites `memory_id`, so the locked row is the one to judge), and — for a
 * task — is still runnable. Readability is judged before runnability, as in
 * `resolveRuleRef`. The lock holds until commit, so a concurrent edit cannot
 * change the row between the check and the write (#1360 review). Taken
 * BEFORE the rule's row lock: a hard node delete locks the node and then SET
 * NULLs the rule, so the same order here cannot deadlock against it.
 */
export async function lockRuleRefs(ctx: Context, tx: Prisma.TransactionClient, resolved: ResolvedRef[]): Promise<void> {
  if (resolved.length === 0) return;
  const ids = [...new Set(resolved.map((r) => r.id))].sort();
  // The node rows ALONE: a join here would be re-checked by Postgres against
  // the memory row as fetched BEFORE a concurrent move, so a moved node would
  // silently drop out of the result (EvalPlanQual) and read as missing.
  const rows = await tx.$queryRaw<{ id: string; is_runnable: boolean | null; deleted_at: Date | null; memory_id: string }[]>`
    SELECT "id", "is_runnable", "deleted_at", "memory_id" FROM "nodes"
    WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const { kind, id, ref } of resolved) {
    const row = byId.get(id);
    // The shared read gate, asked FRESH: the pre-check memoized this memory's
    // answer, so a cached re-check of an unmoved node would check nothing, and
    // the response would reuse it (#1360 review). It also refuses a
    // soft-deleted memory. Residual: neither the memory row nor the caller's
    // membership is locked, so access revoked after this point and before
    // commit still saves; that is every authorize-then-write surface's window.
    if (!row || row.deleted_at || !(await isMemoryReadableFresh(ctx, row.memory_id, tx))) {
      throw new NodeNotFoundError(ref);
    }
    if (kind !== 'descriptionNode' && row.is_runnable !== true) throw notATask(kind);
  }
}

function notATask(kind: RefKind): GraphQLError {
  return new GraphQLError(`The ${kind === 'authorTask' ? 'author' : 'validation'} task must be a runnable task node.`, {
    extensions: { code: 'NOT_A_TASK', field: kind },
  });
}

/** Lock a rule's row for the rest of the transaction and read it, or null when it is gone. */
export async function lockRule(tx: Prisma.TransactionClient, id: string): Promise<NodeRoleRule | null> {
  await tx.$queryRaw`SELECT 1 FROM "node_role_rules" WHERE "id" = ${id} FOR UPDATE`;
  return tx.nodeRoleRule.findUnique({ where: { id } });
}

/**
 * Stamp the config's audit fields: a rule change IS a change to the config
 * (#1360 review). `updatedAt` is Prisma's `@updatedAt`.
 */
export async function touchConfig(tx: Prisma.TransactionClient, configId: string, actor: string): Promise<void> {
  // #1400: every rule change holds the memory's config lock exclusively, so
  // node writes judging a role against this rulebook serialize with it.
  const { memoryId } = await tx.memoryConfig.findUniqueOrThrow({ where: { id: configId }, select: { memoryId: true } });
  await lockMemoryConfigExclusive(tx, memoryId);
  await tx.memoryConfig.update({ where: { id: configId }, data: { updatedBy: actor } });
}

/**
 * "`validateBy` needs a validation task" (#1325 design §2): judged on the
 * RESULTING state, and on a CONFIGURED task rather than a live one — a
 * validation task deleted since (BROKEN, `validationTaskRequired` still set)
 * must not block an unrelated edit to the rule; #1328 refuses writes of that
 * role until a manager repoints it.
 */
export function assertValidateByHasTask(state: { validateBy: Validator | null; validationTaskId: string | null; validationTaskRequired: boolean }): void {
  if (state.validateBy != null && state.validationTaskId == null && !state.validationTaskRequired) {
    throw new GraphQLError('`validateBy` needs a validation task: set `validationTaskRef`, or clear `validateBy`.', {
      extensions: { code: 'BAD_USER_INPUT', field: 'validateBy', reason: 'VALIDATION_TASK_REQUIRED' },
    });
  }
}

/** Create the config row if absent — race-safe, never a second row, never an aborted transaction. */
export async function materializeConfig(tx: Prisma.TransactionClient, memoryId: string, actor: string): Promise<string> {
  // #1400: taken BEFORE the row can exist, so a node write that found no
  // config either commits first or sees this memory's first rules.
  await lockMemoryConfigExclusive(tx, memoryId);
  await tx.$executeRaw`
    INSERT INTO "memory_configs" ("id", "memory_id", "created_by", "updated_by")
    VALUES (${generateId()}, ${memoryId}, ${actor}, ${actor})
    ON CONFLICT ("memory_id") DO NOTHING`;
  const row = await tx.memoryConfig.findUniqueOrThrow({ where: { memoryId }, select: { id: true } });
  return row.id;
}

export function translateRoleTaken(e: unknown, role: string): never {
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
type RefView = { urn: string | null; id: string | null; state: RefState };
const refViewCache = new WeakMap<object, Map<string, Promise<RefView>>>();
function refViewOnce(ctx: Context, rule: RuleRefRow, kind: RefKind): Promise<RefView> {
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

/**
 * One reference's read projection. The node id and URN are given only when
 * OK. The URN is additionally withheld when it would not resolve back to the
 * node (a legacy compound memory URN, #697): OK then pairs a null URN with the
 * id, which always addresses the node (`findings:compound-app-mem-node-addressing`).
 */
async function refView(ctx: Context, id: string | null, required: boolean): Promise<RefView> {
  if (id == null) return { urn: null, id: null, state: required ? 'BROKEN' : 'NONE' };
  const node = await ctx.db.node.findUnique({
    where: { id },
    select: { loc: true, memoryId: true, deletedAt: true, memory: { select: { urn: true, deletedAt: true } } },
  });
  if (!node || node.deletedAt || node.memory.deletedAt) return { urn: null, id: null, state: 'BROKEN' };
  if (!(await isMemoryReadableCached(ctx, node.memoryId))) return { urn: null, id: null, state: 'UNREADABLE' };
  const urn = nodeUrnRoundTrips(node.memory.urn, node.loc) ? safeNodeUrnV2(node.memory.urn, node.loc) : null;
  return { urn, id, state: 'OK' };
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
    const { cols: refs, resolved } = await refWrites(ctx, input);
    const state = {
      validateBy: input.validateBy ?? null,
      validationTaskId: (refs.validationTaskId as string | null | undefined) ?? null,
      validationTaskRequired: (refs.validationTaskRequired as boolean | undefined) ?? false,
    };
    assertValidateByHasTask(state);
    try {
      const rule = await ctx.db.$transaction(async (tx) => {
        await lockRuleRefs(ctx, tx, resolved);
        // #1400 review: the rulebook lock BEFORE the gate is re-asked, so no
        // lock wait follows it (materializeConfig/touchConfig re-take it, re-entrant).
        await lockMemoryConfigExclusive(tx, memory.id);
        await reassertManage(ctx, tx, memory.id, () => new MemoryNotFoundError(memoryRef));
        const configId = await materializeConfig(tx, memory.id, actor);
        const created = await tx.nodeRoleRule.create({
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
        await touchConfig(tx, configId, actor);
        return created;
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
    const { id, memoryId } = await managedRule(ctx, ref);
    const { cols: refs, resolved } = await refWrites(ctx, input);
    const data: Prisma.NodeRoleRuleUncheckedUpdateInput = {
      ...refs,
      ...(input.strictSubRoles != null ? { strictSubRoles: input.strictSubRoles } : {}),
      ...(input.writers != null ? { writers: input.writers } : {}),
      ...('validateBy' in input && input.validateBy !== undefined ? { validateBy: input.validateBy } : {}),
      ...(input.enabled != null ? { enabled: input.enabled } : {}),
      updatedBy: actor,
      revision: { increment: 1 },
    };
    // One transaction holding the rule's row lock from the read to the
    // returned row: the revision check (cli#716 Q1), the validateBy invariant
    // (judged on the row as it is NOW, so a concurrent last-writer-wins update
    // cannot strand validateBy without a task), the write and the result all
    // see the same row, and no other write lands between them (#1360 review).
    const rule = await ctx.db.$transaction(async (tx) => {
      await lockRuleRefs(ctx, tx, resolved);
      const current = await lockRule(tx, id);
      if (!current) throw new NodeRoleRuleNotFoundError(ref);
      // #1400 review: the rulebook lock BEFORE the gate is re-asked, so no
      // lock wait follows it (touchConfig re-takes it, re-entrant).
      await lockMemoryConfigExclusive(tx, memoryId);
      await reassertManage(ctx, tx, memoryId, () => new NodeRoleRuleNotFoundError(ref));
      if (expectedRevision != null && current.revision !== expectedRevision) throw conflict(current.revision);
      if (current.locked) throw ruleLocked(current);
      assertValidateByHasTask({
        validateBy: ('validateBy' in data ? data.validateBy : current.validateBy) as Validator | null,
        validationTaskId: ('validationTaskId' in refs ? refs.validationTaskId : current.validationTaskId) as string | null,
        validationTaskRequired: ('validationTaskRequired' in refs
          ? refs.validationTaskRequired
          : current.validationTaskRequired) as boolean,
      });
      const after = await tx.nodeRoleRule.update({ where: { id }, data });
      await touchConfig(tx, current.configId, actor);
      return after;
    });
    return { rule, warnings: [] };
  },

  deleteNodeRoleRule: async (
    _: unknown,
    { ref, expectedRevision }: { ref: string; expectedRevision?: number | null },
    ctx: Context,
  ) => {
    const actor = requireWriter(ctx);
    const { id, memoryId } = await managedRule(ctx, ref);
    await ctx.db.$transaction(async (tx) => {
      const current = await lockRule(tx, id);
      if (!current) throw new NodeRoleRuleNotFoundError(ref);
      // #1400 review: the rulebook lock BEFORE the gate is re-asked, so no
      // lock wait follows it (touchConfig re-takes it, re-entrant).
      await lockMemoryConfigExclusive(tx, memoryId);
      await reassertManage(ctx, tx, memoryId, () => new NodeRoleRuleNotFoundError(ref));
      if (expectedRevision != null && current.revision !== expectedRevision) throw conflict(current.revision);
      if (current.locked) throw ruleLocked(current);
      await tx.nodeRoleRule.delete({ where: { id } });
      await touchConfig(tx, current.configId, actor);
    });
    return true;
  },

  /**
   * #1334 (Holger, 2026-09-27, option 2): the deliberate step before a locked
   * rule can be edited or deleted. It needs lock authority, and it is visible:
   * it bumps `revision` and stamps `updatedBy`/`updatedAt`. Unlocking an
   * unlocked rule changes nothing.
   */
  unlockNodeRoleRule: async (
    _: unknown,
    { ref, expectedRevision }: { ref: string; expectedRevision?: number | null },
    ctx: Context,
  ) => {
    const actor = requireWriter(ctx);
    const { id, memoryId } = await managedRule(ctx, ref);
    const rule = await ctx.db.$transaction(async (tx) => {
      const current = await lockRule(tx, id);
      if (!current) throw new NodeRoleRuleNotFoundError(ref);
      await lockMemoryConfigExclusive(tx, memoryId);
      await reassertManage(ctx, tx, memoryId, () => new NodeRoleRuleNotFoundError(ref));
      if (expectedRevision != null && current.revision !== expectedRevision) throw conflict(current.revision);
      if (!current.locked) return current;
      await assertLockAuthority(ctx, tx, memoryId, current);
      const after = await tx.nodeRoleRule.update({
        where: { id },
        data: { locked: false, updatedBy: actor, revision: { increment: 1 } },
      });
      await touchConfig(tx, current.configId, actor);
      return after;
    });
    return { rule, warnings: [] };
  },
};

export function conflict(currentRevision: number, what = 'rule'): GraphQLError {
  return new GraphQLError(`The ${what} changed since you read it; re-read it and retry.`, {
    extensions: { code: 'CONFLICT', currentRevision },
  });
}

/**
 * The reference fields of a rule, for a node-role rule and a template rule
 * alike. The `*Id` fields shadow the row's own columns ON PURPOSE: the default
 * resolver would hand out the stored id whatever the state, including the
 * UNREADABLE node whose URN is withheld.
 */
export const ruleRefFieldResolvers = {
  authorTaskId: async (r: RuleRefRow, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'authorTask')).id,
  validationTaskId: async (r: RuleRefRow, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'validationTask')).id,
  descriptionNodeId: async (r: RuleRefRow, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'descriptionNode')).id,
  authorTask: async (r: RuleRefRow, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'authorTask')).urn,
  authorTaskState: async (r: RuleRefRow, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'authorTask')).state,
  validationTask: async (r: RuleRefRow, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'validationTask')).urn,
  validationTaskState: async (r: RuleRefRow, _: unknown, ctx: Context) =>
    (await refViewOnce(ctx, r, 'validationTask')).state,
  descriptionNode: async (r: RuleRefRow, _: unknown, ctx: Context) => (await refViewOnce(ctx, r, 'descriptionNode')).urn,
  // A description node is documentation, not procedure: losing it is NONE, never BROKEN.
  descriptionNodeState: async (r: RuleRefRow, _: unknown, ctx: Context) => {
    const v = await refViewOnce(ctx, r, 'descriptionNode');
    return v.state === 'BROKEN' ? 'NONE' : v.state;
  },
};

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
    ...ruleRefFieldResolvers,
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
