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
 */

import { GraphQLError } from 'graphql';
import { Prisma, type MemoryConfigTemplateRule, type NodeRoleRule } from '../../../generated/prisma/index.js';
import { type Context, withoutRequestCaches } from './resolvers.helpers.js';
import { MemoryNotFoundError } from '../../../lib/entityRef/errors.js';
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
  const dryRun = args.dryRun === true;
  const memory = await managedMemory(ctx, args.memoryRef);
  const template = await managedTemplate(ctx, args.templateRef);
  const notFoundTemplate = () => new MemoryConfigTemplateNotFoundError(args.templateRef);

  try {
    return await ctx.db.$transaction(async (tx) => {
      // The template row under a SHARE lock: its rules cannot change until we
      // commit (an update takes it FOR UPDATE), while two applies of the same
      // template proceed side by side.
      // The TARGET memory first, FOR KEY SHARE (#1399 review): the config row
      // apply may create references it, so a concurrent hard delete (account
      // deletion removes a user's memories before their templates) either
      // finishes first and we answer MEMORY_NOT_FOUND, or waits for us.
      // Taken before the template lock, so the two can't form a cycle.
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

export const memoryConfigApplyMutations = {
  applyMemoryConfigTemplate: (
    _: unknown,
    args: { templateRef: string; memoryRef: string; expectedTemplateRevision?: number | null; dryRun?: boolean | null },
    ctx: Context,
  ) => applyMemoryConfigTemplate(ctx, args),
};
