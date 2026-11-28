/**
 * #5485 (Holger, 2026-11-28; the Proposed lines of cor:dmo:020:04 and cor:api:090:02) — the instruction role
 * families, and the task role family.
 *
 * The platform holds two classes of content: knowledge, which is inert, and instructions for an LLM, which act.
 * Node type `system` is the instruction class and the ROLE names the kind. The kinds are these families, listed
 * once here; the boot-prompt predicates of #5453 live beside them in `bootPrompt.ts`.
 *
 * A task is still the runnable capability: `isRunnable` is what makes a node a task for role rules, running and
 * governance. The `task` role is added BESIDE it and removes or weakens no `isRunnable` check. The database holds
 * one direction only: a task-family role implies runnable (`chk_nodes_task_role_runnable`).
 */

/** The role of a task: the base of the family. */
export const TASK_ROLE = 'task';
/** The role of a task that stands for a role: what `role-task` was called before #5485. */
export const TASK_ROLE_ROLE = 'task.role';
/** The role clients wrote for a role task before #5485. The migration renames every runnable row that carries it. */
export const LEGACY_ROLE_TASK_ROLE = 'role-task';
/** The role of a process, and the base of its family (cor:dmo:020:06). */
export const PROCESS_ROLE = 'process';
/** The node type of every instruction node in an Agent system memory or install memory (stage 1 of the retype). */
export const INSTRUCTION_NODE_TYPE = 'system';

/**
 * The instruction role families: the ONE list behind the lift of the `system` default (cor:api:090:02). A filter
 * naming one of these, or `isRunnable: true`, is an explicit ask for instructions.
 */
export const INSTRUCTION_ROLE_FAMILIES: readonly string[] = Object.freeze(['task', 'process', 'prompt', 'chatbot']);

/** Whether `role` is `family` or a dotted descendant of it. */
function inFamily(role: string | null | undefined, family: string): boolean {
  return typeof role === 'string' && (role === family || role.startsWith(`${family}.`));
}

/** Whether `role` is in an instruction family (task, process, prompt, chatbot). */
export function isInstructionRole(role: string | null | undefined): boolean {
  return INSTRUCTION_ROLE_FAMILIES.some((family) => inFamily(role, family));
}

/** Whether `role` is the task family: `task` or `task.*`. The database rule keys on exactly this. */
export function isTaskRole(role: string | null | undefined): boolean {
  return inFamily(role, TASK_ROLE);
}

/** Whether `role` is the process family: `process` or `process.*`. */
export function isProcessFamilyRole(role: string | null | undefined): boolean {
  return inFamily(role, PROCESS_ROLE);
}

/**
 * Whether a node filter is an explicit ask for instructions: `isRunnable: true`, or a `role` in an instruction
 * family. Read by `defaultExcludedNodeTypes`, the one function every default site asks.
 */
export function asksForInstructions(filter: { isRunnable?: unknown; role?: unknown } | null | undefined): boolean {
  if (!filter) return false;
  return filter.isRunnable === true || (typeof filter.role === 'string' && isInstructionRole(filter.role));
}

/**
 * What a capture made BEFORE #5485 is written back as: the role `role-task` becomes `task.role`, and, in an Agent
 * system memory (`systemPlacement`), a node typed `task`, or typed `info` with a task or process role, becomes
 * `system`. A capture in today's form, and every other row, comes back as it is. Runs after `modernBootPromptKind`.
 *
 * `isRunnable` is what the capture knew (undefined when it knew nothing, as an Agent snapshot does): a role that
 * is a task role is written only for a node that was a task, and `role-task` was only ever on one.
 */
export function modernTaskKind<T extends { nodeType?: string | null; role?: string | null }>(
  captured: T,
  opts: { isRunnable?: boolean | null; systemPlacement?: boolean } = {},
): T {
  const role = captured.role === LEGACY_ROLE_TASK_ROLE && opts.isRunnable !== false ? TASK_ROLE_ROLE
    : captured.role == null && opts.isRunnable === true ? TASK_ROLE
    : captured.role;
  const isInstruction = isTaskRole(role) || isProcessFamilyRole(role);
  const retype = opts.systemPlacement === true
    && (captured.nodeType === 'task' || (captured.nodeType === 'info' && isInstruction));
  if (role === captured.role && !retype) return captured;
  return { ...captured, role, ...(retype ? { nodeType: INSTRUCTION_NODE_TYPE } : {}) };
}

/**
 * #5485 Ask 1 — the role a task door writes. The doors are the statement of intent, so a runnable node written
 * through one CREATE carries the role `task` when it would otherwise have none; a task retired through its door
 * (`isRunnable` cleared) leaves no task-family role behind, because the database refuses one on a row that is not
 * runnable. `undefined` means "leave the input's role as it is". A role the caller names is never replaced.
 */
export function taskDoorRole(
  mode: 'create' | 'update',
  existing: { role?: string | null; isRunnable?: boolean | null } | null | undefined,
  input: { role?: string | null; isRunnable?: boolean | null },
): string | null | undefined {
  const runnable = (input.isRunnable === undefined ? existing?.isRunnable : input.isRunnable) === true;
  const role = input.role === undefined ? (existing?.role ?? null) : input.role;
  // An update of a node that is already runnable and has no role is left as it is: the next migration-style pass gives it its role.
  if (runnable) return mode === 'create' && role == null ? TASK_ROLE : undefined;
  return input.role === undefined && isTaskRole(role) ? null : undefined;
}
