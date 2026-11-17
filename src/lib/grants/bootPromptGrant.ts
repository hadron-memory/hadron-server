/**
 * #3823 (ruling 0267; cor:agt:040:11 r8, cor:agt:040:12 r21, cor:agt:040:18 r9, cor:acl:140:01, :04): the two grants that let a
 * worker session touch its OWN boot prompt.
 *
 *  - `bootprompt.source.edit`: change the TEXT of one existing source node, in place, once. Held by the worker, naming ONE node,
 *    good for an hour from activation (the ACTION's lifetime limit, not the grant's `expires_at`, which may only shorten it), and for
 *    one use (the action's count, and the grant's own `max_uses = 1`), signed by a person who could make the edit themselves.
 *    Spending it counts the use (`use_count + 1`) and writes one `USE` event in the edit's own transaction, under the grant
 *    row's lock, so a refused or rolled-back write spends nothing and two racing edits cannot both spend one grant.
 *  - `bootprompt.compile.approve`: compile and approve the compiled prompts it names, any number of times within the hour (no use
 *    count). It never signs, and a compile under it never creates a compiled node, sets a pointer or provisions an AgentOrgGrant.
 *
 * "Own" is a fact about the NODE, judged here and not by the grant: the worker's own `boot:workers:<id>:source` (or `:compiled`) in
 * its App's install memory for its role Agent, or the role Agent's `boot:source` (`boot:compiled`) in that install memory or in the
 * Agent's system memory. A grant can name only what is already own, so a signer cannot widen it. Another worker's node, another
 * role's, and one outside the worker's App are refused whatever the worker's holder may write.
 *
 * The signer is re-judged when the grant is SPENT, not only when it was signed: the person recorded as the issuer must still be
 * able to make the edit (manage the App; for the Agent's system-memory source, manage the Agent too, V54). A signer who has
 * since lost that standing admits nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { managesAgent, managesApp } from '../auth/appManagement.js';
import {
  COMPILED_BOOT_PROMPT_NODE_TYPE, assertBootPromptWriteAllowed, boundWorkerId, bootPromptWorkerSessionError,
  inCompileScope, isBootPromptRole,
} from '../bootPrompt.js';
import { coverableAction, findCoveringGrants, spendGrant } from './cover.js';

export const BOOT_PROMPT_EDIT_ACTION = 'bootprompt.source.edit';
export const BOOT_PROMPT_BATCH_ACTION = 'bootprompt.compile.approve';

type Q = Prisma.TransactionClient;
export interface BootPromptNodeFacts { id: string; memoryId: string; loc: string }

/** Where an own node sits; it decides what the signer must manage. */
export type OwnScope = 'WORKER' | 'APP_ROLE' | 'AGENT_SYSTEM';
export interface OwnNode { scope: OwnScope; appId: string; agentId: string }
/** Where a batch-named compiled prompt sits (see {@link batchTargetScope}); the same shape, but NOT limited to the worker's own prompts. */
export type TargetScope = OwnNode;

/**
 * Whether `node` is the worker's OWN boot prompt of `kind` (see the module comment), and where it sits. Null for anything else,
 * including a retired worker, a deleted App and a node that no longer resolves.
 */
export async function ownBootPromptNode(q: Q, workerId: string, node: BootPromptNodeFacts, kind: 'source' | 'compiled'): Promise<OwnNode | null> {
  const worker = await q.worker.findFirst({
    where: { id: workerId, retiredAt: null, app: { deletedAt: null } },
    select: { appId: true, agentId: true, agent: { select: { systemMemoryId: true, deletedAt: true } } },
  });
  if (!worker || worker.agent.deletedAt !== null) return null;
  const memory = await q.memory.findFirst({
    where: { id: node.memoryId, deletedAt: null },
    select: { id: true, class: true, isInstallMemory: true, appId: true, installOfAgentId: true },
  });
  if (!memory) return null;
  const roleLoc = `boot:${kind}`;
  const workerLoc = `boot:workers:${workerId}:${kind}`;
  const own = { appId: worker.appId, agentId: worker.agentId };
  if (memory.class === 'system' && memory.isInstallMemory && memory.appId === worker.appId && memory.installOfAgentId === worker.agentId) {
    if (node.loc === workerLoc) return { scope: 'WORKER', ...own };
    if (node.loc === roleLoc) return { scope: 'APP_ROLE', ...own };
    return null;
  }
  if (node.loc === roleLoc && worker.agent.systemMemoryId === memory.id) return { scope: 'AGENT_SYSTEM', ...own };
  return null;
}

/**
 * Where a compiled prompt a BATCH grant may name sits (cor:agt:040:12 S7a, cor:agt:040:18 S8). Unlike a source edit, a batch grant is
 * not limited to the worker's own prompt: a person signed it for the prompts it NAMES (Ada's session may compile Ben's). What stays
 * bounded is the App: the compiled prompt must be one of THIS App's (`boot:compiled` or `boot:workers:<id>:compiled` in an install memory
 * of the grant's own App), or the worker's own role Agent's `boot:compiled` in its system memory. Another App's, another Agent's system
 * memory, and a source are never in scope, whatever the grant names.
 */
export async function batchTargetScope(q: Q, workerId: string, node: BootPromptNodeFacts): Promise<TargetScope | null> {
  const worker = await q.worker.findFirst({
    where: { id: workerId, retiredAt: null, app: { deletedAt: null } },
    select: { appId: true, agentId: true, agent: { select: { systemMemoryId: true, deletedAt: true } } },
  });
  if (!worker || worker.agent.deletedAt !== null) return null;
  const memory = await q.memory.findFirst({
    where: { id: node.memoryId, deletedAt: null },
    select: { id: true, class: true, isInstallMemory: true, appId: true, installOfAgentId: true },
  });
  if (!memory) return null;
  if (memory.class === 'system' && memory.isInstallMemory && memory.appId === worker.appId && memory.installOfAgentId) {
    if (node.loc === 'boot:compiled') return { scope: 'APP_ROLE', appId: worker.appId, agentId: memory.installOfAgentId };
    if (/^boot:workers:[^:]+:compiled$/.test(node.loc)) return { scope: 'WORKER', appId: worker.appId, agentId: memory.installOfAgentId };
    return null;
  }
  if (node.loc === 'boot:compiled' && worker.agent.systemMemoryId === memory.id) return { scope: 'AGENT_SYSTEM', appId: worker.appId, agentId: worker.agentId };
  return null;
}

/**
 * Whether the person who signed the grant could make the edit themselves NOW: a live user who manages the App, and for the Agent's
 * system-memory source the Agent as well (V54). Judged on the spending transaction.
 */
async function signerStillEligible(q: Q, issuerUserId: string | null, own: OwnNode): Promise<boolean> {
  if (!issuerUserId) return false;
  const user = await q.user.findFirst({ where: { id: issuerUserId, deletedAt: null }, select: { id: true, roles: true } });
  if (!user) return false;
  const ctx = { db: q, userId: user.id, roles: user.roles };
  const app = await q.app.findFirst({ where: { id: own.appId, deletedAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
  if (!app || !(await managesApp(ctx, app))) return false;
  if (own.scope !== 'AGENT_SYSTEM') return true;
  const agent = await q.agent.findFirst({ where: { id: own.agentId, deletedAt: null }, select: { organizationId: true, ownerUserId: true } });
  return !!agent && (await managesAgent(ctx, agent));
}

/**
 * `issuer`: the person recorded as the grant's issuer. The database's activation guard (prisma/grant-invariants.sql) sets
 * `issuer_user_id := verified_by` in the one statement that activates a grant, and nothing else may set either afterwards except a
 * recorded account merge or an erasure, so the signer judged here IS the person whose ceremony activated it (Andi P2).
 */
interface Candidate { id: string; issuer: string | null }

/**
 * The live grants of `action` held by the worker that cover `nodeId` (#4162: the shared check, cover.ts, with this door's parameters from
 * the action's own declaration: held by the WORKER itself, never its role agent, cor:agt:040:11 V50; the edit parameter names ONE node
 * and refuses a list, the batch parameter takes a list; the edit action is single use, the batch action has no count). The hour is the
 * ACTION's lifetime limit, which the shared live definition reads (#4163). A grant is spent by its count (#4163); a USE event with no
 * count behind it (a grant stored before the count was spent) still reads spent, in the shared check. `lock`: the candidate rows are held
 * to the end of the transaction (`UPDATE` to spend, `SHARE` to hold against a revocation) and then judged on the database clock.
 */
async function candidates(q: Q, workerId: string, appId: string, action: string, nodeId: string, lock?: 'SHARE' | 'UPDATE'): Promise<Candidate[]> {
  const param = action === BOOT_PROMPT_EDIT_ACTION ? 'sourceNode' : 'compiledNode';
  const found = await findCoveringGrants(q, { appId, action: coverableAction(action), workerId, values: { [param]: nodeId }, order: 'ACTIVATED', lock });
  return found.map((g) => ({ id: g.id, issuer: g.issuerUserId }));
}

/** Whether a usable edit grant exists for this worker and node: a read, with no lock and no spend (the fast refusal). */
export async function hasUsableEditGrant(q: Q, workerId: string, node: BootPromptNodeFacts): Promise<boolean> {
  const own = await ownBootPromptNode(q, workerId, node, 'source');
  if (!own) return false;
  for (const c of await candidates(q, workerId, own.appId, BOOT_PROMPT_EDIT_ACTION, node.id)) {
    if (await signerStillEligible(q, c.issuer, own)) return true;
  }
  return false;
}

/**
 * Spend one edit grant for `node`, in the caller's transaction. The candidate rows are locked FOR UPDATE (one statement, in id order), THEN
 * judged on the database clock (a grant that expired, was revoked or was spent while this waited reads dead), and only then
 * is the `USE` event written. This is the LAST lock the edit takes (the node row is already held). False when none is usable.
 */
export async function spendEditGrant(tx: Q, workerId: string, node: BootPromptNodeFacts): Promise<boolean> {
  const own = await ownBootPromptNode(tx, workerId, node, 'source');
  if (!own) return false;
  // The candidate rows are locked FOR UPDATE in one statement and THEN judged on the database clock (cover.ts), so a grant that expired,
  // was revoked or was spent while this waited reads dead. This is the LAST lock the edit takes (the node row is already held).
  for (const c of await candidates(tx, workerId, own.appId, BOOT_PROMPT_EDIT_ACTION, node.id, 'UPDATE')) {
    if (!(await signerStillEligible(tx, c.issuer, own))) continue;
    // #4163 (cor:acl:140:03): the use is COUNTED, through the shared spend, so the grant reads spent everywhere. A miss after the row was just
    // judged live is the clock edge between the two reads: refuse, so the write rolls back (the guard's rejection aborts the transaction anyway).
    await spendGrant(tx, c.id, { appId: own.appId, workerId, sessionId: null }, () => bootPromptWorkerSessionError('update'));
    return true;
  }
  return false;
}

/**
 * The id of a live batch grant the worker holds that names this compiled node, or null. The grant has no use count, so nothing is
 * spent. With `lock` the candidate rows are held FOR SHARE (one statement, in id order) and then JUDGED on the database clock: a grant
 * that was revoked or expired while this waited behind another transaction's lock reads dead (the query that selects can be
 * evaluated before the lock is granted). A revocation then either committed first or waits for the act. Take it LAST among the
 * act's locks.
 */
export async function findBatchGrant(q: Q, workerId: string, node: BootPromptNodeFacts, lock = false): Promise<string | null> {
  const own = await batchTargetScope(q, workerId, node);
  if (!own) return null;
  for (const c of await candidates(q, workerId, own.appId, BOOT_PROMPT_BATCH_ACTION, node.id, lock ? 'SHARE' : undefined)) {
    if (await signerStillEligible(q, c.issuer, own)) return c.id;
  }
  return null;
}

export async function hasBatchGrant(q: Q, workerId: string, node: BootPromptNodeFacts, lock = false): Promise<boolean> {
  return (await findBatchGrant(q, workerId, node, lock)) !== null;
}

type Prior = { id: string; memoryId: string; loc: string; nodeType?: string | null; role?: string | null };
/** `otherFields`: the names of the fields the write SUPPLIES besides its text (and the identifiers that locate the node). */
type Next = {
  nodeType?: string | null; role?: string | null; otherFields: readonly string[];
  /** Whether the write supplies text at all: an edit without any would spend the one-use grant on a no-op. */
  hasContent: boolean;
  /** Whether the write arrived through a door that may carry the lift: `updateNode` or `hadron_update_node`, and no other (Riana F1). */
  door: boolean;
  /** Where the write says the node is: it must be where it already is (an edit in place never relocates, V46). */
  memoryId?: string; loc?: string;
};

const updateNodeDoor = new AsyncLocalStorage<true>();
/** Run `fn` as the `updateNode` mutation: the only GraphQL door whose update writes may spend an edit grant. */
export function withUpdateNodeDoor<T>(fn: () => Promise<T>): Promise<T> { return updateNodeDoor.run(true, fn); }

/** What a GraphQL write core tells the grant predicate about itself: its door, its location and what it supplies besides text. */
export function graphqlEditFacts(input: Record<string, unknown> & { memoryId?: string; loc?: string }): Pick<Next, 'otherFields' | 'hasContent' | 'door' | 'memoryId' | 'loc'> {
  return { otherFields: suppliedNonTextFields(input), hasContent: input.content !== undefined, door: updateNodeDoor.getStore() === true, memoryId: input.memoryId, loc: input.loc };
}

/** The identifiers and the text itself: the only supplied fields an in-place TEXT edit may carry (V46). `role` and `nodeType` are compared with the prior row's by {@link isGrantableEdit}, not listed here. */
const TEXT_EDIT_KEYS: ReadonlySet<string> = new Set(['id', 'memoryId', 'loc', 'urn', 'content', 'authoredWith', 'expectedRevision', 'expectedRevSeq', 'reason', 'role', 'nodeType']);

/** The supplied fields of a write that are not its text: every key with a defined value outside {@link TEXT_EDIT_KEYS}. */
export function suppliedNonTextFields(input: Record<string, unknown>): string[] {
  return Object.entries(input).filter(([k, v]) => v !== undefined && !TEXT_EDIT_KEYS.has(k)).map(([k]) => k);
}

/**
 * A grantable edit changes the text of an existing boot-prompt SOURCE in place (V46): the prior row is a source (in the family,
 * not compiled), and the write leaves its role and node type as they are. Anything else is refused as before.
 */
export function isGrantableEdit(prior: Prior | null | undefined, next: Next): boolean {
  if (!prior || !isBootPromptRole(prior.role) || prior.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE) return false;
  if (next.role !== undefined && next.role !== prior.role) return false;
  if (next.nodeType !== undefined && next.nodeType !== prior.nodeType) return false;
  // Text in place only (V46): a name, properties, tags, data, edges or any other field supplied alongside is a different edit.
  if (!next.door || !next.hasContent) return false;
  if ((next.memoryId !== undefined && next.memoryId !== prior.memoryId) || (next.loc !== undefined && next.loc !== prior.loc)) return false;
  return next.otherFields.length === 0;
}

/**
 * {@link assertBootPromptWriteAllowed} with the one lift: a worker session's UPDATE that is a grantable edit passes when a usable
 * edit grant exists. A read only; the spend is {@link spendEditGrantFor}, once, in the write's transaction. Not for any other op.
 */
export async function assertBootPromptWriteAllowedOrGranted(q: Q, prior: Prior | null | undefined, next: Next, op: Parameters<typeof assertBootPromptWriteAllowed>[2]): Promise<void> {
  const workerId = boundWorkerId();
  if (op === 'update' && workerId && !inCompileScope() && isGrantableEdit(prior, next) && (await hasUsableEditGrant(q, workerId, prior!))) return;
  assertBootPromptWriteAllowed(prior, next, op);
}

/**
 * Spend the grant for a worker session's edit of a boot-prompt source, in the write's own transaction, once the final locked row is
 * known. A no-op for anyone else and for a node that is not a boot prompt. Refuses (the worker-session refusal) when the edit is not
 * grantable or no grant can be spent, so the transaction rolls back and nothing is written.
 */
export async function spendEditGrantFor(tx: Q, current: Prior | null | undefined, next: Next): Promise<void> {
  const workerId = boundWorkerId();
  if (!workerId || inCompileScope() || !current || !isBootPromptRole(current.role) || current.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE) return;
  if (!isGrantableEdit(current, next) || !(await spendEditGrant(tx, workerId, current))) throw bootPromptWorkerSessionError('update');
}

export function bootPromptGrantRequiredError(): GraphQLError {
  return new GraphQLError('BOOT_PROMPT_GRANT_REQUIRED: this compile would create a compiled node, set a pointer or provision a grant, which a batch grant never covers.', {
    extensions: { code: 'BOOT_PROMPT_GRANT_REQUIRED' },
  });
}
