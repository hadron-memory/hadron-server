/**
 * #1334 slice 1 — apply a MemoryConfigTemplate to ONE memory.
 *
 * A template is a rulebook that is COPIED in, never live-linked (#1325 part
 * c): applying writes ordinary `NodeRoleRule` rows into the memory's config,
 * stamped with `sourceTemplateId` for provenance, and a later template edit
 * never reaches them. Re-applying is an explicit, separate act.
 *
 * Per template rule, the outcome for its role:
 *   - no rule for the role yet → APPLIED (a new rule; locked if the template
 *     is required);
 *   - a rule exists and the template is NOT required → SKIPPED_CONFLICT (the
 *     memory's own rule stands);
 *   - a rule exists and the template IS required → REPLACED, unless that rule
 *     is locked and the caller lacks lock authority → SKIPPED_LOCKED. A lock
 *     is never moved by someone who could not move it by hand.
 *
 * Gates: MANAGE on the memory (#1325 H3/H4) and on the template (its owner's
 * managers, H4). Both concealing, both asked again inside the transaction
 * after the last lock wait. Every template reference is re-validated for the
 * CALLER exactly as createNodeRoleRule validates a new rule's (readable,
 * runnable, under a share lock), and a template rule whose required task was
 * deleted (BROKEN, H5) refuses the whole apply: copying it would plant a rule
 * that fails closed on first use. All-or-nothing per memory.
 *
 * dryRun computes the same report under the same checks and writes nothing.
 *
 * #1334 bulk slice — `applyMemoryConfigTemplateToMemories` runs this SAME per-target body (`applyToTarget`) over up
 * to BULK_APPLY_MAX_TARGETS memories, one transaction per target, one after another. The singular mutation calls the
 * same function, so the two cannot drift. See `applyMemoryConfigTemplateToMemories` for the report boundary.
 */

import { GraphQLError } from 'graphql';
import { Prisma, type MemoryConfigTemplateRule, type NodeRoleRule } from '../../../generated/prisma/index.js';
import { type Context, withoutRequestCaches } from './resolvers.helpers.js';
import { MemoryNotFoundError } from '../../../lib/entityRef/errors.js';
import { faultRequestId, INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE, logInternalFault } from '../../../lib/internalFault.js';
import { generateId } from '../../../lib/id.js';
import { lockMemoryConfigExclusive } from '../../../lib/governedRole.js';
import {
  conflict,
  hasLockAuthority,
  lockRuleRefs,
  managedMemory,
  materializeConfig,
  MEMORY_GATE_SELECT,
  reassertManage,
  requireWriter,
  touchConfig,
  type ResolvedRef,
} from './resolvers.memoryConfig.js';
import {
  managedTemplate,
  MemoryConfigTemplateNotFoundError,
  reassertManageOwner,
} from './resolvers.memoryConfigTemplate.js';

export type ApplyOutcome = 'APPLIED' | 'SKIPPED_CONFLICT' | 'REPLACED' | 'SKIPPED_LOCKED';

export interface ApplyEntry {
  role: string;
  outcome: ApplyOutcome;
  rule: NodeRoleRule | null;
}

export interface ApplyResult {
  memoryId: string;
  template: { id: string; name: string; deleted: boolean };
  templateRevision: number;
  required: boolean;
  dryRun: boolean;
  entries: ApplyEntry[];
  warnings: never[];
}

/** Thrown inside a dry run's transaction so nothing it touched commits. */
class DryRunRollback extends Error {
  constructor(readonly result: ApplyResult) {
    super('dry run');
  }
}

/** H5: a required task that has since been deleted. Copying it would plant a rule that refuses every use. */
function refBroken(role: string, field: 'authorTask' | 'validationTask'): GraphQLError {
  return new GraphQLError(
    `The template's rule for role "${role}" points at a ${field === 'authorTask' ? 'author' : 'validation'} task that was deleted; repoint it in the template before applying.`,
    { extensions: { code: 'NODE_ROLE_RULE_REF_BROKEN', role, field } },
  );
}

/** The template rule's references, as the refs a create would re-check for the caller. */
function refsOf(rule: MemoryConfigTemplateRule): ResolvedRef[] {
  if (rule.authorTaskRequired && !rule.authorTaskId) throw refBroken(rule.role, 'authorTask');
  if (rule.validationTaskRequired && !rule.validationTaskId) throw refBroken(rule.role, 'validationTask');
  // `ref` is what a refusal echoes (NODE_NOT_FOUND). A template reference
  // is stored, not caller-supplied, and the rule's field resolvers withhold
  // its id when it's UNREADABLE, so the refusal names the rule and field
  // instead of the node id (#1399 review).
  const label = (field: string) => `template rule "${rule.role}" ${field}`;
  const out: ResolvedRef[] = [];
  if (rule.authorTaskId) out.push({ kind: 'authorTask', id: rule.authorTaskId, ref: label('authorTask') });
  if (rule.validationTaskId) out.push({ kind: 'validationTask', id: rule.validationTaskId, ref: label('validationTask') });
  if (rule.descriptionNodeId) out.push({ kind: 'descriptionNode', id: rule.descriptionNodeId, ref: label('descriptionNode') });
  return out;
}

/** The copied columns: everything a rule carries except its identity, lock and audit fields. */
function copiedColumns(rule: MemoryConfigTemplateRule) {
  return {
    authorTaskId: rule.authorTaskId,
    authorTaskRequired: rule.authorTaskRequired,
    validationTaskId: rule.validationTaskId,
    validationTaskRequired: rule.validationTaskRequired,
    descriptionNodeId: rule.descriptionNodeId,
    strictSubRoles: rule.strictSubRoles,
    writers: rule.writers,
    validateBy: rule.validateBy,
    enabled: rule.enabled,
  };
}

export async function applyMemoryConfigTemplate(
  ctx: Context,
  args: { templateRef: string; memoryRef: string; expectedTemplateRevision?: number | null; dryRun?: boolean | null },
): Promise<ApplyResult> {
  const actor = requireWriter(ctx);
  const memory = await managedMemory(ctx, args.memoryRef);
  const template = await managedTemplate(ctx, args.templateRef);
  return applyToTarget(ctx, actor, memory, template, args);
}

/**
 * One target's apply, from the pre-checked memory and template: the unchanged slice-1 transaction. The singular
 * mutation and every bulk target run exactly this.
 */
async function applyToTarget(
  ctx: Context,
  actor: string,
  memory: { id: string },
  template: { id: string; ownerUserId: string | null; appId: string | null },
  args: { templateRef: string; memoryRef: string; expectedTemplateRevision?: number | null; dryRun?: boolean | null },
): Promise<ApplyResult> {
  const dryRun = args.dryRun === true;
  const notFoundTemplate = () => new MemoryConfigTemplateNotFoundError(args.templateRef);

  try {
    return await ctx.db.$transaction(async (tx) => {
      // The template row under a SHARE lock: its rules cannot change until we
      // commit (an update takes it FOR UPDATE), while two applies of the same
      // template proceed side by side.
      // The template's OWNER row, FOR KEY SHARE, before ANY other lock
      // (#1399 review): account deletion hard-deletes the owner's memories —
      // the TARGET of this apply and a REFERENCED node alike, the cascade
      // holds both — and only later deletes their templates. An apply that
      // locks the target memory first and then waits here cycles with a
      // deletion holding the user row and queuing on that same target row;
      // one that holds the template FOR SHARE and queues on a referenced
      // node cycles with the deletion queuing on the template. The owner row
      // is deletion's FIRST lock, so KEY SHARE here — as ours — serializes
      // the whole apply against the whole deletion: a deletion already
      // running holds it and we wait owning nothing it needs, and one that
      // commits first leaves us answering a concealing not-found here, at the
      // target re-read, or at the live re-read. App-owned templates take the
      // same barrier on the App row: the App cascade removes app-scoped
      // memories and their templates in one statement. Org- and server-owned
      // templates are only soft-deleted, and that cascade touches no node or
      // template rows, so they need no owner lock.
      if (template.ownerUserId) {
        const owner = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "users" WHERE "id" = ${template.ownerUserId} AND "deleted_at" IS NULL FOR KEY SHARE`;
        if (!owner[0]) throw notFoundTemplate();
      } else if (template.appId) {
        const owner = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "apps" WHERE "id" = ${template.appId} AND "deleted_at" IS NULL FOR KEY SHARE`;
        if (!owner[0]) throw notFoundTemplate();
      }
      // The TARGET memory, FOR KEY SHARE (#1399 review): the config row this
      // apply may create references it, and a deletion that got past the
      // barrier has already committed by the time we get here, leaving this
      // re-read to answer MEMORY_NOT_FOUND.
      const target = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "memories" WHERE "id" = ${memory.id} AND "deleted_at" IS NULL FOR KEY SHARE`;
      if (!target[0]) throw new MemoryNotFoundError(args.memoryRef);
      await tx.$queryRaw`SELECT 1 FROM "memory_config_templates" WHERE "id" = ${template.id} FOR SHARE`;
      const live = await tx.memoryConfigTemplate.findFirst({ where: { id: template.id, deletedAt: null } });
      if (!live) throw notFoundTemplate();
      // Re-asked as soon as the template lock is held, before anything about
      // the template (its revision, its rules' refusals) can be answered: a
      // caller whose access was revoked while this waited on a template
      // update gets the same concealing not-found (#1399 review). Asked again
      // after the last lock below, before any write.
      await reassertManageOwner(ctx, tx, live, notFoundTemplate);
      if (args.expectedTemplateRevision != null && live.revision !== args.expectedTemplateRevision) {
        throw conflict(live.revision, 'template');
      }
      const rules = await tx.memoryConfigTemplateRule.findMany({ where: { templateId: live.id }, orderBy: { role: 'asc' } });

      // Validate the whole list before anything is written.
      const resolved = rules.flatMap(refsOf);
      await lockRuleRefs(ctx, tx, resolved);

      // Lock order, as every rule write takes it: referenced nodes (above),
      // then the rules, then the config row (#1399 review). So the config is
      // only READ here; it is created or stamped last, and only when a rule is
      // actually written. An empty template, or one whose every role is
      // skipped, materializes nothing, keeping the config lazy (#1325).
      const found = await tx.memoryConfig.findUnique({ where: { memoryId: memory.id }, select: { id: true } });
      const roles = rules.map((r) => r.role);
      const existing = new Map<string, NodeRoleRule>();
      if (found && roles.length) {
        await tx.$queryRaw`
          SELECT 1 FROM "node_role_rules"
          WHERE "config_id" = ${found.id} AND "role" IN (${Prisma.join(roles)})
          ORDER BY "id" FOR UPDATE`;
        for (const r of await tx.nodeRoleRule.findMany({ where: { configId: found.id, role: { in: roles } } })) {
          existing.set(r.role, r);
        }
      }

      // Asked once, fresh, only when a required template meets a locked rule.
      let lockAuthority: boolean | null = null;
      const mayMoveLocks = async () => {
        if (lockAuthority === null) {
          const row = await tx.memory.findFirst({ where: { id: memory.id }, select: MEMORY_GATE_SELECT });
          lockAuthority = !!row && (await hasLockAuthority(withoutRequestCaches(ctx, tx), row));
        }
        return lockAuthority;
      };

      // Decide every role first, then write.
      const plan: Array<{ rule: MemoryConfigTemplateRule; outcome: ApplyOutcome; current: NodeRoleRule | null }> = [];
      for (const rule of rules) {
        const current = existing.get(rule.role) ?? null;
        if (!current) plan.push({ rule, outcome: 'APPLIED', current });
        else if (!live.required) plan.push({ rule, outcome: 'SKIPPED_CONFLICT', current });
        else if (current.locked && !(await mayMoveLocks())) plan.push({ rule, outcome: 'SKIPPED_LOCKED', current });
        else plan.push({ rule, outcome: 'REPLACED', current });
      }
      const writes = !dryRun && plan.some((p) => p.outcome === 'APPLIED' || p.outcome === 'REPLACED');
      // The rulebook lock (#1400), exclusively, BEFORE the config row, the
      // gate re-checks and any insert (#1399 review). Every rule writer takes
      // it before inserting a rule (createNodeRoleRule, via materializeConfig),
      // so an APPLIED insert can no longer wait on, or deadlock with, a
      // concurrent create of the same role: it is refused as CONFLICT
      // instead. Taken after the rule row locks, as every rule writer
      // takes it, so the order is the same everywhere.
      if (writes) await lockMemoryConfigExclusive(tx, memory.id);
      const configId = writes ? (found?.id ?? (await materializeConfig(tx, memory.id, actor))) : null;
      // The config row, locked now so that `touchConfig` below cannot wait:
      // every lock that can block is taken before the gates are re-asked.
      if (configId) await tx.$queryRaw`SELECT 1 FROM "memory_configs" WHERE "id" = ${configId} FOR UPDATE`;
      // Both gates asked again AFTER the last lock that can wait (the rules,
      // then the config): a membership revoked while this transaction queued
      // behind another rule write must not still authorize it (#1399 review).
      await reassertManage(ctx, tx, memory.id, () => new MemoryNotFoundError(args.memoryRef));
      await reassertManageOwner(ctx, tx, live, notFoundTemplate);
      // …and the template's REFERENCES too (#1399 review): access to a
      // referenced node's memory can be revoked while this queued. The node
      // rows are already share-locked by this transaction, so this re-check
      // waits for nothing; it only re-asks readability, fresh.
      await lockRuleRefs(ctx, tx, resolved);

      const entries: ApplyEntry[] = [];
      for (const { rule, outcome, current } of plan) {
        let after: NodeRoleRule | null = current;
        if (writes && outcome === 'APPLIED') {
          after = await tx.nodeRoleRule.create({
            data: {
              id: generateId(),
              configId: configId!,
              role: rule.role,
              ...copiedColumns(rule),
              sourceTemplateId: live.id,
              locked: live.required,
              createdBy: actor,
              updatedBy: actor,
            },
          });
        } else if (writes && outcome === 'REPLACED') {
          after = await tx.nodeRoleRule.update({
            where: { id: current!.id },
            data: { ...copiedColumns(rule), sourceTemplateId: live.id, locked: true, updatedBy: actor, revision: { increment: 1 } },
          });
        }
        entries.push({ role: rule.role, outcome, rule: after });
      }
      if (writes) await touchConfig(tx, configId!, actor);
      const result: ApplyResult = {
        memoryId: memory.id,
        template: { id: live.id, name: live.name, deleted: false },
        templateRevision: live.revision,
        required: live.required,
        dryRun,
        entries,
        warnings: [],
      };
      if (dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result;
    // A concurrent createNodeRoleRule took a role between our read and our
    // insert (it does not take the rows we lock). Nothing was written; the
    // caller re-reads and retries.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new GraphQLError("The memory's config changed while the template was being applied; retry.", {
        extensions: { code: 'CONFLICT' },
      });
    }
    throw e;
  }
}

/** The most memories one bulk call may name (#1334, Vera's recommended value; cor:api:040:02 analog). */
export const BULK_APPLY_MAX_TARGETS = 50;

export interface BulkApplyError {
  code: string;
  message: string;
  currentRevision: number | null;
  requestId: string | null;
}
export interface BulkApplyEntry {
  index: number;
  memoryRef: string;
  ok: boolean;
  result: ApplyResult | null;
  error: BulkApplyError | null;
}

/** The typed refusals a single target's apply can raise; anything else is a fault and is sanitized. */
const TARGET_REFUSALS = new Set(['CONFLICT', 'NODE_NOT_FOUND', 'NOT_A_TASK', 'NODE_ROLE_RULE_REF_BROKEN', 'BAD_USER_INPUT']);

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/**
 * One target's failure as a report entry. A not-found message is built from the ref the caller typed and nothing
 * else, so a missing memory and one the caller cannot manage are byte-identical. A typed refusal keeps its code; an
 * unknown error is logged under a request id and shows only the generic envelope, never driver text.
 */
function toEntryError(e: unknown): BulkApplyError {
  if (e instanceof MemoryNotFoundError || e instanceof MemoryConfigTemplateNotFoundError) {
    return { code: e.code, message: e.message, currentRevision: null, requestId: null };
  }
  if (e instanceof GraphQLError) {
    const code = e.extensions?.code;
    if (typeof code === 'string' && TARGET_REFUSALS.has(code)) {
      const rev = e.extensions?.currentRevision;
      return { code, message: e.message, currentRevision: typeof rev === 'number' ? rev : null, requestId: null };
    }
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return { code: 'CONFLICT', message: "The memory's config changed while the template was being applied; retry.", currentRevision: null, requestId: null };
  }
  const requestId = faultRequestId();
  logInternalFault('graphql', 'applyMemoryConfigTemplateToMemories', requestId, e);
  return { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE, currentRevision: null, requestId };
}

/**
 * Apply one template to a list of memories (#1334 bulk slice; contract: Vera's FIT 6416599124 + Xylon's fixes).
 *
 * Boundary: the CALL is refused before any write for a bad list (empty, blank, over the cap), an unknown or
 * unmanageable template, or a stale expectedTemplateRevision. After that every target is its own atomic transaction
 * (the singular body, unchanged), processed in input order with no lock held across targets, so one target's failure
 * never rolls another back and a committed target stays committed. There is no snapshot of the template across the
 * call: each success reports the templateRevision its own transaction saw, and expectedTemplateRevision is judged
 * again inside every target. MANAGE on the template and the memory is asked fresh per target (no request memos).
 *
 * Duplicates are judged on the RESOLVED id and only AFTER the manage gate, so DUPLICATE_TARGET is only ever said
 * about a memory the caller manages; the first occurrence consumes the slot even if its apply fails.
 */
export async function applyMemoryConfigTemplateToMemories(
  ctx: Context,
  args: { templateRef: string; memoryRefs: string[]; expectedTemplateRevision?: number | null; dryRun?: boolean | null },
): Promise<{ dryRun: boolean; results: BulkApplyEntry[]; succeeded: number; failed: number }> {
  const actor = requireWriter(ctx);
  const refs = args.memoryRefs;
  if (!Array.isArray(refs) || refs.length === 0) throw badInput('Name at least one memory.');
  if (refs.some((r) => typeof r !== 'string' || r.trim() === '')) throw badInput('A memory reference cannot be blank.');
  if (refs.length > BULK_APPLY_MAX_TARGETS) {
    throw new GraphQLError(`One call applies a template to at most ${BULK_APPLY_MAX_TARGETS} memories; this one names ${refs.length}.`, {
      extensions: { code: 'BULK_TARGETS_TOO_MANY', max: BULK_APPLY_MAX_TARGETS, count: refs.length },
    });
  }
  const dryRun = args.dryRun === true;
  // Resolved before any target, so a template the caller cannot manage can never act as a target oracle.
  const first = await managedTemplate(ctx, args.templateRef);
  if (args.expectedTemplateRevision != null && first.revision !== args.expectedTemplateRevision) {
    throw conflict(first.revision, 'template');
  }

  const seen = new Set<string>();
  const results: BulkApplyEntry[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const memoryRef = refs[index]!;
    try {
      const fresh = withoutRequestCaches(ctx);
      const memory = await managedMemory(fresh, memoryRef);
      if (seen.has(memory.id)) {
        results.push({
          index, memoryRef, ok: false, result: null,
          error: { code: 'DUPLICATE_TARGET', message: 'This memory was already named earlier in the list.', currentRevision: null, requestId: null },
        });
        continue;
      }
      seen.add(memory.id);
      const template = await managedTemplate(fresh, args.templateRef);
      const result = await applyToTarget(fresh, actor, memory, template, {
        templateRef: args.templateRef, memoryRef, expectedTemplateRevision: args.expectedTemplateRevision, dryRun,
      });
      results.push({ index, memoryRef, ok: true, result, error: null });
    } catch (e) {
      results.push({ index, memoryRef, ok: false, result: null, error: toEntryError(e) });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { dryRun, results, succeeded, failed: results.length - succeeded };
}

export const memoryConfigApplyMutations = {
  applyMemoryConfigTemplate: (
    _: unknown,
    args: { templateRef: string; memoryRef: string; expectedTemplateRevision?: number | null; dryRun?: boolean | null },
    ctx: Context,
  ) => applyMemoryConfigTemplate(ctx, args),
  applyMemoryConfigTemplateToMemories: (
    _: unknown,
    args: { templateRef: string; memoryRefs: string[]; expectedTemplateRevision?: number | null; dryRun?: boolean | null },
    ctx: Context,
  ) => applyMemoryConfigTemplateToMemories(ctx, args),
};
