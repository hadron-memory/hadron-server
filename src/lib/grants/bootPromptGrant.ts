/**
 * #3823 (ruling 0267; cor:agt:040:11 r8, cor:agt:040:12 r21, cor:agt:040:18 r9, cor:acl:140:01, :04): the two grants that let a
 * worker session touch its OWN boot prompt.
 *
 *  - `bootprompt.source.edit`: change the TEXT of one existing source node, in place, once. Held by the worker, naming ONE node,
 *    good for an hour from activation (the platform's hour, not the grant's `expires_at`, which may only shorten it), signed by a
 *    person who could make the edit themselves. Spending it writes one `USE` event in the edit's own transaction, under the grant
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
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { Prisma as P } from '../../generated/prisma/index.js';
import { managesAgent, managesApp } from '../auth/appManagement.js';
import {
  COMPILED_BOOT_PROMPT_NODE_TYPE, assertBootPromptWriteAllowed, boundWorkerId, bootPromptWorkerSessionError,
  inCompileScope, isBootPromptRole,
} from '../bootPrompt.js';
import { GRANT_DB_NOW, grantLiveSql, readGrantForUpdate } from './live.js';

export const BOOT_PROMPT_EDIT_ACTION = 'bootprompt.source.edit';
export const BOOT_PROMPT_BATCH_ACTION = 'bootprompt.compile.approve';

type Q = Prisma.TransactionClient;
export interface BootPromptNodeFacts { id: string; memoryId: string; loc: string }

/** Where an own node sits; it decides what the signer must manage. */
export type OwnScope = 'WORKER' | 'APP_ROLE' | 'AGENT_SYSTEM';
export interface OwnNode { scope: OwnScope; appId: string; agentId: string }

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

interface Candidate { id: string; issuer: string | null }

/**
 * The live grants of `action` held by `workerId` in `appId` that name `nodeId` and are inside their hour. `single`: the value must be
 * exactly one node id (an edit grant names ONE source; a list or wildcard names none), and a grant with a USE event is spent.
 */
async function candidates(q: Q, workerId: string, appId: string, action: string, nodeId: string, single: boolean, onlyId?: string): Promise<Candidate[]> {
  const param = single ? 'sourceNode' : 'compiledNode';
  const names = single
    ? P.sql`(jsonb_typeof(g.action_values->${param}) = 'string' AND g.action_values->>${param} = ${nodeId})`
    : P.sql`(g.action_values->${param} @> to_jsonb(${nodeId}::text))`;
  const rows = await q.$queryRaw<Array<{ id: string; issuer_user_id: string | null }>>(P.sql`
    SELECT g.id, g.issuer_user_id FROM grants g
     WHERE g.worker_id = ${workerId} AND g.app_id = ${appId} AND g.action = ${action}
       AND ${onlyId === undefined ? P.sql`TRUE` : P.sql`g.id = ${onlyId}`}
       AND ${names}
       AND ${grantLiveSql('g')}
       AND g.activated_at + interval '1 hour' > ${GRANT_DB_NOW}
       AND ${single ? P.sql`NOT EXISTS (SELECT 1 FROM grant_events e WHERE e.grant_id = g.id AND e.action = 'USE')` : P.sql`TRUE`}
     ORDER BY g.activated_at, g.id`);
  return rows.map((r) => ({ id: r.id, issuer: r.issuer_user_id }));
}

/** Whether a usable edit grant exists for this worker and node: a read, with no lock and no spend (the fast refusal). */
export async function hasUsableEditGrant(q: Q, workerId: string, node: BootPromptNodeFacts): Promise<boolean> {
  const own = await ownBootPromptNode(q, workerId, node, 'source');
  if (!own) return false;
  for (const c of await candidates(q, workerId, own.appId, BOOT_PROMPT_EDIT_ACTION, node.id, true)) {
    if (await signerStillEligible(q, c.issuer, own)) return true;
  }
  return false;
}

/**
 * Spend one edit grant for `node`, in the caller's transaction. Each candidate row is locked FOR UPDATE in its own statement, THEN
 * judged again on the database clock (a grant that expired, was revoked or was spent while this waited reads dead), and only then
 * is the `USE` event written. This is the LAST lock the edit takes (the node row is already held). False when none is usable.
 */
export async function spendEditGrant(tx: Q, workerId: string, node: BootPromptNodeFacts): Promise<boolean> {
  const own = await ownBootPromptNode(tx, workerId, node, 'source');
  if (!own) return false;
  for (const c of await candidates(tx, workerId, own.appId, BOOT_PROMPT_EDIT_ACTION, node.id, true)) {
    if (!(await readGrantForUpdate(tx, c.id))) continue;
    const [again] = await candidates(tx, workerId, own.appId, BOOT_PROMPT_EDIT_ACTION, node.id, true, c.id);
    if (!again || !(await signerStillEligible(tx, again.issuer, own))) continue;
    await tx.grantEvent.create({ data: { grantId: again.id, appId: own.appId, action: 'USE', workerId } });
    return true;
  }
  return false;
}

/** Whether the worker holds a live batch grant naming this compiled node (a read; no spend, the grant has no use count). */
export async function hasBatchGrant(q: Q, workerId: string, node: BootPromptNodeFacts): Promise<boolean> {
  const own = await ownBootPromptNode(q, workerId, node, 'compiled');
  if (!own) return false;
  for (const c of await candidates(q, workerId, own.appId, BOOT_PROMPT_BATCH_ACTION, node.id, false)) {
    if (await signerStillEligible(q, c.issuer, own)) return true;
  }
  return false;
}

type Prior = { id: string; memoryId: string; loc: string; nodeType?: string | null; role?: string | null };
type Next = { nodeType?: string | null; role?: string | null };

/**
 * A grantable edit changes the text of an existing boot-prompt SOURCE in place (V46): the prior row is a source (in the family,
 * not compiled), and the write leaves its role and node type as they are. Anything else is refused as before.
 */
export function isGrantableEdit(prior: Prior | null | undefined, next: Next): boolean {
  if (!prior || !isBootPromptRole(prior.role) || prior.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE) return false;
  if (next.role !== undefined && next.role !== prior.role) return false;
  if (next.nodeType !== undefined && next.nodeType !== prior.nodeType) return false;
  return true;
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
