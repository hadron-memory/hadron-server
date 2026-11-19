/**
 * The template-rule reference helpers shared by applying a template to a memory (#1334) and the org defaults
 * (#3426). Their own module so the template, apply and org-default files import it without a cycle.
 */
import { GraphQLError } from 'graphql';
import type { MemoryConfigTemplateRule } from '../../../generated/prisma/index.js';
import type { ResolvedRef } from './resolvers.memoryConfig.js';

/** H5: a required task that has since been deleted. Copying it would plant a rule that refuses every use. */
export function refBroken(role: string, field: 'authorTask' | 'validationTask'): GraphQLError {
  return new GraphQLError(
    `The template's rule for role "${role}" points at a ${field === 'authorTask' ? 'author' : 'validation'} task that was deleted; repoint it in the template before applying.`,
    { extensions: { code: 'NODE_ROLE_RULE_REF_BROKEN', role, field } },
  );
}

/** The template rule's references, as the refs a create would re-check for the caller. */
export function refsOf(rule: MemoryConfigTemplateRule): ResolvedRef[] {
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
export function copiedColumns(rule: MemoryConfigTemplateRule) {
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
