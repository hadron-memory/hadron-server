import { lockAppInstallation } from '../../../lib/appInstallations.js';
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
 *     context. A caller who may not compile and a target that does not exist
 *     answer the same refusal. For a person the authority is managing the
 *     Agent or the App; for a worker session it is the write gate of the memory
 *     that holds the compiled node (#5453 Ask 5, {@link assertSessionMayWrite});
 *  2. only a caller who passed that gate learns the target is retired;
 *  3. the source is selected by exact address, the assembler is re-run under
 *     the locks (read-only), then the compiled node, its provenance row, its
 *     derived `compiled-from` edge, any missing same-organisation grants and
 *     the pointer are written. A refusal anywhere rolls all of it back.
 *
 * It never approves or signs (the API reports approvalIssued: false); the revision it writes is not one that
 * has been approved, so serving keeps the last approved one until a manager approves.
 *
 * A WORKER SESSION's compile (#5453 Ask 5; Holger, 2026-11-27: "Yes, also compile"; decision record
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-27-holger-rulings-to-bo-system-nodes-and-roles,
 * section 4b) needs no batch grant. It writes a NEW REVISION of an EXISTING compiled node in a memory the session
 * may write, and exactly as under the batch grant before it never creates a compiled node or an install memory,
 * never sets or moves a pointer and never provisions an organisation grant. The batch grant is no longer read
 * here: it remains for approving (src/lib/nodeApproval.ts).
 */
import { GraphQLError } from 'graphql';
import type { Node as NodeRow, Prisma } from '../../../generated/prisma/index.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { BOOT_PROMPT_COMPILED_ROLE, BOOT_PROMPT_NODE_TYPE, boundWorkerId, isCompiledBootPrompt, withCompileWrite } from '../../../lib/bootPrompt.js';
import { bootPromptGrantRequiredError } from '../../../lib/grants/bootPromptGrant.js';
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
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { lockEdgeEndpointMemories } from '../../../lib/edgeEndpointLock.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { generateId } from '../../../lib/id.js';
import { includeHistoryClient, withIncludeHistoryTransaction } from '../../../lib/includes/includeHistoryFence.js';
import { acquireLockSet } from '../../../lib/nodeSubtreeLock.js';
import { liveTxContext } from './authorizedTx.js';
import { ensureInstallMemory } from './installMemory.js';
import { isMemoryReadableFresh, isMemoryWriteRefusal, requireMemoryWriteAccess, type Context } from './resolvers.helpers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';

/** What is compiled: the Agent's prompt, an App's compiled Agent prompt, or one worker's. */
export type CompileTargetInput =
  | { kind: 'AGENT'; agentId: string }
  | { kind: 'APP_AGENT'; appId: string; agentId: string }
  | { kind: 'WORKER'; workerId: string };

export interface CompileBootPromptOptions {
  /** Agent and worker compiles only: false leaves the pointer alone. An App compile always sets it. */
  setPointer?: boolean;
  /** The one-time conversion only: refuse (ADDRESS_OCCUPIED) when ANY node is already at the compiled address, judged inside the deciding transaction under the locks; never overwrite. No request path sets it. */
  createOnly?: boolean;
  /** The one-time conversion's dry run only: assemble the text under the same gate and locks, write nothing (the transaction rolls back), and throw `BootCompilePreview` carrying the text. No request path sets it. */
  previewOnly?: boolean;
  /** The whole operation's budget in ms across the initial attempt and its owner-drift retries. Default 30s (6258672877). */
  budgetMs?: number;
  /** Deterministic test seams (barriers at the boundaries); no request path passes these. */
  seams?: {
    /** After the lock-free pre-gate of attempt `attempt` (0-based), before the fence is taken. */
    beforeFence?: (attempt: number) => Promise<void>;
    /** Inside the fence, after every lock is held, immediately before the source is selected and the assembler runs. */
    beforeAssemble?: (tx: Tx) => Promise<void>;
  };
}

/** Thrown out of a `previewOnly` compile with the text it would have written; the rollback leaves nothing behind. */
export class BootCompilePreview extends Error {
  constructor(readonly text: string, readonly occurrences: ReadonlyArray<{ kind: string; nodeId: string; revNo: number; selection: { rev: number | null } }>) { super('boot prompt preview'); }
}

/** One 30-second budget for the whole compile, not per attempt (Xavier 6258672877). */
export const COMPILE_BUDGET_MS = 30_000;
const POOL_WAIT_MS = 5_000;

/** The S9-4 refusals this adds to the S9-2 assembler's; the codes cor:agt:040:12 lists (R33). */
export const BOOT_COMPILE_CODES = ['BOOT_PROMPT_COMPILE_NOT_PERMITTED', 'BOOT_PROMPT_TARGET_RETIRED', 'BOOT_PROMPT_NO_SOURCE'] as const;

/** The one answer for every way of not being permitted: a non-manager, a worker session, a missing target. */
export function compileNotPermitted(): GraphQLError {
  return compileError('BOOT_PROMPT_COMPILE_NOT_PERMITTED', 'you may not compile this boot prompt.');
}

/** The loc of each compiled node (R32; confirmed by Vera on the team chat, 2026-10-22). */
export const AGENT_COMPILED_LOC = 'boot:compiled';
export const APP_COMPILED_LOC = 'boot:compiled';
export const workerCompiledLoc = (workerId: string): string => `boot:workers:${workerId}:compiled`;

export interface CompiledBootPromptResult {
  /** The committed compiled node, read inside the deciding transaction: no read after the commit can fail the answer (#2424). */
  node: NodeRow;
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
    // This owner read deliberately retains a physical row for a retired Agent:
    // its manager must receive TARGET_RETIRED after authority, not NOT_PERMITTED.
    const physical = await tx.appAgent.findFirst({
      where:{appId:target.appId,agentId:target.agentId,app:liveApp},
      select:{agentId:true,agent:{select:AGENT_SELECT},app:{select:{id:true,organizationId:true,ownerUserId:true}}},
    });
    const install = physical ? null : await lockAppInstallation(tx,target.appId,target.agentId);
    const row = physical ?? (install ? {agentId:install.agentId,agent:install.agent,
      app:await tx.app.findUniqueOrThrow({where:{id:target.appId},select:{id:true,organizationId:true,ownerUserId:true}})} : null);
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

/** A lock-wait, transaction timeout or connection-pool wait timeout (Postgres 55P03, Prisma P2028 / P2024 / expired). */
function isBudgetFault(e: unknown): boolean {
  const x = e as { code?: string; meta?: { code?: string }; message?: string };
  return x?.code === 'P2028' || x?.code === 'P2024' || x?.meta?.code === '55P03' || /lock timeout|lock_timeout|transaction expired|Transaction already closed|Include-history transaction expired/i.test(String(x?.message ?? ''));
}

/** The loc of the compiled node a compile of `target` writes. */
const compiledLocOf = (target: CompileTargetInput): string =>
  target.kind === 'WORKER' ? workerCompiledLoc(target.workerId) : target.kind === 'APP_AGENT' ? APP_COMPILED_LOC : AGENT_COMPILED_LOC;

/** The live install memory of this (App, Agent), or null. A read: nothing here creates one. */
async function findInstallMemoryId(db: Pick<Tx, 'memory'>, appId: string, agentId: string): Promise<string | null> {
  return (await db.memory.findFirst({
    where: { class: 'system', isInstallMemory: true, appId, installOfAgentId: agentId, deletedAt: null },
    select: { id: true },
  }))?.id ?? null;
}

/**
 * #5453 Ask 5 — the worker session's gate: may this session WRITE the memory that holds the compiled node?
 *
 * "A memory the session may write" is the memory's own write gate, {@link requireMemoryWriteAccess}: the one gate
 * every GraphQL node write of that memory passes, so a session that can edit the source or a rule of a prompt is
 * the session that can compile it, and neither can drift from the other. It judges the PERSON behind the session
 * (a worker session carries its holder's user): an Agent's system memory is written by whoever manages the Agent, an
 * App's install memory by whoever manages the App while the Agent is installed, and never by an impersonation, a run
 * or a credential with no user. Revoked membership does not authorize: the gate reads live memberships, and inside
 * the deciding transaction (`ctx` is the transaction context there) it takes the install authority FOR SHARE first.
 *
 * Every way of not passing, a memory that does not exist included, is the one {@link compileNotPermitted}. Only the
 * gate's own refusal is mapped; anything else (a database fault) passes through to the caller's handling.
 */
async function assertSessionMayWrite(ctx: Context, memoryId: string | null): Promise<void> {
  // Without a person behind it the session has no standing at all (as under the batch grant, Riana F4).
  if (!ctx.userId || ctx.appKeyId || !memoryId) throw compileNotPermitted();
  try {
    await requireMemoryWriteAccess(ctx, memoryId);
  } catch (e) {
    if (isMemoryWriteRefusal(e)) throw compileNotPermitted();
    throw e;
  }
}

/**
 * The worker session's LOCK-FREE, non-authoritative gate (#3823, Riana F2 and Andi P2-2; the grant it read is replaced by the
 * memory's write gate, #5453 Ask 5). Like the manager gate it stands in for, it runs before anything is held, so a session that
 * may not write the memory never takes the tenant's exclusive anchors, never queues on the platform-wide fence, and learns nothing
 * but the one refusal. The write gate comes FIRST, so a session that fails it does the same work whether or not a compiled node is
 * there. The authoritative judgement stays in the transaction.
 */
async function sessionPrecheck(ctx: Context, target: CompileTargetInput, before: CompileOwner): Promise<void> {
  const memoryId = target.kind === 'AGENT' ? before.agent.systemMemoryId : before.appId ? await findInstallMemoryId(ctx.db, before.appId, before.agent.id) : null;
  // A pooled-client decision on an install memory is a pre-flight (installMemory.ts): the transaction below decides.
  await assertSessionMayWrite({ ...ctx, installWritePreflight: true }, memoryId);
  // A worker session's compile never creates a compiled node: refused here before the fence is taken.
  const node = await ctx.db.node.findFirst({ where: { memoryId: memoryId!, loc: compiledLocOf(target), deletedAt: null }, select: { role: true } });
  if (!node || !isCompiledBootPrompt(node)) throw compileNotPermitted();
}

/** Race a probe against the operation deadline: an unbounded read must not outlive the budget. */
async function withinBudget<T>(deadline: number, work: Promise<T>): Promise<T> {
  const left = deadline - performance.now();
  if (left < 1) { void work.catch(() => undefined); throw compileConflict(); }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(compileConflict()), left); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A pre-fence read that hit the budget (pool wait included) is the same sanitized conflict; anything else passes through. */
async function preFence<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if (isBudgetFault(e)) throw compileConflict();
    throw e;
  }
}

/** The operation's single deadline (#2424): the target-ref resolution and the compile share one budget. */
export const compileDeadline = (budgetMs: number = COMPILE_BUDGET_MS): number => performance.now() + budgetMs;

/** What is left of the operation budget, at least 1 ms (a spent budget is then refused by the compile itself). */
export const remainingBudgetMs = (deadline: number): number => Math.max(1, Math.floor(deadline - performance.now()));

/**
 * Resolve the compile's target ref under the operation deadline (#2424, cor:agt:040:12): a budget or pool fault,
 * or a stalled read, is the same sanitized CONFLICT as inside the compile. Any other error passes through
 * unchanged, so a ref that names nothing is still the caller's to map and a programming error is not a denial.
 */
export function resolveWithinBudget<T>(deadline: number, resolve: () => Promise<T>): Promise<T> {
  return preFence(withinBudget(deadline, resolve()));
}

/** The compile could not settle inside its budget or the owner kept changing: retry. Says nothing about the target. */
function compileConflict(): GraphQLError {
  return new GraphQLError('The boot prompt could not be compiled right now; retry.', { extensions: { code: 'CONFLICT' } });
}

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
  if (ctx.impersonation) throw compileNotPermitted();
  const deadline = performance.now() + (options.budgetMs ?? COMPILE_BUDGET_MS);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (deadline - performance.now() < 1) throw compileConflict();
    // The anchors are chosen from the owner as read BEFORE the fence; a transfer that lands first is caught
    // inside and retried with the new ones (the setBootPromptPointer shape).
    const before = await preFence(withinBudget(deadline, loadCompileOwner(ctx.db, target)));
    if (!before) throw compileNotPermitted();
    // A lock-free, NON-authoritative gate before anything is held: a caller who may not compile must not queue
    // on the platform-wide fence or take the tenant's anchors, which would be a cheap lock-DoS and an existence
    // oracle (Rook P2-1 on #2258). The in-transaction gate below stays the authoritative one.
    try {
      // #5453 Ask 5: a worker session compiles where it may write the memory that holds the compiled node; the manager gate is
      // the person's and does not apply to it.
      if (!boundWorkerId()) await withinBudget(deadline, assertMayWriteBootPromptPointer(ctx, before.owner));
      else await withinBudget(deadline, sessionPrecheck(ctx, target, before));
    } catch (e) {
      if (e instanceof GraphQLError && e.extensions?.code !== 'CONFLICT') throw compileNotPermitted();
      if (e instanceof GraphQLError) throw e;
      if (isBudgetFault(e)) throw compileConflict();
      throw e;
    }
    const expected = tenantOf(before.owner);
    await options.seams?.beforeFence?.(attempt);
    try {
      return await decide(ctx, target, options, before, expected, deadline);
    } catch (e) {
      if (e instanceof OwnerTenantChanged) continue;
      if (e instanceof GraphQLError && (e.extensions?.code === 'FORBIDDEN' || e.extensions?.code === 'BOOT_PROMPT_POINTER_SESSION_REFUSED')) {
        throw compileNotPermitted();
      }
      // The assembler's typed refusal, as the GraphQL error a client sees. The position is the includer tag's, never the target's.
      if (e instanceof BootCompileRefusal) {
        throw new GraphQLError(`${e.code}: the boot prompt cannot be compiled.`, {
          extensions: { code: e.code, ...(e.position ? { position: e.position } : {}) },
        });
      }
      // The budget ran out while waiting for the fence or inside the transaction: the same sanitized conflict.
      if (isBudgetFault(e)) throw compileConflict();
      throw e;
    }
  }
  // Drift exhausted: the fixed, sanitized conflict. A caller who is denied on the fresh read never reaches here.
  throw compileConflict();
}

async function decide(
  ctx: Context,
  target: CompileTargetInput,
  options: CompileBootPromptOptions,
  before: CompileOwner,
  expected: { organizationId: string | null; ownerUserId: string | null },
  deadline: number,
): Promise<CompiledBootPromptResult> {
  const effects: Array<() => void> = [];
  const anchors: AuthorityAnchor[] = [
    before.appId ? { kind: 'app', id: before.appId } : { kind: 'agent', id: before.agent.id },
    ...(before.appId ? [{ kind: 'agent' as const, id: before.agent.id }] : []),
    ...(expected.organizationId ? [{ kind: 'org' as const, id: expected.organizationId }] : []),
    ...(expected.ownerUserId ? [{ kind: 'user' as const, id: expected.ownerUserId }] : []),
    ...(ctx.userId ? [{ kind: 'user' as const, id: ctx.userId }] : []),
  ];

  const remaining = Math.floor(deadline - performance.now());
  // Pool wait and transaction time are consecutive, so together they must fit the one budget: the transaction's own
  // clock starts after the pool hands over a connection (Anne P2-1 on 754fac76).
  const poolWait = Math.max(1, Math.min(POOL_WAIT_MS, Math.floor(remaining / 2)));
  if (remaining - poolWait < 1) throw compileConflict();
  const result = await withIncludeHistoryTransaction(ctx.db, async (fence) => {
    const tx = includeHistoryClient(fence);
    await lockAuthorityAnchors(tx, anchors, 'exclusive');
    await lockAgentBaseGraph(tx);
    if (before.appId && ctx.userId) {
      await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${before.appId} AND user_id = ${ctx.userId} FOR SHARE`;
    }

    // 1. The gate, on the live owner and the live caller. Nothing about the target is said before it passes.
    const live = await loadCompileOwner(tx, target);
    if (!live) throw compileNotPermitted();
    const txCtx = await liveTxContext(ctx, tx);
    // Where the output goes when the target is an App's or a worker's. Read once, here: a worker session's gate is about this memory.
    let installMemoryId = live.appId ? await findInstallMemoryId(tx, live.appId, live.agent.id) : null;
    // #5453 Ask 5: under a worker session the manager gate is replaced by the write gate of the memory that holds the compiled node,
    // judged on the live state under the anchors held above, BEFORE the drift check, the retired answer and anything that is
    // assembled: a session that may not write the memory is told nothing else about the target.
    const sessionWorkerId = boundWorkerId();
    // The fresh gate comes BEFORE the drift check, so a caller denied on the live owner is refused, never retried.
    if (sessionWorkerId) await assertSessionMayWrite(txCtx, target.kind === 'AGENT' ? live.agent.systemMemoryId : installMemoryId);
    else await assertMayWriteBootPromptPointer(txCtx, live.owner);
    const tenant = tenantOf(live.owner);
    if (tenant.organizationId !== expected.organizationId || tenant.ownerUserId !== expected.ownerUserId) {
      throw new OwnerTenantChanged();
    }

    // 2. Only now: retired.
    if (live.retired) {
      throw compileError('BOOT_PROMPT_TARGET_RETIRED', 'the worker or Agent being compiled for has been retired.');
    }

    // 3. Where the source is and where the output goes.
    // An App's first compile IS its first customisation: the install memory is made lazily (S7), inside this
    // transaction, so a later refusal rolls it back. A worker's source lives in that memory, so with none there is
    // genuinely no source (Dara P2-2). A worker session's compile never creates one (#3823, Andi): with none its gate
    // above has already refused.
    if (target.kind === 'APP_AGENT' && !installMemoryId && live.appId && !sessionWorkerId) {
      installMemoryId = (await ensureInstallMemory(tx, txCtx, live.appId, live.agent.id)).id;
    }
    const agentMemoryId = live.agent.systemMemoryId;
    const noSource = () => compileError('BOOT_PROMPT_NO_SOURCE', 'the target has no source boot prompt to compile from.');
    if (!agentMemoryId) throw noSource();
    if (target.kind !== 'AGENT' && !installMemoryId) throw noSource();
    const out = target.kind === 'AGENT'
      ? { memoryId: agentMemoryId, loc: AGENT_COMPILED_LOC }
      : { memoryId: installMemoryId!, loc: compiledLocOf(target) };

    let sessionNodeId: string | null = null;
    if (sessionWorkerId) {
      // #3823 (V49, V53), kept by #5453 Ask 5: a worker session's compile writes a NEW REVISION of a compiled node that is already
      // there. It never creates one. Judged BEFORE anything is assembled or provisioned, and everything rolls back on a refusal.
      const node = await tx.node.findFirst({ where: { memoryId: out.memoryId, loc: out.loc, deletedAt: null }, select: { id: true, role: true } });
      sessionNodeId = node?.id ?? null;
      if (!node || !isCompiledBootPrompt(node)) throw compileNotPermitted();
      // V53 (cor:agt:040:12) states this for the App-level compile only: an Agent or worker compile has no pointer requirement, so a
      // worker session may refresh a compiled prompt nothing serves yet. That is the ruling, not an omission.
      // V53 (cor:agt:040:12): a worker session's App-level compile only refreshes what the App already serves, so the App's
      // pointer must ALREADY name this compiled node. Read under the App and Agent anchors held above; it is never written.
      if (target.kind === 'APP_AGENT') {
        const pointed = await tx.appAgent.findUnique({ where: { appId_agentId: { appId: live.appId!, agentId: live.agent.id } }, select: { bootPromptNodeId: true } });
        if (!pointed || pointed.bootPromptNodeId !== node.id) throw compileNotPermitted();
      }
    }

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
    await options.seams?.beforeAssemble?.(tx);
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

    if (options.previewOnly) throw new BootCompilePreview(plan.text, plan.occurrences);

    // Missing same-organisation grants are provisioned here, in the deciding transaction.
    if (recipient.kind === 'org') {
      for (const grant of plan.grants) {
        if (!grant.provision) continue;
        // #3823 (V53), kept by #5453 Ask 5: a worker session's compile never provisions an AgentOrgGrant. Known only once the
        // plan is; it is told only to a session that passed the write gate above, and nothing has been written.
        if (sessionWorkerId) throw bootPromptGrantRequiredError();
        // The included Agent is not one of the held anchors: lock its row and re-read it, so a retirement or a
        // transfer that committed since the plan is seen and no grant is minted for it (Rook P3-1).
        const still = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM agents WHERE id = ${grant.agentId} AND deleted_at IS NULL AND organization_id = ${recipient.orgId} FOR SHARE`;
        if (still.length !== 1) throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_UNAVAILABLE', null);
        await ensureAgentOrgGrant(tx, recipient.orgId, grant.agentId, { createdBy: ctx.userId });
      }
    }

    // #2047 PR-C (§10 #2698): the pointer owner's locks come BEFORE the compiled node is written. A bind takes the worker
    // assignment lock and the worker row, then share-locks the compiled node (resolveServedBootPrompt); taking them in the
    // other order here, node first, is a lock-order cycle. One order everywhere: assignment lock, worker row, node.
    // A worker session's compile never sets or moves a pointer, whatever the caller asks (V53).
    const setPointer = !sessionWorkerId && (target.kind === 'APP_AGENT' || options.setPointer !== false);
    const pointerOwner = setPointer ? await loadBootPromptPointerOwner(tx, ptr(target), { lockForWrite: true }) : null;
    if (setPointer && !pointerOwner) throw compileNotPermitted();

    // 4. The compiled node: a new revision every compile, even when the text is unchanged.
    const existing = await tx.node.findFirst({
      where: { memoryId: out.memoryId, loc: out.loc, deletedAt: null },
      select: { id: true, role: true },
    });
    // The session's compile was judged for ONE node id; a delete and re-create at the same address in between would make this write
    // a create, or a write to a node that was never judged (Andi).
    if (sessionWorkerId && existing?.id !== sessionNodeId) throw compileNotPermitted();
    if (existing && options.createOnly) {
      throw new GraphQLError('The compiled boot prompt address is occupied.', { extensions: { code: 'ADDRESS_OCCUPIED' } });
    }
    if (existing && !isCompiledBootPrompt(existing)) {
      throw new GraphQLError('The compiled boot prompt address is occupied by another node.', { extensions: { code: 'CONFLICT' } });
    }
    const written = await withCompileWrite(() => writeNodeCore(
      {
        // #5453 Ask 1: type `system`, told apart by the role `prompt.boot.compiled` (the node type of its own is retired).
        memoryId: out.memoryId, loc: out.loc, name: 'Compiled boot prompt', role: BOOT_PROMPT_COMPILED_ROLE,
        nodeType: BOOT_PROMPT_NODE_TYPE, content: plan.text,
      },
      txCtx,
      existing ? 'update' : 'create',
      {
        ownerLimit: 'count-only',
        sizeCeiling: 'skip',
        authoring: { kind: 'platform', record: 'boot-prompt-compile' },
        transaction: { tx, pooledDb: ctx.db, afterCommit: (effect) => effects.push(effect) },
        ...(existing ? { targetNodeId: existing.id } : {}),
        forceRevision: true,
      },
    ));
    const node = await tx.node.findUniqueOrThrow({ where: { id: written.id } });

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
        loc: deriveEdgeLoc(node.loc, 'compiled-from', source.loc), locAuthored: false /* #2947: derived */, name: 'compiled-from',
        description: JSON.stringify({
          revNo: node.revSeq,
          nodes: plan.occurrences.map((o) => ({ nodeId: o.nodeId, revNo: o.revNo, kind: o.kind, ...(o.replacesNodeId ? { replacesNodeId: o.replacesNodeId } : {}) })),
        }),
        createdBy: ctx.userId ?? null,
      },
    });

    // 5. The pointer. An App compile always sets it; an Agent or worker compile unless the caller opted out.
    if (setPointer) {
      await setBootPromptPointer(tx, txCtx, pointerOwner!, node.id, (memoryId) => isMemoryReadableFresh(txCtx, memoryId, tx));
    }

    return {
      node, nodeId: node.id, memoryId: node.memoryId, loc: node.loc, revNo: node.revSeq,
      contentHash: plan.contentHash, pointerSet: setPointer,
    };
  }, { timeoutMs: remaining - poolWait, maxWaitMs: poolWait });
  // The compile has committed: a failing best-effort effect must not turn it into an error (#2424).
  for (const effect of effects) {
    try { effect(); } catch (e) { console.error('[compileBootPrompt] a post-commit effect failed:', e instanceof Error ? e.message : e); }
  }
  return result;
}

/** The text a compile would write now, assembled under the compile's own gate, locks and budget; nothing is written. */
export async function previewBootPromptText(ctx: Context, target: CompileTargetInput): Promise<{ text: string; occurrences: BootCompilePreview['occurrences'] }> {
  try {
    await compileBootPrompt(ctx, target, { previewOnly: true, setPointer: false });
  } catch (e) {
    if (e instanceof BootCompilePreview) return { text: e.text, occurrences: e.occurrences };
    throw e;
  }
  throw new Error('previewOnly compile returned without a preview');
}

export { BootCompileRefusal };
