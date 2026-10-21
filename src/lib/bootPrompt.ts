import { AsyncLocalStorage } from 'node:async_hooks';
import { GraphQLError } from 'graphql';
import { currentActor } from './requestActor.js';

/**
 * #2043 (S6, cor:agt:040:05, :11, :18) — the boot-prompt role and the
 * compiled-node write guard.
 *
 * `boot-prompt` is a PLAIN role (not a GOVERNED_KINDS entry): both the source
 * and the compiled node carry it. A compiled node is told apart by its
 * `nodeType`, the house precedent comments use. Two guards:
 *
 *  - A: a generic write never produces, edits or strips a compiled node.
 *       Only the compile (S9) writes one, through {@link withCompileWrite}.
 *  - B: a worker session never edits a boot prompt (cor:agt:040:11).
 */

export const BOOT_PROMPT_ROLE = 'boot-prompt';
export const COMPILED_BOOT_PROMPT_NODE_TYPE = 'compiled-boot-prompt';

/** Whether `role` is in the boot-prompt family: `boot-prompt` or `boot-prompt.*`. */
export function isBootPromptRole(role: string | null | undefined): boolean {
  return role === BOOT_PROMPT_ROLE || (typeof role === 'string' && role.startsWith(`${BOOT_PROMPT_ROLE}.`));
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
 * The worker session behind a git sync. The sync itself runs as the system
 * (#1610: its revisions name `system:github-sync`), so the requester is carried
 * here for guard B alone.
 */
const syncCallerScope = new AsyncLocalStorage<{ workerId: string | null }>();

/** Run a sync as the system while remembering which worker session asked for it. */
export function withSyncCaller<T>(workerId: string | null, fn: () => Promise<T>): Promise<T> {
  return syncCallerScope.run({ workerId }, fn);
}

/** The worker session behind this request: the actor, else the git sync's saved requester. */
export function boundWorkerId(): string | null {
  return currentActor().workerId ?? syncCallerScope.getStore()?.workerId ?? null;
}

function inCompileScope(): boolean {
  return compileScope.getStore() === true;
}

export function bootPromptCompiledWriteError(op: BootPromptOp, refusal: 'produces' | 'removes' | 'edits'): GraphQLError {
  const what = refusal === 'produces' ? 'create a compiled boot prompt'
    : refusal === 'removes' ? 'turn a compiled boot prompt into another node' : 'change a compiled boot prompt';
  return new GraphQLError(
    `BOOT_PROMPT_COMPILED_WRITE: a generic ${op} cannot ${what}. A compiled boot prompt is written only by a compile.`,
    { extensions: { code: 'BOOT_PROMPT_COMPILED_WRITE', kind: COMPILED_BOOT_PROMPT_NODE_TYPE, op, refusal } },
  );
}

/**
 * Guard A. Refuse a generic node write whose prior or requested type is the
 * compiled marker. `nextType` undefined means "unchanged".
 */
export function assertNotCompiledBootPromptWrite(
  priorType: string | null | undefined,
  nextType: string | null | undefined,
  op: BootPromptOp,
): void {
  if (inCompileScope()) return;
  const was = priorType === COMPILED_BOOT_PROMPT_NODE_TYPE;
  const willBe = nextType === COMPILED_BOOT_PROMPT_NODE_TYPE;
  if (!was && willBe) throw bootPromptCompiledWriteError(op, 'produces');
  if (was && !willBe && nextType != null) throw bootPromptCompiledWriteError(op, 'removes');
  if (was) throw bootPromptCompiledWriteError(op, 'edits');
}

export function bootPromptWorkerSessionError(op: BootPromptOp): GraphQLError {
  return new GraphQLError(
    `BOOT_PROMPT_WORKER_SESSION_REFUSED: a worker session never edits a boot prompt (${op}); its manager does it as themselves.`,
    { extensions: { code: 'BOOT_PROMPT_WORKER_SESSION_REFUSED', op } },
  );
}

/**
 * Guard B (cor:agt:040:11). Under a bound worker session, refuse a write whose
 * prior OR requested role is in the boot-prompt family, whatever the holder may
 * write, so a session cannot strip or add the role to edit around the rule.
 * `nextRole` undefined means "unchanged".
 */
export function assertNoWorkerSessionBootPromptWrite(
  priorRole: string | null | undefined,
  nextRole: string | null | undefined,
  op: BootPromptOp,
): void {
  if (inCompileScope()) return;
  if (!boundWorkerId()) return;
  if (isBootPromptRole(priorRole) || isBootPromptRole(nextRole === undefined ? priorRole : nextRole)) {
    throw bootPromptWorkerSessionError(op);
  }
}

/** Both guards at one site, for a node's prior row and the requested change. */
export function assertBootPromptWriteAllowed(
  prior: { nodeType?: string | null; role?: string | null } | null | undefined,
  next: { nodeType?: string | null; role?: string | null },
  op: BootPromptOp,
): void {
  assertNotCompiledBootPromptWrite(prior?.nodeType, next.nodeType, op);
  assertNoWorkerSessionBootPromptWrite(prior?.role, next.role, op);
}

/** Prisma `where` for the boot-prompt role family. */
export const BOOT_PROMPT_ROLE_WHERE: { OR: Array<{ role: string | { startsWith: string } }> } = {
  OR: [{ role: BOOT_PROMPT_ROLE }, { role: { startsWith: `${BOOT_PROMPT_ROLE}.` } }],
};

type NodeReader = { node: { findMany: (args: any) => Promise<Array<{ nodeType: string | null; role: string | null }>> } };

/**
 * Guard A and B over a set of existing node ids (delete, move, bulk): refuse
 * when any is compiled, or, under a worker session, in the boot-prompt family.
 */
export async function assertNoBootPromptRows(db: NodeReader, nodeIds: string[], op: BootPromptOp): Promise<void> {
  if (nodeIds.length === 0 || inCompileScope()) return;
  const rows = await db.node.findMany({
    where: { id: { in: nodeIds }, OR: [{ nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE }, BOOT_PROMPT_ROLE_WHERE] },
    select: { nodeType: true, role: true },
  });
  for (const r of rows) assertBootPromptWriteAllowed(r, { nodeType: undefined, role: undefined }, op);
}

/**
 * A worker session's whole-memory copy or merge: refused when the source holds
 * any live boot-prompt node, source or compiled (cor:agt:040:11). A no-op for
 * any other caller, whose copy simply excludes compiled nodes.
 */
export async function assertNoBootPromptRowsForWorkerSession(
  db: NodeReader & { node: { findFirst: (args: any) => Promise<unknown> } },
  memoryId: string,
  op: BootPromptOp,
): Promise<void> {
  if (!boundWorkerId() || inCompileScope()) return;
  const hit = await db.node.findFirst({
    where: { memoryId, deletedAt: null, OR: [{ nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE }, BOOT_PROMPT_ROLE_WHERE] },
    select: { id: true },
  });
  if (hit) throw bootPromptWorkerSessionError(op);
}

/**
 * A merge folds a source node onto the target node at the same loc. Refuse,
 * before anything commits, when that target is a compiled boot prompt (only a
 * compile writes one) or, under a worker session, a boot-prompt source
 * (cor:agt:040:11). Source-only checks miss this: the written node is the target's.
 */
export async function assertNoBootPromptMergeCollisions(
  db: { node: { findFirst: (args: any) => Promise<unknown>; findMany: (args: any) => Promise<Array<{ nodeType: string | null; role: string | null; loc: string }>> } },
  sourceMemoryId: string,
  targetMemoryId: string,
): Promise<void> {
  if (inCompileScope()) return;
  const targets = await db.node.findMany({
    where: { memoryId: targetMemoryId, deletedAt: null, OR: [{ nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE }, BOOT_PROMPT_ROLE_WHERE] },
    select: { nodeType: true, role: true, loc: true },
  });
  const relevant = targets.filter((t) => t.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE || boundWorkerId());
  if (relevant.length === 0) return;
  const collides = await db.node.findFirst({
    where: { memoryId: sourceMemoryId, deletedAt: null, loc: { in: relevant.map((t) => t.loc) }, nodeType: { notIn: ['comment', COMPILED_BOOT_PROMPT_NODE_TYPE] } },
    select: { loc: true },
  });
  if (!collides) return;
  const hit = relevant.find((t) => t.loc === (collides as { loc: string }).loc)!;
  assertBootPromptWriteAllowed(hit, {}, 'merge');
}
