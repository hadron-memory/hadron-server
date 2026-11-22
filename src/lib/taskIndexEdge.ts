/**
 * #4864 — what the task door (`createTaskNode` / `hadron_create_task`) adds to a create when asked for a tasks-index edge
 * and a skill export. The door stays ONE door (cor:acl:130:03): these are inputs it resolves, never a second operation.
 *
 * {@link resolveTaskIndexEdge} runs inside the node writer AFTER the memory's read and write checks and the task writer
 * level, so none of its refusals can tell a caller who may not write the memory anything about the Agent or its index. It
 * returns the one inline edge the writer then writes in its own transaction, by id, with the node: either both exist or
 * neither does (cor:dmo:050:15: an Agent's tasks are the incoming trigger-labelled edges of the node `Agent.tasksIndexRef`
 * names). Until the open question on that rule, "what the pointer may name", is ruled, the index must lie in the Agent's own
 * system memory and the task is created there too, so no cross-memory edge is ever written.
 *
 * {@link withClaudeSkillExport} is the opt-in skill export (Holger, 2026-10-28: no block by default). It merges an
 * enabled `exports.claudeSkill` block into the caller's properties and runs the existing skill lint over the result.
 */
import { GraphQLError } from 'graphql';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { resolveReadableAgentRefArg, refArgNotFoundError } from '../api/graphql/schema/resolvers.helpers.js';
import { EntityNotFoundError } from './entityRef/errors.js';
import { lintNode } from './skilldoc/lint.js';
import { HOST_CLAUDE_SKILL } from './skilldoc/hosts.js';

export type TaskIndexInput = { agent: string; trigger: string };
export type TaskSkillExportInput = { name: string; description: string };

export const TASKS_INDEX_NOT_SET = 'TASKS_INDEX_NOT_SET';
export const TASKS_INDEX_OUT_OF_SCOPE = 'TASKS_INDEX_OUT_OF_SCOPE';

const refuse = (message: string, code: string) => new GraphQLError(message, { extensions: { code } });

/** The inline edge (target = the Agent's tasks index node, name = the trigger) for a task created in `memoryId`. */
export async function resolveTaskIndexEdge(
  ctx: Context,
  memoryId: string,
  index: TaskIndexInput,
): Promise<{ targetId: string; name: string }> {
  const trigger = typeof index.trigger === 'string' ? index.trigger.trim() : '';
  if (!trigger) {
    throw new GraphQLError('index.trigger is required: the label the Agent\'s task list shows for this task.', { extensions: { code: 'BAD_USER_INPUT', field: 'index.trigger' } });
  }
  // Only a not-found signal reads as "no match for agentRef"; a database fault or any other error propagates as what it is
  // (#4864 blind F1). An Agent the caller may not read already answers as the same NOT_FOUND inside the resolver.
  let agent;
  try {
    agent = await resolveReadableAgentRefArg(ctx, index.agent);
  } catch (e) {
    if (e instanceof EntityNotFoundError) throw refArgNotFoundError('agent', String(index.agent));
    throw e;
  }
  if (!agent.tasksIndexRef) {
    throw refuse(`This Agent has no tasks index: set Agent.tasksIndexRef first (setAgentIndexRefs).`, TASKS_INDEX_NOT_SET);
  }
  const target = await ctx.db.node.findFirst({
    where: { id: agent.tasksIndexRef, deletedAt: null },
    select: { id: true, memoryId: true },
  });
  if (!target || target.memoryId !== agent.systemMemoryId || memoryId !== agent.systemMemoryId) {
    throw refuse(
      'A task is indexed only inside the Agent\'s own system memory: the tasks index must lie there and the task is created there.',
      TASKS_INDEX_OUT_OF_SCOPE,
    );
  }
  return { targetId: target.id, name: trigger };
}

/**
 * The properties a create carries once `skill` is applied: an enabled `exports.claudeSkill` block with the given name and
 * description, merged over any `exports` the caller already sent (other hosts and keys kept). A finding at error severity
 * from the skill lint refuses the call, and nothing is written.
 */
export function withClaudeSkillExport(
  properties: unknown,
  skill: TaskSkillExportInput,
  node: { loc: string; content: string },
): Record<string, unknown> {
  if (properties != null && (typeof properties !== 'object' || Array.isArray(properties))) {
    throw new GraphQLError('properties must be an object when the skill export is requested.', { extensions: { code: 'BAD_USER_INPUT', field: 'properties' } });
  }
  const base = (properties ?? {}) as Record<string, unknown>;
  const exportsIn = base.exports && typeof base.exports === 'object' && !Array.isArray(base.exports) ? (base.exports as Record<string, unknown>) : {};
  const merged = { ...base, exports: { ...exportsIn, [HOST_CLAUDE_SKILL]: { name: skill.name, description: skill.description, enable: true } } };
  const errors = lintNode({ urn: node.loc, loc: node.loc, memoryUrn: '', isRunnable: true, content: node.content, properties: merged })
    .filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    throw new GraphQLError(`The skill export is refused by the skill lint: ${errors.map((f) => f.message).join('; ')}`, {
      extensions: { code: 'BAD_USER_INPUT', field: 'skill', rules: errors.map((f) => f.rule) },
    });
  }
  return merged;
}
