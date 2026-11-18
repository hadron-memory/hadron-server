/**
 * #3426 — organization default MemoryConfig templates.
 *
 * An org-owned template flagged `orgDefault` is copied into every NEW org `knowledge` or `group` memory, once, in
 * the `createMemory` transaction. Nothing else applies it: clone, extract, App, install, agent, chat and worker
 * creation never do, and a default is a starting configuration, not a boundary (the docs must say so).
 *
 * ## Authority (C1, C5, C7)
 *
 * Defaults are applied AS THE ORG. Rule content comes from a template only an org admin can write, and the creator
 * gains no read path through it. So the references are judged by {@link orgReadableWhere} (the shared org arms of
 * `getOrgReadableMemoryIds`), never by the creator's own access, and the lock rule never asks `hasLockAuthority`:
 * a new memory has no earlier rules, so a lock written earlier in the SAME application is movable and the later
 * required default wins, whoever creates.
 *
 * ## Skipped references (C6, ruling 0200)
 *
 * A reference that is deleted, unreadable to the org or not a task:
 *   - in a NON-required default: the rule is skipped, with one concealed {@link MemoryConfigDefaultSkip} per field;
 *   - in a REQUIRED default: the rule is planted FAIL-CLOSED (locked, `*Required` marker set, id null), so writes of
 *     the role refuse AUTHOR_TASK_BROKEN until a manager repoints it. A broken description only drops the description.
 * The creation itself is never refused for a broken default. A failure of the application itself rolls the whole
 * creation back.
 *
 * ## Locks (C8)
 *
 * Templates FOR SHARE ordered by id with no join, then every referenced node FOR SHARE ordered by id, then the
 * rulebook lock and the new config. The save path takes a per-org advisory lock FIRST, so the cap is exact under
 * concurrency and the lock is never taken after another.
 */
import { GraphQLError } from 'graphql';
import { Prisma, type MemoryConfigTemplate, type MemoryConfigTemplateRule } from '../../../generated/prisma/index.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { orgReadableWhere } from '../../../lib/auth/orgReadableMemory.js';
import { generateId } from '../../../lib/id.js';
import { materializeConfig, touchConfig, type ResolvedRef } from './resolvers.memoryConfig.js';
import { copiedColumns } from './resolvers.memoryConfigRefs.js';

type Tx = Prisma.TransactionClient;

/** Most live org defaults per organization: application runs inside the creation transaction (5 s default). */
export const ORG_DEFAULT_LIMIT = 10;

export function orgDefaultOrgOnly(): GraphQLError {
  return new GraphQLError('Only an organization-owned template can be an organization default.', {
    extensions: { code: 'BAD_USER_INPUT', reason: 'ORG_DEFAULT_ORG_ONLY', field: 'orgDefault' },
  });
}

/**
 * Serialize the saves that can change an org's set of defaults. Transaction-scoped, taken before every other lock
 * in the save, and never taken while holding one, so it cannot take part in a cycle.
 */
export async function lockOrgDefaultSaves(tx: Tx, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'memory_config_org_default:' + orgId}))`;
}

/** The cap, counted under {@link lockOrgDefaultSaves}: the OTHER live defaults of the org. */
export async function assertOrgDefaultCapacity(tx: Tx, orgId: string, selfId: string | null): Promise<void> {
  const others = await tx.memoryConfigTemplate.count({
    where: { organizationId: orgId, orgDefault: true, deletedAt: null, ...(selfId ? { id: { not: selfId } } : {}) },
  });
  if (others >= ORG_DEFAULT_LIMIT) {
    throw new GraphQLError(`An organization can have at most ${ORG_DEFAULT_LIMIT} default templates.`, {
      extensions: { code: 'BAD_USER_INPUT', reason: 'ORG_DEFAULT_LIMIT', field: 'orgDefault' },
    });
  }
}

/**
 * C2 — each reference must be readable to the ORG as well as to the saver (the saver's gate is `lockRuleRefs`). Called
 * after `lockRuleRefs`, so the node rows are share-locked and cannot move. One concealing answer for both: the same
 * NODE_NOT_FOUND with the rule label, so "not readable to the org" is not an oracle for the saver's own reach.
 */
export async function assertRefsReadableToOrg(tx: Tx, orgId: string, resolved: ResolvedRef[]): Promise<void> {
  if (resolved.length === 0) return;
  const ids = [...new Set(resolved.map((r) => r.id))];
  const nodes = await tx.node.findMany({ where: { id: { in: ids } }, select: { id: true, memoryId: true } });
  const memoryIds = [...new Set(nodes.map((n) => n.memoryId))];
  const readable = new Set(
    (await tx.memory.findMany({ where: { id: { in: memoryIds }, ...orgReadableWhere(orgId) }, select: { id: true } })).map((m) => m.id),
  );
  const memoryOf = new Map(nodes.map((n) => [n.id, n.memoryId]));
  for (const { id, ref } of resolved) {
    const memoryId = memoryOf.get(id);
    if (!memoryId || !readable.has(memoryId)) throw new NodeNotFoundError(ref);
  }
}

type RefField = 'authorTask' | 'validationTask' | 'descriptionNode';
const FIELD_COLUMNS: Record<RefField, { id: 'authorTaskId' | 'validationTaskId' | 'descriptionNodeId'; required?: 'authorTaskRequired' | 'validationTaskRequired' }> = {
  authorTask: { id: 'authorTaskId', required: 'authorTaskRequired' },
  validationTask: { id: 'validationTaskId', required: 'validationTaskRequired' },
  descriptionNode: { id: 'descriptionNodeId' },
};

type NodeFact = { id: string; is_runnable: boolean | null; deleted_at: Date | null; memory_id: string };

export interface OrgDefaultApplication {
  /** Rules written. */
  applied: number;
  /** Rules skipped for an unavailable reference, each with its record. */
  skipped: number;
}

/**
 * Apply the org's defaults to a memory just created in `tx`: after its root node, before the transaction commits.
 * Reads templates, references and the org's readable set once each (batched), never one query per rule.
 */
export async function applyOrgDefaultsAtCreation(
  tx: Tx,
  args: { memoryId: string; orgId: string; actor: string },
): Promise<OrgDefaultApplication> {
  const none: OrgDefaultApplication = { applied: 0, skipped: 0 };
  // The template rows, FOR SHARE, no join (findings:for-share-with-a-join-drops-concurrently-moved-rows), ordered by id.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "memory_config_templates"
    WHERE "organization_id" = ${args.orgId} AND "org_default" = true AND "deleted_at" IS NULL
    ORDER BY "id" FOR SHARE`;
  if (locked.length === 0) return none;
  // Re-read under the lock: a flag or delete committed while we waited is judged as committed.
  const templates = await tx.memoryConfigTemplate.findMany({
    where: { id: { in: locked.map((l) => l.id) }, organizationId: args.orgId, orgDefault: true, deletedAt: null },
  });
  if (templates.length === 0) return none;
  const rulesByTemplate = new Map<string, MemoryConfigTemplateRule[]>(templates.map((t) => [t.id, []]));
  for (const r of await tx.memoryConfigTemplateRule.findMany({
    where: { templateId: { in: templates.map((t) => t.id) } },
    orderBy: [{ templateId: 'asc' }, { role: 'asc' }],
  })) rulesByTemplate.get(r.templateId)!.push(r);

  // Every referenced node, FOR SHARE and ordered, then one org-readability query over their memories.
  const refIds = [
    ...new Set(
      [...rulesByTemplate.values()].flat().flatMap((r) => [r.authorTaskId, r.validationTaskId, r.descriptionNodeId]).filter((x): x is string => !!x),
    ),
  ].sort();
  const facts = new Map<string, NodeFact>();
  let readable = new Set<string>();
  if (refIds.length > 0) {
    // The node rows ALONE, as in lockRuleRefs: a join would drop a concurrently moved row.
    const rows = await tx.$queryRaw<NodeFact[]>`
      SELECT "id", "is_runnable", "deleted_at", "memory_id" FROM "nodes"
      WHERE "id" IN (${Prisma.join(refIds)}) ORDER BY "id" FOR SHARE`;
    for (const r of rows) facts.set(r.id, r);
    const memoryIds = [...new Set(rows.map((r) => r.memory_id))];
    readable = new Set(
      (await tx.memory.findMany({ where: { id: { in: memoryIds }, ...orgReadableWhere(args.orgId) }, select: { id: true } })).map((m) => m.id),
    );
  }
  const available = (id: string | null, task: boolean): boolean => {
    if (!id) return false;
    const f = facts.get(id);
    return !!f && !f.deleted_at && readable.has(f.memory_id) && (!task || f.is_runnable === true);
  };

  // Non-required first, then required; each by createdAt, then id.
  const ordered: MemoryConfigTemplate[] = [...templates].sort(
    (a, b) =>
      Number(a.required) - Number(b.required) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  type Planned = { template: MemoryConfigTemplate; rule: MemoryConfigTemplateRule; cols: ReturnType<typeof copiedColumns> };
  const byRole = new Map<string, Planned>();
  const skips: Prisma.MemoryConfigDefaultSkipCreateManyInput[] = [];
  for (const template of ordered) {
    for (const rule of rulesByTemplate.get(template.id) ?? []) {
      const cols = copiedColumns(rule);
      const bad: RefField[] = [];
      for (const field of ['authorTask', 'validationTask', 'descriptionNode'] as const) {
        const c = FIELD_COLUMNS[field];
        const id = rule[c.id];
        const atRest = c.required != null && rule[c.required] && !id; // already broken: the task was hard-deleted earlier
        if (atRest || (id && !available(id, field !== 'descriptionNode'))) bad.push(field);
      }
      if (bad.length > 0 && !template.required) {
        // Ruling 0200: a non-required default with an unavailable reference is skipped, with its concealed record.
        for (const field of bad) {
          skips.push({ id: generateId(), memoryId: args.memoryId, templateId: template.id, templateRuleId: rule.id, role: rule.role, field });
        }
        continue;
      }
      for (const field of bad) {
        // Required: fail closed. The id goes, the `*Required` marker stays set; a description is documentation only.
        const c = FIELD_COLUMNS[field];
        cols[c.id] = null;
        if (c.required) cols[c.required] = true;
      }
      const prior = byRole.get(rule.role);
      // A non-required default never displaces an earlier rule for the role; a required one always does (C5).
      if (prior && !template.required) continue;
      byRole.set(rule.role, { template, rule, cols });
    }
  }

  if (skips.length > 0) await tx.memoryConfigDefaultSkip.createMany({ data: skips });
  if (byRole.size === 0) return { applied: 0, skipped: skips.length };

  // The rulebook lock is taken inside materializeConfig, before the config can exist (#1400).
  const configId = await materializeConfig(tx, args.memoryId, args.actor);
  await tx.$queryRaw`SELECT 1 FROM "memory_configs" WHERE "id" = ${configId} FOR UPDATE`;
  for (const { template, rule, cols } of byRole.values()) {
    await tx.nodeRoleRule.create({
      data: {
        id: generateId(),
        configId,
        role: rule.role,
        ...cols,
        sourceTemplateId: template.id,
        locked: template.required,
        createdBy: args.actor,
        updatedBy: args.actor,
      },
    });
  }
  await touchConfig(tx, configId, args.actor);
  return { applied: byRole.size, skipped: skips.length };
}
