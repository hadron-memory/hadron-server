/**
 * #2045 (S8, cor:agt:040:07) — the three boot-prompt POINTERS: `Agent`,
 * `AppAgent` (the install) and `Worker`, each naming a compiled boot-prompt
 * node, never its source.
 *
 * One module, so the read fields, S9's compile (#2046), S10's serve (#2047) and
 * S11's lint (#2048) cannot drift:
 *
 *  - {@link resolveBootPromptPointer}: the ONE derivation of what a stored
 *    pointer names now (live / soft-deleted / hard-deleted, moved or not).
 *  - {@link assertMayWriteBootPromptPointer}: the authority gate (R23).
 *  - {@link validateBootPromptPointer}: the target checks, run only AFTER the
 *    gate so a caller who may not write learns nothing about the target.
 *  - {@link setBootPromptPointer}: gate, then validate, then write, in the
 *    caller's transaction. The only writer of the pointer columns.
 *
 * Approval is NOT checked here: a valid unapproved pointer is accepted, and
 * whether it may be SERVED is S10's serve-time check (cor:agt:040:10). Nothing
 * in this module serves, and nothing here reads `Agent.systemPrompt` or
 * `Worker.promptOverride` (those retire at S10's activation).
 */
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { lockWorkersForAssignment } from './agentTasks/workerLock.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, isBootPromptRole } from './bootPrompt.js';
import { currentActor, currentActorAmbiguity } from './requestActor.js';
import { managesAgent, managesApp, type AppManagerCaller } from './auth/appManagement.js';
import { isRunPrincipal } from './auth/runPrincipal.js';
import { authorizationDenied } from './auth/authorizationDenied.js';
import { resolveNodeRef, isConcealedNodeRefAmbiguity } from './entityRef/nodeRef.js';
import { NodeNotFoundError } from './entityRef/errors.js';
import { UrnNotQualifiedError, UrnParseError } from './urn.js';
import { safeNodeUrnV2 } from './urnEmit.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type BootPromptPointerField = 'AGENT' | 'APP_AGENT' | 'WORKER';

/**
 * The write-time refusal codes, the closed list agreed on #2045 (6259928375).
 * The generic `FORBIDDEN`, `BAD_USER_INPUT` and the owner's own not-found are
 * shared codes and so not listed. Serve-time codes (`BOOT_PROMPT_NOT_SET`,
 * `BOOT_PROMPT_TARGET_DELETED`, …) belong to S10 and are never raised here; a
 * deleted target at WRITE time is `BOOT_PROMPT_POINTER_NOT_FOUND`.
 */
export const BOOT_PROMPT_POINTER_CODES = [
  'BOOT_PROMPT_POINTER_SESSION_REFUSED',
  'BOOT_PROMPT_POINTER_NOT_FOUND',
  'BOOT_PROMPT_POINTER_NOT_COMPILED',
  'BOOT_PROMPT_POINTER_WRONG_ROLE',
  'BOOT_PROMPT_POINTER_WRONG_MEMORY',
] as const;
export type BootPromptPointerCode = (typeof BOOT_PROMPT_POINTER_CODES)[number];

type AppOwnerCols = { id: string; organizationId: string | null; ownerUserId: string | null };

/**
 * Whose pointer is being written. Callers pass rows they re-read inside the
 * deciding transaction; the gate and the placement check use exactly these.
 */
export type BootPromptPointerOwner =
  | { field: 'AGENT'; agent: { id: string; organizationId: string | null; ownerUserId: string | null; systemMemoryId: string | null } }
  | { field: 'APP_AGENT'; app: AppOwnerCols; agentId: string }
  | { field: 'WORKER'; app: AppOwnerCols; worker: { id: string; agentId: string } };

/** Which pointer to write, by id. */
export type BootPromptPointerTarget =
  | { field: 'AGENT'; agentId: string }
  | { field: 'APP_AGENT'; appId: string; agentId: string }
  | { field: 'WORKER'; workerId: string };

const APP_OWNER_SELECT = { id: true, organizationId: true, ownerUserId: true } as const;

/**
 * Re-read a pointer's owner INSIDE the deciding transaction, after the
 * caller's anchors are held, so the gate and the placement check judge the
 * rows as they are now. Null when the owner is gone: a deleted Agent, an
 * uninstalled Agent (the AppAgent row is hard-deleted), a deleted or
 * uninstalled App, or no such worker. The caller answers null with the
 * owner's own not-found.
 */
export async function loadBootPromptPointerOwner(
  tx: Db,
  target: BootPromptPointerTarget,
): Promise<BootPromptPointerOwner | null> {
  const db = tx as PrismaClient;
  const liveApp = { deletedAt: null, uninstalledAt: null };
  if (target.field === 'AGENT') {
    const agent = await db.agent.findFirst({
      where: { id: target.agentId, deletedAt: null },
      select: { id: true, organizationId: true, ownerUserId: true, systemMemoryId: true },
    });
    return agent ? { field: 'AGENT', agent } : null;
  }
  if (target.field === 'APP_AGENT') {
    const row = await db.appAgent.findFirst({
      where: { appId: target.appId, agentId: target.agentId, app: liveApp },
      select: { agentId: true, app: { select: APP_OWNER_SELECT } },
    });
    return row ? { field: 'APP_AGENT', app: row.app, agentId: row.agentId } : null;
  }
  // #2458: changeWorkerAgent may now land while this worker has an open session, so the placement check below must judge
  // the agent the worker casts when this write commits. Same order as the change: assignment lock, the Agent row FOR
  // SHARE, then the Worker row FOR UPDATE; the agent is re-read once the assignment lock (which the change holds) is ours.
  if (!(await db.worker.findFirst({ where: { id: target.workerId, app: liveApp }, select: { id: true } }))) return null;
  await lockWorkersForAssignment(tx as Prisma.TransactionClient, [target.workerId]);
  const current = await db.worker.findUnique({ where: { id: target.workerId }, select: { agentId: true } });
  if (!current) return null;
  await tx.$queryRaw`SELECT id FROM agents WHERE id = ${current.agentId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM workers WHERE id = ${target.workerId} FOR UPDATE`;
  const worker = await db.worker.findFirst({
    where: { id: target.workerId, app: liveApp },
    select: { id: true, agentId: true, app: { select: APP_OWNER_SELECT } },
  });
  return worker ? { field: 'WORKER', app: worker.app, worker: { id: worker.id, agentId: worker.agentId } } : null;
}

/** A stored pointer: the two columns every owner table carries. */
export type StoredBootPromptPointer = { bootPromptNodeId: string | null; bootPromptUrn: string | null };

/** What a set pointer names now. `deleted` is true for a soft-deleted node, a node in a deleted memory, or a row that is gone. */
export type ResolvedBootPromptPointer = { nodeId: string; urn: string; deleted: boolean };

/** The caller fields the gate reads: a structural slice of the GraphQL Context. */
export type BootPromptPointerCaller = AppManagerCaller & {
  clientId?: string | null;
  appKeyId?: string | null;
  sessionBindingRefused?: boolean;
};

function pointerError(code: BootPromptPointerCode, message: string, extensions: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(`${code}: ${message}`, { extensions: { code, ...extensions } });
}

const notFound = () =>
  pointerError('BOOT_PROMPT_POINTER_NOT_FOUND', 'no compiled boot prompt you can read has that ref.');

/**
 * The ONE derivation of what a stored pointer names (#2045 6259771731), shared
 * by the read fields, S10's serve-time R27 refusal and S11's lint.
 *
 *  - no pointer → `null`;
 *  - a live node → its CURRENT canonical URN (so a move is followed), `deleted: false`;
 *  - a soft-deleted node, or one whose memory is deleted → its current URN, `deleted: true`;
 *  - a hard-deleted node (no row) → the URN snapshot taken at write time, `deleted: true`.
 *
 * Never falls back to anything: a set-but-deleted pointer is not "no pointer".
 */
export async function resolveBootPromptPointer(
  db: Db,
  row: StoredBootPromptPointer,
): Promise<ResolvedBootPromptPointer | null> {
  if (row.bootPromptNodeId === null) return null;
  const node = await (db as PrismaClient).node.findUnique({
    where: { id: row.bootPromptNodeId },
    select: { id: true, loc: true, deletedAt: true, memory: { select: { urn: true, deletedAt: true } } },
  });
  if (!node) {
    // The CHECK keeps the pair together, so a set id always has its snapshot.
    return { nodeId: row.bootPromptNodeId, urn: row.bootPromptUrn ?? '', deleted: true };
  }
  return {
    nodeId: node.id,
    urn: safeNodeUrnV2(node.memory.urn, node.loc),
    deleted: node.deletedAt !== null || node.memory.deletedAt !== null,
  };
}

/**
 * The authority gate (R23, #2045 6258606109 §1): the owner's manager, acting
 * as themselves. Runs on the OWNER alone, before any target ref is looked at
 * (6259771731), so its refusals name nothing about the target.
 *
 *  - A request bound to a worker session, a manager's own included, an
 *    ambiguous multi-binding, or a named session that failed to validate:
 *    `BOOT_PROMPT_POINTER_SESSION_REFUSED`. A worker session never sets a
 *    pointer; a failed binding must not silently become its human driver.
 *  - No user, an impersonation, an App key or an AppRun principal: `FORBIDDEN`.
 *    None of them is "a manager as themselves".
 *  - `AGENT`: {@link managesAgent}. `APP_AGENT` / `WORKER`: {@link managesApp}
 *    on the App. Holding a customised worker grants nothing.
 *
 * Pass the transaction context (`liveTxContext`) so the roles and memberships
 * are read under the caller's held anchors.
 */
export async function assertMayWriteBootPromptPointer(
  ctx: BootPromptPointerCaller,
  owner: BootPromptPointerOwner,
): Promise<void> {
  if (currentActor().workerId !== null || currentActorAmbiguity() !== null || ctx.sessionBindingRefused) {
    throw pointerError(
      'BOOT_PROMPT_POINTER_SESSION_REFUSED',
      'a worker session never sets a boot-prompt pointer; its manager does it as themselves, without a session.',
    );
  }
  if (!ctx.userId || ctx.impersonation || ctx.appKeyId || isRunPrincipal(ctx)) throw authorizationDenied();
  const manages = owner.field === 'AGENT' ? await managesAgent(ctx, owner.agent) : await managesApp(ctx, owner.app);
  if (!manages) throw authorizationDenied();
}

/**
 * The target checks (#2045 6247095524 §1), for a caller who already passed
 * {@link assertMayWriteBootPromptPointer}. In order:
 *
 *  1. the ref parses (a node id or a fully-qualified node URN), else `BAD_USER_INPUT`;
 *  2. it names a LIVE node in a live memory the caller may read, else
 *     `BOOT_PROMPT_POINTER_NOT_FOUND` (an unreadable node answers exactly like a missing one);
 *  3. the node is compiled, else `BOOT_PROMPT_POINTER_NOT_COMPILED`;
 *  4. its role is in the boot-prompt family, else `BOOT_PROMPT_POINTER_WRONG_ROLE`
 *     (the S6 CHECK makes this unreachable for a compiled node; kept as defence);
 *  5. it sits where this field's prompt lives, else `BOOT_PROMPT_POINTER_WRONG_MEMORY`:
 *     the Agent's OWN system memory (never a base Agent's, never another's), or
 *     the install memory of THIS (App, Agent) for the install and worker pointers.
 *
 * `canReadMemory` is the caller's shared memory read gate, asked fresh inside the transaction.
 */
export async function validateBootPromptPointer(
  tx: Db,
  owner: BootPromptPointerOwner,
  nodeRef: string,
  canReadMemory: (memoryId: string) => Promise<boolean>,
): Promise<{ id: string; urn: string }> {
  let id: string;
  try {
    ({ id } = await resolveNodeRef(tx as PrismaClient, nodeRef));
  } catch (e) {
    if (e instanceof UrnNotQualifiedError || e instanceof UrnParseError) {
      throw new GraphQLError(`nodeRef "${nodeRef}" is not a node id or a fully-qualified node URN.`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (e instanceof NodeNotFoundError) throw notFound();
    if (await isConcealedNodeRefAmbiguity(tx as PrismaClient, e, canReadMemory)) throw notFound();
    throw e;
  }
  const node = await (tx as PrismaClient).node.findFirst({
    where: { id, deletedAt: null, memory: { deletedAt: null } },
    select: { id: true, loc: true, memoryId: true, nodeType: true, role: true, memory: { select: { urn: true } } },
  });
  if (!node || !(await canReadMemory(node.memoryId))) throw notFound();
  if (node.nodeType !== COMPILED_BOOT_PROMPT_NODE_TYPE) {
    throw pointerError('BOOT_PROMPT_POINTER_NOT_COMPILED', 'a pointer names a compiled boot prompt, never its source.');
  }
  if (!isBootPromptRole(node.role)) {
    throw pointerError('BOOT_PROMPT_POINTER_WRONG_ROLE', 'the target does not have the boot-prompt role.');
  }
  const placement = await expectedPromptMemoryId(tx, owner);
  if (placement === null || node.memoryId !== placement) {
    throw pointerError(
      'BOOT_PROMPT_POINTER_WRONG_MEMORY',
      owner.field === 'AGENT'
        ? "an Agent's pointer names a compiled prompt in that Agent's own system memory."
        : "an install's or worker's pointer names a compiled prompt in that App's install memory for the Agent.",
      { field: owner.field },
    );
  }
  return { id: node.id, urn: safeNodeUrnV2(node.memory.urn, node.loc) };
}

/** Where this field's compiled prompt lives (cor:agt:040:06, :07), or null when there is no such memory yet. */
async function expectedPromptMemoryId(tx: Db, owner: BootPromptPointerOwner): Promise<string | null> {
  if (owner.field === 'AGENT') return owner.agent.systemMemoryId;
  const agentId = owner.field === 'APP_AGENT' ? owner.agentId : owner.worker.agentId;
  // The install memory's identity is its columns (#2044), never its URN.
  const install = await (tx as PrismaClient).memory.findFirst({
    where: { class: 'system', isInstallMemory: true, appId: owner.app.id, installOfAgentId: agentId, deletedAt: null },
    select: { id: true },
  });
  return install?.id ?? null;
}

/**
 * The ONLY writer of a boot-prompt pointer (#2045 6258606109 §3): gate, then
 * (for a set) the target checks, then the write, all in `tx`. `nodeRef: null`
 * clears, and a clear skips only the target checks, never the gate.
 *
 * The caller owns the transaction and must already hold the owner's authority
 * anchors (`withAuthorizedTx`), with `ctx` its `liveTxContext`. S9's compile
 * passes its own transaction (the #2063 fenced client when it holds one), so a
 * refusal here rolls back the compiled node with it. Nothing is written on a
 * refusal.
 */
export async function setBootPromptPointer(
  tx: Prisma.TransactionClient,
  ctx: BootPromptPointerCaller,
  owner: BootPromptPointerOwner,
  nodeRef: string | null,
  canReadMemory: (memoryId: string) => Promise<boolean>,
): Promise<ResolvedBootPromptPointer | null> {
  await assertMayWriteBootPromptPointer(ctx, owner);
  const target = nodeRef === null ? null : await validateBootPromptPointer(tx, owner, nodeRef, canReadMemory);
  const data = { bootPromptNodeId: target?.id ?? null, bootPromptUrn: target?.urn ?? null };
  if (owner.field === 'AGENT') {
    await tx.agent.update({ where: { id: owner.agent.id }, data });
  } else if (owner.field === 'APP_AGENT') {
    await tx.appAgent.update({ where: { appId_agentId: { appId: owner.app.id, agentId: owner.agentId } }, data });
  } else {
    await tx.worker.update({ where: { id: owner.worker.id }, data });
  }
  return target ? { nodeId: target.id, urn: target.urn, deleted: false } : null;
}
