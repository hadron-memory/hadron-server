import { AsyncLocalStorage } from 'node:async_hooks';
import { GraphQLError } from 'graphql';
import { currentActor } from './requestActor.js';

/**
 * #2043 (S6, cor:agt:040:05, :11, :18), re-keyed by #5453 — the boot-prompt role
 * family and the compiled-node write guard.
 *
 * `boot-prompt` is a PLAIN role family (not a GOVERNED_KINDS entry). Every node in
 * it is type `system`, and the LEAF of the role says which kind it is (#5453,
 * Holger 2026-11-27; the dotted sub-kind convention of cor:acl:130:01):
 *
 *   boot-prompt.compiled   the compiled prompt (written only by a compile)
 *   boot-prompt.source     the source a compile reads
 *   boot-prompt.rule       a rule a source includes
 *   boot-prompt            the bare legacy role: a source (a mirrored file may still write it)
 *
 * Until #5453 the compiled node was told apart by a node type of its own and
 * source and compiled both carried the bare role. That type is retired: the
 * migration 20261128010000_definition_node_roles leaves no row holding it and the
 * CHECK in prisma/boot-prompt-invariants.sql keeps it out. One guard:
 *
 *  - A: a generic write never produces, edits or strips a compiled node.
 *       Only the compile (S9) writes one, through {@link withCompileWrite}.
 *
 * There was a second, B: a worker session never wrote a boot prompt (cor:agt:040:11, ruling 0267), on every
 * door, whatever its holder could write. #5453 Ask 5 removed it (Holger, 2026-11-27: "The workers must be able
 * to update their boot prompts. [...] The humans then must approve them."; decision record
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-27-holger-rulings-to-bo-system-nodes-and-roles,
 * section 4b). A worker session now writes a source and a rule wherever the memory's own write gate admits
 * it, as it writes any other node there, with no grant. What still holds a worker session back is approval
 * (src/lib/bootPromptApproval.ts) and guard A, which asks nothing about who is calling.
 */

export const BOOT_PROMPT_ROLE = 'boot-prompt';
/** The compiled prompt. Matched EXACTLY: it is the mark guard A, the pointers and the serve rest on. */
export const BOOT_PROMPT_COMPILED_ROLE = 'boot-prompt.compiled';
/** The source a compile reads at the source address. */
export const BOOT_PROMPT_SOURCE_ROLE = 'boot-prompt.source';
/** A rule a source includes. In the family (#5453 ruling 4a); never a source and never a pointer target. */
export const BOOT_PROMPT_RULE_ROLE = 'boot-prompt.rule';
/** The rule role before #5453: a plain role outside the family. The migration renames every row that carries it. */
export const LEGACY_BOOT_PROMPT_RULE_ROLE = 'boot-prompt-rule';
/** The node type of every boot-prompt node the platform writes, as of every other node that defines an Agent (#5453). */
export const BOOT_PROMPT_NODE_TYPE = 'system';
/**
 * The node type a compiled prompt carried before #5453. No row holds it and the database refuses it
 * (`chk_nodes_compiled_boot_prompt_kind`). It is named here for two readers only: a write that asks for it is
 * refused with guard A's own code before it reaches the CHECK, and a snapshot captured before the migration is
 * still read as a compiled prompt.
 */
export const RETIRED_COMPILED_BOOT_PROMPT_NODE_TYPE = 'compiled-boot-prompt';

/** Whether `role` is in the boot-prompt family: `boot-prompt` or `boot-prompt.*`. A rule is in it. */
export function isBootPromptRole(role: string | null | undefined): boolean {
  return role === BOOT_PROMPT_ROLE || (typeof role === 'string' && role.startsWith(`${BOOT_PROMPT_ROLE}.`));
}

/** Whether `role` marks a compiled boot prompt. Exact: no sub-kind of it is one. */
export function isCompiledBootPromptRole(role: string | null | undefined): boolean {
  return role === BOOT_PROMPT_COMPILED_ROLE;
}

/** Whether `row` is a compiled boot prompt. The role decides; the node type no longer does (#5453). */
export function isCompiledBootPrompt(row: { role: string | null | undefined } | null | undefined): boolean {
  return isCompiledBootPromptRole(row?.role);
}

/** Whether `role` is the rule leaf. Exact, so an unknown sub-kind stays under the stricter rules of a boot prompt itself. */
export function isBootPromptRuleRole(role: string | null | undefined): boolean {
  return role === BOOT_PROMPT_RULE_ROLE;
}

/**
 * Whether `role` is the boot prompt ITSELF: in the family and not a rule (a source, a compiled prompt, the bare
 * legacy role, and any sub-kind this code does not know). The check that cannot mean a rule uses it: a base
 * Agent's boot prompt is never inherited (a base's rule is: derived Agents include it).
 */
export function isBootPromptItselfRole(role: string | null | undefined): boolean {
  return isBootPromptRole(role) && !isBootPromptRuleRole(role);
}

/**
 * Whether `role` is valid at a source address (cor:agt:040:12): in the family, not compiled and not a rule.
 * The bare `boot-prompt` passes, so a mirrored source that still carries it compiles (#5453 Ask 3).
 */
export function isBootPromptSourceRole(role: string | null | undefined): boolean {
  return isBootPromptItselfRole(role) && !isCompiledBootPromptRole(role);
}

/**
 * What a row captured BEFORE #5453 is written back as (a node revision, an Agent snapshot): the retired compiled
 * type becomes `system` / `boot-prompt.compiled`, the bare role a source, the old rule role the rule leaf. A row
 * already in today's form, and every other row, comes back as it is. A capture that holds no node type (a
 * pre-#620 revision) restores no type either: only its role is brought forward.
 */
export function modernBootPromptKind<T extends { nodeType?: string | null; role?: string | null }>(captured: T): T {
  if (captured.nodeType === RETIRED_COMPILED_BOOT_PROMPT_NODE_TYPE) {
    return { ...captured, nodeType: BOOT_PROMPT_NODE_TYPE, role: BOOT_PROMPT_COMPILED_ROLE };
  }
  const role = captured.role === BOOT_PROMPT_ROLE ? BOOT_PROMPT_SOURCE_ROLE
    : captured.role === LEGACY_BOOT_PROMPT_RULE_ROLE ? BOOT_PROMPT_RULE_ROLE : null;
  if (role === null) return captured;
  return { ...captured, role, ...(captured.nodeType == null ? {} : { nodeType: BOOT_PROMPT_NODE_TYPE }) };
}

export type BootPromptOp = 'create' | 'update' | 'delete' | 'move' | 'merge' | 'restore' | 'import' | 'clone' | 'replace';

/**
 * Compile scope. Module-private: the only way past guard A is
 * {@link withCompileWrite}, which no GraphQL argument or MCP parameter can
 * reach (a scan test pins that). S9 (#2046) is its only production caller.
 */
const compileScope = new AsyncLocalStorage<true>();

/** Run `fn` as the compile: guard A stands down for its writes. */
export function withCompileWrite<T>(fn: () => Promise<T>): Promise<T> {
  return compileScope.run(true, fn);
}

/**
 * The worker session behind this request, from the request's published actor. A Git sync runs as the system
 * (#1610: its revisions name `system:github-sync`), so nothing inside one is bound to a worker: until #5453 the
 * requester was carried into the sync for guard B alone, and went with it.
 */
export function boundWorkerId(): string | null {
  return currentActor().workerId ?? null;
}

/** Whether the caller is inside {@link withCompileWrite}: the compile, and nothing a request can reach. */
export function inCompileScope(): boolean {
  return compileScope.getStore() === true;
}

export function bootPromptCompiledWriteError(op: BootPromptOp, refusal: 'produces' | 'removes' | 'edits'): GraphQLError {
  const what = refusal === 'produces' ? 'create a compiled boot prompt'
    : refusal === 'removes' ? 'turn a compiled boot prompt into another node' : 'change a compiled boot prompt';
  return new GraphQLError(
    `BOOT_PROMPT_COMPILED_WRITE: a generic ${op} cannot ${what}. A compiled boot prompt is written only by a compile.`,
    { extensions: { code: 'BOOT_PROMPT_COMPILED_WRITE', kind: BOOT_PROMPT_COMPILED_ROLE, op, refusal } },
  );
}

/**
 * Guard A. Refuse a generic node write whose prior or requested ROLE is the compiled marker (#5453: the marker
 * moved from the node type to the role; the three refusals and the code are unchanged). `nextRole` undefined
 * means "unchanged"; `null` and any other role strip the marker. A write that asks for the retired node type is
 * a `produces` too, so it is refused here with the guard's code and never reaches the database CHECK.
 */
export function assertNotCompiledBootPromptWrite(
  priorRole: string | null | undefined,
  nextRole: string | null | undefined,
  op: BootPromptOp,
  nextType?: string | null,
): void {
  if (inCompileScope()) return;
  const was = isCompiledBootPromptRole(priorRole);
  const willBe = isCompiledBootPromptRole(nextRole) || nextType === RETIRED_COMPILED_BOOT_PROMPT_NODE_TYPE;
  if (!was && willBe) throw bootPromptCompiledWriteError(op, 'produces');
  if (was && nextRole !== undefined && !isCompiledBootPromptRole(nextRole)) throw bootPromptCompiledWriteError(op, 'removes');
  if (was) throw bootPromptCompiledWriteError(op, 'edits');
}

/**
 * Guard A at a write site, for a node's prior row and the requested change. `prior.role` is REQUIRED, not
 * optional: the compiled marker is the role now, so a caller that did not read the role does not type-check.
 * It judges the node and never the caller (#5453 Ask 5): a worker session gets the answer anyone gets.
 */
export function assertBootPromptWriteAllowed(
  prior: { role: string | null } | null | undefined,
  next: { nodeType?: string | null; role?: string | null },
  op: BootPromptOp,
): void {
  assertNotCompiledBootPromptWrite(prior?.role, next.role, op, next.nodeType);
}

/** Prisma `where` for the boot-prompt role family (a rule included). */
export const BOOT_PROMPT_ROLE_WHERE: { OR: Array<{ role: string | { startsWith: string } }> } = {
  OR: [{ role: BOOT_PROMPT_ROLE }, { role: { startsWith: `${BOOT_PROMPT_ROLE}.` } }],
};

/** Prisma `where` for a compiled boot prompt. */
export const COMPILED_BOOT_PROMPT_WHERE: { role: string } = { role: BOOT_PROMPT_COMPILED_ROLE };

/**
 * Prisma `where` for every node that is NOT a compiled boot prompt. `role` is nullable and SQL's `<>` is not
 * true for NULL, so a bare `{ role: { not: … } }` would also drop every node that has no role: the NULL arm is
 * spelled out. Put it under `AND` wherever the surrounding filter has an `OR` of its own.
 */
export const NOT_COMPILED_BOOT_PROMPT_WHERE: { OR: [{ role: null }, { role: { not: string } }] } = {
  OR: [{ role: null }, { role: { not: BOOT_PROMPT_COMPILED_ROLE } }],
};

type NodeReader = { node: { findMany: (args: any) => Promise<Array<{ role: string | null }>> } };

/**
 * Guard A over a set of existing node ids (delete, move, bulk): refuse when any is a compiled boot prompt.
 * The rows are read by the family and judged by the guard, so the rule stays in one place.
 */
export async function assertNoBootPromptRows(db: NodeReader, nodeIds: string[], op: BootPromptOp): Promise<void> {
  if (nodeIds.length === 0 || inCompileScope()) return;
  const rows = await db.node.findMany({
    where: { id: { in: nodeIds }, ...BOOT_PROMPT_ROLE_WHERE },
    select: { role: true },
  });
  for (const r of rows) assertBootPromptWriteAllowed(r, { nodeType: undefined, role: undefined }, op);
}

/**
 * A merge folds a source node onto the target node at the same loc. Refuse,
 * before anything commits, when that target is a compiled boot prompt (only a
 * compile writes one). Source-only checks miss this: the written node is the target's.
 * A fold onto a source or a rule of the target is an ordinary write of that node (#5453 Ask 5).
 */
export async function assertNoBootPromptMergeCollisions(
  db: { node: { findFirst: (args: any) => Promise<unknown>; findMany: (args: any) => Promise<Array<{ role: string | null; loc: string }>> } },
  sourceMemoryId: string,
  targetMemoryId: string,
): Promise<void> {
  if (inCompileScope()) return;
  const targets = await db.node.findMany({
    where: { memoryId: targetMemoryId, deletedAt: null, ...BOOT_PROMPT_ROLE_WHERE },
    select: { role: true, loc: true },
  });
  const relevant = targets.filter((t) => isCompiledBootPrompt(t));
  if (relevant.length === 0) return;
  const collides = await db.node.findFirst({
    where: { memoryId: sourceMemoryId, deletedAt: null, loc: { in: relevant.map((t) => t.loc) }, nodeType: { not: 'comment' }, AND: [NOT_COMPILED_BOOT_PROMPT_WHERE] },
    select: { loc: true },
  });
  if (!collides) return;
  const hit = relevant.find((t) => t.loc === (collides as { loc: string }).loc)!;
  assertBootPromptWriteAllowed(hit, {}, 'merge');
}
