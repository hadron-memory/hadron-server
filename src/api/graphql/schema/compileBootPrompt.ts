/**
 * #2046 (S9-4, cor:agt:040:12) — the compile: the ONE caller of the S9-1..S9-3
 * building blocks. GraphQL only (never MCP).
 *
 * One deciding transaction under the #2063 include-history fence, in the
 * fence's lock order: the exclusive fence key (first statement), the authority
 * anchors, the Agent base graph, the edge-endpoint memory keys, the node
 * address keys, then the S6 writer. Inside it, in order:
 *
 *  1. the OWNER is re-read and the caller's authority decided on the live
 *     context. A caller who may not compile, a worker session, and a target
 *     that does not exist all answer the same `FORBIDDEN`;
 *  2. only a caller who passed that gate learns the target is retired;
 *  3. the source is selected by exact address, the assembler is re-run under
 *     the locks (read-only), then the compiled node, its provenance row, its
 *     derived `compiled-from` edge, any missing same-organisation grants and
 *     the pointer are written. A refusal anywhere rolls all of it back.
 *
 * It never approves or signs; the revision it writes is unapproved.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, BOOT_PROMPT_ROLE, withCompileWrite } from '../../../lib/bootPrompt.js';
import {
  loadBootPromptPointerOwner,
  setBootPromptPointer,
  assertMayWriteBootPromptPointer,
  type BootPromptPointerOwner,
  type BootPromptPointerTarget,
} from '../../../lib/bootPromptPointer.js';
import { assembleBootPrompt, BootCompileRefusal, type CompileRecipient } from '../../../lib/bootCompile/assemble.js';
import { sourceForCompile, type CompileSourceTarget } from '../../../lib/bootCompile/sourceForCompile.js';
import type { CompiledTarget } from '../../../lib/bootCompile/provenance.js';
import { lockAgentBaseGraph } from '../../../lib/agentBase.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { lockEdgeEndpointMemories } from '../../../lib/edgeEndpointLock.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { generateId } from '../../../lib/id.js';
import { includeHistoryClient, withIncludeHistoryTransaction } from '../../../lib/includes/includeHistoryFence.js';
import { acquireLockSet } from '../../../lib/nodeSubtreeLock.js';
import { liveTxContext } from './authorizedTx.js';
import { isMemoryReadableFresh, type Context } from './resolvers.helpers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';

/** What is compiled: the Agent's prompt, an App's compiled Agent prompt, or one worker's. */
export type CompileTargetInput =
  | { kind: 'AGENT'; agentId: string }
  | { kind: 'APP_AGENT'; appId: string; agentId: string }
  | { kind: 'WORKER'; workerId: string };

export interface CompileBootPromptOptions {
  /** Agent and worker compiles only: false leaves the pointer alone. An App compile always sets it. */
  setPointer?: boolean;
}

/** The S9-4 refusals this adds to the S9-2 assembler's; the codes cor:agt:040:12 lists (R33). */
export const BOOT_COMPILE_CODES = ['BOOT_PROMPT_TARGET_RETIRED', 'BOOT_PROMPT_NO_SOURCE'] as const;

/** The loc of each compiled node (R32; confirmed by Vera on the team chat, 2026-10-22). */
export const AGENT_COMPILED_LOC = 'boot:compiled';
export const APP_COMPILED_LOC = 'boot:compiled';
export const workerCompiledLoc = (workerId: string): string => `boot:workers:${workerId}:compiled`;

export interface CompiledBootPromptResult {
  nodeId: string;
  memoryId: string;
  loc: string;
  revNo: number;
  contentHash: string;
  /** Whether the pointer was written by this compile. */
  pointerSet: boolean;
}

type Tx = Prisma.TransactionClient;

interface CompileOwner {
  owner: BootPromptPointerOwner;
  retired: boolean;
  /** The Agent whose prompt is compiled, and the memory holding its source. */
  agent: { id: string; organizationId: string | null; ownerUserId: string | null; systemMemoryId: string | null };
  appId: string | null;
  workerId: string | null;
}

const ptr = (t: CompileTargetInput): BootPromptPointerTarget =>
  t.kind === 'AGENT' ? { field: 'AGENT', agentId: t.agentId }
    : t.kind === 'APP_AGENT' ? { field: 'APP_AGENT', appId: t.appId, agentId: t.agentId }
      : { field: 'WORKER', workerId: t.workerId };

const AGENT_SELECT = { id: true, organizationId: true, ownerUserId: true, systemMemoryId: true, deletedAt: true } as const;

/**
 * The owner, retired or not: the gate needs a retired target's owner columns to
 * decide first, and only then may "retired" be said. Null when there is nothing
 * to authorize against (the caller answers it as not permitted).
 */
async function loadCompileOwner(tx: Tx, target: CompileTargetInput): Promise<CompileOwner | null> {
  if (target.kind === 'AGENT') {
    const agent = await tx.agent.findUnique({ where: { id: target.agentId }, select: AGENT_SELECT });
    if (!agent) return null;
    return { owner: { field: 'AGENT', agent }, retired: agent.deletedAt !== null, agent, appId: null, workerId: null };
  }
  const liveApp = { deletedAt: null, uninstalledAt: null };
  if (target.kind === 'APP_AGENT') {
    const row = await tx.appAgent.findFirst({
      where: { appId: target.appId, agentId: target.agentId, app: liveApp },
      select: { agentId: true, app: { select: { id: true, organizationId: true, ownerUserId: true } }, agent: { select: AGENT_SELECT } },
    });
    if (!row) return null;
    return {
      owner: { field: 'APP_AGENT', app: row.app, agentId: row.agentId },
      retired: row.agent.deletedAt !== null, agent: row.agent, appId: row.app.id, workerId: null,
    };
  }
  const worker = await tx.worker.findFirst({
    where: { id: target.workerId, app: liveApp },
    select: { id: true, agentId: true, retiredAt: true, app: { select: { id: true, organizationId: true, ownerUserId: true } }, agent: { select: AGENT_SELECT } },
  });
  if (!worker) return null;
  return {
    owner: { field: 'WORKER', app: worker.app, worker: { id: worker.id, agentId: worker.agentId } },
    retired: worker.retiredAt !== null || worker.agent.deletedAt !== null,
    agent: worker.agent, appId: worker.app.id, workerId: worker.id,
  };
}

const tenantOf = (o: BootPromptPointerOwner) => (o.field === 'AGENT' ? o.agent : o.app);

class OwnerTenantChanged extends Error {}

function compileError(code: string, message: string): GraphQLError {
  return new GraphQLError(`${code}: ${message}`, { extensions: { code } });
}

/** Compile a boot prompt. Returns the new unapproved revision of the compiled node. */
export async function compileBootPrompt(
  ctx: Context,
  target: CompileTargetInput,
  options: CompileBootPromptOptions = {},
): Promise<CompiledBootPromptResult> {
  // An impersonated session is never "a manager as themselves" (the gate below refuses it too); stated here
  // so no owner lookup runs for it.
  if (ctx.impersonation) throw authorizationDenied();
  for (let attempt = 0; attempt < 3; attempt++) {
    // The anchors are chosen from the owner as read BEFORE the fence; a transfer that lands first is caught
    // inside and retried with the new ones (the setBootPromptPointer shape).
    const before = await loadCompileOwner(ctx.db, target);
    if (!before) throw authorizationDenied();
    const expected = tenantOf(before.owner);
    try {
      return await decide(ctx, target, options, before, expected);
    } catch (e) {
      if (e instanceof OwnerTenantChanged) continue;
      // The assembler's typed refusal, as the GraphQL error a client sees. The position is the includer tag's, never the target's.
      if (e instanceof BootCompileRefusal) {
        throw new GraphQLError(`${e.code}: the boot prompt cannot be compiled.`, {
          extensions: { code: e.code, ...(e.position ? { position: e.position } : {}) },
        });
      }
      throw e;
    }
  }
  throw new Error('The owner of this boot prompt changed repeatedly; retry the operation');
}

async function decide(
  ctx: Context,
  target: CompileTargetInput,
  options: CompileBootPromptOptions,
  before: CompileOwner,
  expected: { organizationId: string | null; ownerUserId: string | null },
): Promise<CompiledBootPromptResult> {
  const effects: Array<() => void> = [];
  const anchors: AuthorityAnchor[] = [
    before.appId ? { kind: 'app', id: before.appId } : { kind: 'agent', id: before.agent.id },
    ...(before.appId ? [{ kind: 'agent' as const, id: before.agent.id }] : []),
    ...(expected.organizationId ? [{ kind: 'org' as const, id: expected.organizationId }] : []),
    ...(expected.ownerUserId ? [{ kind: 'user' as const, id: expected.ownerUserId }] : []),
    ...(ctx.userId ? [{ kind: 'user' as const, id: ctx.userId }] : []),
  ];

  const result = await withIncludeHistoryTransaction(ctx.db, async (fence) => {
    const tx = includeHistoryClient(fence);
    await lockAuthorityAnchors(tx, anchors, 'exclusive');
    await lockAgentBaseGraph(tx);
    if (before.appId && ctx.userId) {
      await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${before.appId} AND user_id = ${ctx.userId} FOR SHARE`;
    }

    // 1. The gate, on the live owner and the live caller. Nothing about the target is said before it passes.
    const live = await loadCompileOwner(tx, target);
    if (!live) throw authorizationDenied();
    const tenant = tenantOf(live.owner);
    if (tenant.organizationId !== expected.organizationId || tenant.ownerUserId !== expected.ownerUserId) {
      throw new OwnerTenantChanged();
    }
    const txCtx = await liveTxContext(ctx, tx);
    await assertMayWriteBootPromptPointer(txCtx, live.owner);

    // 2. Only now: retired.
    if (live.retired) {
      throw compileError('BOOT_PROMPT_TARGET_RETIRED', 'the worker or Agent being compiled for has been retired.');
    }

    // 3. Where the source is and where the output goes.
    const installMemoryId = live.appId
      ? (await tx.memory.findFirst({
        where: { class: 'system', isInstallMemory: true, appId: live.appId, installOfAgentId: live.agent.id, deletedAt: null },
        select: { id: true },
      }))?.id ?? null
      : null;
    const agentMemoryId = live.agent.systemMemoryId;
    const noSource = () => compileError('BOOT_PROMPT_NO_SOURCE', 'the target has no source boot prompt to compile from.');
    if (!agentMemoryId) throw noSource();
    if (target.kind !== 'AGENT' && !installMemoryId) throw noSource();
    const out = target.kind === 'AGENT'
      ? { memoryId: agentMemoryId, loc: AGENT_COMPILED_LOC }
      : { memoryId: installMemoryId!, loc: target.kind === 'APP_AGENT' ? APP_COMPILED_LOC : workerCompiledLoc(target.workerId) };

    const sourceTarget: CompileSourceTarget = target.kind === 'AGENT'
      ? { kind: 'AGENT', agentMemoryId }
      : target.kind === 'APP_AGENT'
        ? { kind: 'APP_AGENT', agentMemoryId, installMemoryId }
        : { kind: 'WORKER', workerId: target.workerId, installMemoryId };

    // The keys the writer takes, in the writer's order, BEFORE the source is selected: edge-endpoint memories,
    // then the output and source addresses.
    const sourceProbe = await sourceForCompile(tx, sourceTarget, out);
    await lockEdgeEndpointMemories(tx, [out.memoryId, sourceProbe.memoryId]);
    await acquireLockSet(tx, [{ memoryId: out.memoryId, loc: out.loc }, { memoryId: sourceProbe.memoryId, loc: sourceProbe.loc }]);
    // Re-select under the locks: the probe above is not trusted past them.
    const source = await sourceForCompile(tx, sourceTarget, out);

    const recipient: CompileRecipient = (() => {
      const owner = target.kind === 'AGENT' ? live.agent : live.owner.field === 'AGENT' ? live.agent : (live.owner as { app: { organizationId: string | null; ownerUserId: string | null } }).app;
      return owner.organizationId ? { kind: 'org', orgId: owner.organizationId } : { kind: 'user', userId: owner.ownerUserId! };
    })();
    const compiledTarget: CompiledTarget = target.kind === 'AGENT'
      ? { kind: 'AGENT', agentId: live.agent.id }
      : target.kind === 'APP_AGENT'
        ? { kind: 'APP_AGENT', agentId: live.agent.id, appId: live.appId! }
        : { kind: 'WORKER', agentId: live.agent.id, appId: live.appId!, workerId: target.workerId };

    const plan = await assembleBootPrompt(tx, {
      target: compiledTarget,
      installMemoryId: target.kind === 'AGENT' ? null : installMemoryId,
      source: { nodeId: source.id, memoryId: source.memoryId },
      recipient,
      callerCanRead: (memoryId) => isMemoryReadableFresh(txCtx, memoryId, tx),
    });

    // Missing same-organisation grants are provisioned here, in the deciding transaction.
    if (recipient.kind === 'org') {
      for (const grant of plan.grants) {
        if (grant.provision) await ensureAgentOrgGrant(tx, recipient.orgId, grant.agentId, { createdBy: ctx.userId });
      }
    }

    // 4. The compiled node: a new revision every compile, even when the text is unchanged.
    const existing = await tx.node.findFirst({
      where: { memoryId: out.memoryId, loc: out.loc, deletedAt: null },
      select: { id: true, nodeType: true },
    });
    if (existing && existing.nodeType !== COMPILED_BOOT_PROMPT_NODE_TYPE) {
      throw new GraphQLError('The compiled boot prompt address is occupied by another node.', { extensions: { code: 'CONFLICT' } });
    }
    const written = await withCompileWrite(() => writeNodeCore(
      {
        memoryId: out.memoryId, loc: out.loc, name: 'Compiled boot prompt', role: BOOT_PROMPT_ROLE,
        nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE, content: plan.text,
      },
      txCtx,
      existing ? 'update' : 'create',
      {
        transaction: { tx, pooledDb: ctx.db, afterCommit: (effect) => effects.push(effect) },
        ...(existing ? { targetNodeId: existing.id } : {}),
        forceRevision: true,
      },
    ));
    const node = await tx.node.findUniqueOrThrow({ where: { id: written.id }, select: { id: true, loc: true, memoryId: true, revSeq: true } });

    await tx.compiledPromptRevision.create({
      data: {
        compiledNodeId: node.id,
        compiledRevNo: node.revSeq,
        contentHash: plan.contentHash,
        targetKind: compiledTarget.kind,
        targetAgentId: compiledTarget.agentId,
        targetAppId: compiledTarget.kind === 'AGENT' ? null : compiledTarget.appId,
        targetWorkerId: compiledTarget.kind === 'WORKER' ? compiledTarget.workerId : null,
        provenance: { version: 1, occurrences: plan.occurrences } as unknown as Prisma.InputJsonValue,
        occurrenceCount: plan.occurrences.length,
        compiledBy: ctx.userId ?? null,
      },
    });

    // The derived edge is an index of the LATEST compile; the provenance row above is the per-revision truth.
    await tx.edge.deleteMany({ where: { sourceId: node.id, name: 'compiled-from', governedKind: null } });
    await tx.edge.create({
      data: {
        id: generateId(), memoryId: node.memoryId, sourceId: node.id, targetId: source.id,
        loc: deriveEdgeLoc(node.loc, 'compiled-from', source.loc), name: 'compiled-from',
        description: JSON.stringify({
          revNo: node.revSeq,
          nodes: plan.occurrences.map((o) => ({ nodeId: o.nodeId, revNo: o.revNo, kind: o.kind, ...(o.replacesNodeId ? { replacesNodeId: o.replacesNodeId } : {}) })),
        }),
        createdBy: ctx.userId ?? null,
      },
    });

    // 5. The pointer. An App compile always sets it; an Agent or worker compile unless the caller opted out.
    const setPointer = target.kind === 'APP_AGENT' || options.setPointer !== false;
    if (setPointer) {
      const owner = await loadBootPromptPointerOwner(tx, ptr(target));
      if (!owner) throw authorizationDenied();
      await setBootPromptPointer(tx, txCtx, owner, node.id, (memoryId) => isMemoryReadableFresh(txCtx, memoryId, tx));
    }

    return {
      nodeId: node.id, memoryId: node.memoryId, loc: node.loc, revNo: node.revSeq,
      contentHash: plan.contentHash, pointerSet: setPointer,
    };
  });
  for (const effect of effects) effect();
  return result;
}

export { BootCompileRefusal };
