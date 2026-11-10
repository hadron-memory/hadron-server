/**
 * #3690 PR 2 (Grants S2a create; cor:acl:140:05 Create, :03 pending, :01, :02; rulings 0099, 0253, 0255 items 6 and 20): the ONE
 * writer of a grant row. It makes a PENDING grant and nothing else: there is no input for activation, a verifier, a signature,
 * a use count or a version, and the insert guard (prisma/grant-invariants.sql) refuses any row that arrives otherwise.
 *
 * WHO. A bound worker, in its own App, for ITSELF or its ROLE AGENT (`Worker.agentId`), and no one else (item 6: this refusal is
 * the rule). The caller's gate (resolvers.grantCreate.ts) decides who is a bound worker; this module re-judges every fact the
 * insert depends on, under the locks the caller took, BEFORE the first write. The other callers rulings 0253 and 0255 allow (an
 * installed agent's headless run or session, a manager) are later slices; their absence here is an omission, not the rule.
 *
 * HOLDER. A grant for an agent is held by that agent IN THIS APP, so the agent must be installed and licensed here (item 20:
 * "it makes no sense to issue a grant to an agent that isn't installed"). A worker holder must belong to the grant's own App and
 * not be retired: the insert guard checks only that the holder row exists and has not gone, so this module checks the App
 * (the section 10 carry of #3792, Ralion P3 on 916a9eb1).
 *
 * VALUES. The action's declared parameters are the whole boundary: exactly the declared keys, each a value
 * `grantTermsBytes` can write (a string, the wildcard where the parameter allows it, or a list of distinct strings). Nothing
 * else can be stored, so no free-text secret can ride in `values` (cor:acl:140:01, :02). A refusal names the term, never the value.
 *
 * LOCKS. The caller holds the App, requester-user and (for an agent holder) agent authority anchors. This module then locks the
 * requester's worker row FOR SHARE, so a `retireWorker` that committed first is seen, and one that comes next waits for this
 * transaction and ends the new row through `endHeldGrants` (src/lib/grants/departure.ts; the insert guard's own FOR SHARE on the
 * holder is the backstop). Anchors before rows, agent before worker: the order every departure door takes.
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { isAgentInstalledAndLicensed } from '../appAgent.js';
import { generateId } from '../id.js';
import { grantTermsBytes, GrantTermsError, type GrantHolderKind } from './terms.js';

export type GrantCreateCode =
  | 'GRANT_REQUESTER_NOT_WORKER'
  | 'GRANT_HOLDER_NOT_ALLOWED'
  | 'GRANT_ACTION_UNKNOWN'
  | 'GRANT_VALUES_INVALID'
  | 'GRANT_TERMS_INVALID';

const MESSAGES: Record<GrantCreateCode, string> = {
  GRANT_REQUESTER_NOT_WORKER: 'A grant can be requested only from a bound worker session in its own App.',
  GRANT_HOLDER_NOT_ALLOWED: 'A worker can ask for a grant only for itself or its role agent, and only in its own App.',
  GRANT_ACTION_UNKNOWN: 'That action is not registered.',
  GRANT_VALUES_INVALID: 'The values do not match the action\'s declared parameters.',
  GRANT_TERMS_INVALID: 'The grant\'s terms cannot be recorded.',
};

/** A refusal of a create. The text is fixed per code: it never carries a submitted value or an id. */
export class GrantCreateRefusal extends Error {
  constructor(readonly code: GrantCreateCode, readonly detail?: string) {
    super(MESSAGES[code]);
    this.name = 'GrantCreateRefusal';
  }
}

export interface GrantRequester { userId: string; workerId: string; sessionId: string | null }

export interface CreateGrantArgs {
  appId: string;
  requester: GrantRequester;
  holder: { kind: GrantHolderKind; id: string };
  action: string;
  values: unknown;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  maxUses?: number | null;
  reason: string;
  /** The agent whose authority anchor the caller holds (null: none). An agent holder is accepted only if it is exactly this agent. */
  heldAgentAnchor?: string | null;
}

/** A stored node id: a token with no scheme, colon, dot, space or newline (cuids, 32-hex ids), never a URN or free text. */
const NODE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Judge a value by its parameter's declared type. An unknown type is refused (fail closed), so a new type needs its rule here. */
function valueMatchesType(type: string, value: unknown): boolean {
  if (type !== 'node-ref') return false;
  const one = (v: unknown) => v === '*' || (typeof v === 'string' && NODE_ID_RE.test(v));
  return Array.isArray(value) ? value.every(one) : one(value);
}

interface ActionRow { name: string; parameters: unknown }
interface WorkerRow { id: string; app_id: string; agent_id: string; retired_at: Date | null }

/** The declared parameter names of an action row (the closed list S1b seeds), or null if the row is malformed. */
function declaredParameters(parameters: unknown): Array<{ name: string; type: string; refusesWildcard: boolean }> | null {
  if (!Array.isArray(parameters)) return null;
  const out: Array<{ name: string; type: string; refusesWildcard: boolean }> = [];
  for (const p of parameters) {
    if (!p || typeof p !== 'object' || typeof (p as { name?: unknown }).name !== 'string') return null;
    out.push({ name: (p as { name: string }).name, type: String((p as { type?: unknown }).type ?? ''), refusesWildcard: (p as { refusesWildcard?: unknown }).refusesWildcard === true });
  }
  return out;
}

/**
 * Insert one PENDING grant in the caller's transaction and return its id. Every refusal is judged before the insert, so a
 * refused call leaves no row. The caller holds the authority anchors (see the module comment).
 */
export async function createPendingGrant(tx: Prisma.TransactionClient, args: CreateGrantArgs): Promise<string> {
  const { appId, requester, holder } = args;

  // The requester: a live person and a live worker of THIS App, locked so a retirement either committed (seen here) or waits.
  const users = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${requester.userId} AND deleted_at IS NULL FOR SHARE`;
  if (users.length === 0) throw new GrantCreateRefusal('GRANT_REQUESTER_NOT_WORKER');
  const workers = await tx.$queryRaw<WorkerRow[]>`
    SELECT id, app_id, agent_id, retired_at FROM workers WHERE id = ${requester.workerId} FOR SHARE`;
  const me = workers[0];
  if (!me || me.retired_at !== null || me.app_id !== appId) throw new GrantCreateRefusal('GRANT_REQUESTER_NOT_WORKER');

  // The holder: the worker itself or its role agent. Anything else, and anything outside this App, is the one refusal.
  if (holder.kind === 'worker') {
    if (holder.id !== me.id) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
    // Carry 1 (#3792, Ralion): the insert guard checks that a worker holder EXISTS, not that it belongs to this App.
    const held = await tx.$queryRaw<WorkerRow[]>`SELECT id, app_id, agent_id, retired_at FROM workers WHERE id = ${holder.id} FOR SHARE`;
    if (!held[0] || held[0].app_id !== appId || held[0].retired_at !== null) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  } else if (holder.kind === 'agent') {
    // The locked worker row names the role agent NOW; the caller anchored the agent it saw before locking. A role change between
    // the two (A to B) would otherwise accept an agent no anchor protects, so the holder must be both: refuse on drift.
    if (holder.id !== me.agent_id || args.heldAgentAnchor !== holder.id) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
    // Held by the agent in this App: installed, licensed and not deleted here, judged on the locked state.
    const agents = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ${holder.id} AND deleted_at IS NULL FOR SHARE`;
    if (agents.length === 0 || !(await isAgentInstalledAndLicensed(tx, appId, holder.id))) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  } else {
    throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  }

  // The action: a registered row (no free-text stand-in). Its declared parameters are the values' whole boundary.
  const actions = await tx.$queryRaw<ActionRow[]>`SELECT name, parameters FROM actions WHERE name = ${args.action}`;
  const action = actions[0];
  if (!action) throw new GrantCreateRefusal('GRANT_ACTION_UNKNOWN');
  const declared = declaredParameters(action.parameters);
  if (!declared) throw new GrantCreateRefusal('GRANT_VALUES_INVALID', 'action parameters unreadable');

  const values = args.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new GrantCreateRefusal('GRANT_VALUES_INVALID', 'values must be an object');
  const keys = Object.keys(values);
  if (keys.length !== declared.length || !declared.every((p) => Object.prototype.hasOwnProperty.call(values, p.name))) {
    throw new GrantCreateRefusal('GRANT_VALUES_INVALID', 'keys differ from the declared parameters');
  }
  for (const p of declared) {
    const v = (values as Record<string, unknown>)[p.name];
    if (!valueMatchesType(p.type, v)) throw new GrantCreateRefusal('GRANT_VALUES_INVALID', `${p.name} is not a ${p.type}`);
    if (p.refusesWildcard && v === '*') throw new GrantCreateRefusal('GRANT_VALUES_INVALID', `${p.name} refuses a wildcard`);
  }

  // Every term is written exactly as the signature will cover it, so a row that cannot be written as `hadron-grant-terms-v1`
  // is refused now and never becomes a grant nobody can sign.
  const startsAt = args.startsAt ?? null;
  const expiresAt = args.expiresAt ?? null;
  const maxUses = args.maxUses ?? null;
  try {
    grantTermsBytes({ appId, holder, action: action.name, values, startsAt, expiresAt, maxUses, reason: args.reason });
  } catch (e) {
    if (e instanceof GrantTermsError) throw new GrantCreateRefusal(e.reason === 'BAD_VALUES' ? 'GRANT_VALUES_INVALID' : 'GRANT_TERMS_INVALID', e.reason);
    throw e;
  }
  if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) throw new GrantCreateRefusal('GRANT_TERMS_INVALID', 'expires must follow starts');

  const id = generateId();
  // (kinds user and app were refused above: the holder column is one of this closed pair)
  const agentId = holder.kind === 'agent' ? holder.id : null;
  const workerId = holder.kind === 'worker' ? holder.id : null;
  await tx.$executeRaw`
    INSERT INTO grants (id, app_id, agent_id, worker_id, requested_by_user_id, requested_by_worker_id, requested_by_session_id,
                        action, action_values, starts_at, expires_at, max_uses, reason, created_at, updated_at)
    VALUES (${id}, ${appId}, ${agentId}, ${workerId}, ${requester.userId}, ${requester.workerId}, ${requester.sessionId},
            ${action.name}, ${JSON.stringify(values)}::jsonb, ${startsAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC', ${expiresAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC', ${maxUses}, ${args.reason},
            (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`;
  return id;
}
