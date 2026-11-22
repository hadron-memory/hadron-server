import { isSecretUseHeaderName, isSecretUsePrefix } from '../secrets/useBinding.js';
import { currentAppSecretValue, lockSecretRow } from '../secrets/appSecrets.js';
import { assertSecretUseHeader, assertUrlWithinPrefix } from '../runner/secrets.js';
/**
 * #3690 PR 2 (Grants S2a create; cor:acl:140:05 Create, :03 pending, :01, :02; rulings 0099, 0253, 0255 items 6 and 20): the ONE
 * writer of a grant row. It makes a PENDING grant and nothing else: there is no input for activation, a verifier, a signature,
 * a use count or a version, and the insert guard (prisma/grant-invariants.sql) refuses any row that arrives otherwise.
 *
 * WHO. Two callers, both judged by the caller's gate (resolvers.grantCreate.ts) and re-judged here under the locks it took, BEFORE
 * the first write. A bound worker, in its own App, for ITSELF or its ROLE AGENT (`Worker.agentId`), and no one else (item 6: this
 * refusal is the rule). And (#3711) a PERSON who manages the App, for any live worker of it or an agent installed in it; the row
 * records that person as requester and no worker or session. The other callers rulings 0253 and 0255 allow (an installed
 * agent's headless run or session) are a later slice; their absence here is an omission, not the rule.
 *
 * A RUN (#3753, S2c; cor:acl:140:05 S5): a headless AppRun naming the agent asks for a grant held by ITS OWN agent in ITS OWN App, and
 * for nothing else. The holder is the run row's agent, passed by the caller from the row and checked here against the run row read
 * under lock; no input names a holder. The row records the RUN (`requested_by_run_id`) and no user, worker or session: the person a run
 * acts for is not the requester (ruling 0255 item 21). A run that is not RUNNING in this App with this agent is {@link GrantRunGone}.
 *
 * HOLDER. A grant for an agent is held by that agent IN THIS APP, so the agent must be installed and licensed here (item 20:
 * "it makes no sense to issue a grant to an agent that isn't installed"). A worker holder must belong to the grant's own App and
 * not be retired: the insert guard checks only that the holder row exists and has not gone, so this module checks the App
 * (the section 10 carry of #3792, Ralion P3 on 916a9eb1).
 *
 * VALUES. The action's declared parameters are the whole boundary: exactly the declared keys, each a value
 * `grantTermsBytes` can write (a string, the wildcard where the parameter allows it, or a list of distinct strings), judged
 * by its parameter's declared type (cor:acl:140:01, :02). The type check is a SHAPE: no undeclared key is stored, and the one
 * type today, `node-ref`, admits only an id-shaped token (`NODE_ID_RE`), never free text. Shape alone says nothing about the
 * node, so (V86, #4067; the Create line of hrn:node:hadronmemory.com:specs:cor:acl:140:05) a node-typed value must also name a
 * live node the REQUESTER can read, or the call is refused: a merely id-shaped token, a missing, deleted or unreadable node
 * all get the one GRANT_VALUES_INVALID answer. The reason is the signer, which shows every node as its URN
 * (hrn:node:hadronmemory.com:specs:cor:acl:140:07): an id that resolves to nothing could never be signed. The check is
 * made at creation only: a node deleted or made unreadable AFTER the grant is stored is not checked here (the signing page
 * treats it as unsignable, #3805), so a stored grant does not always name a live node. A new parameter type brings its own
 * rule (an unknown type is refused) and must say what it admits. A refusal names the term, never the value. (#3829 G,
 * George on #3814.)
 *
 * LOCKS. The caller holds the App, requester-user and (for an agent holder) agent authority anchors. This module then locks the
 * requester's worker row FOR SHARE, so a `retireWorker` that committed first is seen, and one that comes next waits for this
 * transaction and ends the new row through `endHeldGrants` (src/lib/grants/departure.ts; the insert guard's own FOR SHARE on the
 * holder is the backstop). Anchors before rows, agent before worker: the order every departure door takes.
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { isAgentInstalledAndLicensed } from '../appAgent.js';
import { generateId } from '../id.js';
import { autoDeleteLimitRefusal } from '../secrets/autoDelete.js';
import { isModelReadableKind } from '../secrets.js';
import { grantTermsBytes, GrantTermsError, type GrantHolderKind } from './terms.js';

export type GrantCreateCode =
  | 'GRANT_REQUESTER_NOT_WORKER'
  | 'GRANT_HOLDER_NOT_ALLOWED'
  | 'GRANT_ACTION_UNKNOWN'
  | 'GRANT_VALUES_INVALID'
  | 'GRANT_TERMS_INVALID'
  | 'SECRET_AUTO_DELETE_NEEDS_LIMIT';

const MESSAGES: Record<GrantCreateCode, string> = {
  SECRET_AUTO_DELETE_NEEDS_LIMIT: 'An auto-delete mark needs a window or a read budget.',
  GRANT_REQUESTER_NOT_WORKER: 'A grant can be requested only from a bound worker session in its own App.',
  GRANT_HOLDER_NOT_ALLOWED: 'A grant can be asked for only for a worker of the App or an agent installed in it (a worker session: only itself or its role agent).',
  GRANT_ACTION_UNKNOWN: 'That action is not registered.',
  GRANT_VALUES_INVALID: 'The values do not match the action\'s declared parameters.',
  GRANT_TERMS_INVALID: 'The grant\'s terms cannot be recorded.',
};

/** A refusal of a create. The text is fixed for each refusal case: it never carries a submitted value or an id. */
export class GrantCreateRefusal extends Error {
  constructor(readonly code: GrantCreateCode, readonly detail?: string) {
    // Fixed bound messages name only the ruled limit, never a submitted value.
    super(code === 'GRANT_TERMS_INVALID' && detail === 'REASON_TOO_LONG'
      ? 'A grant reason must contain at most 2,000 characters.'
      : code === 'GRANT_VALUES_INVALID' && detail === 'LIST_TOO_LONG'
        ? 'Each grant value list must contain at most 100 entries.'
        : code === 'GRANT_TERMS_INVALID' && detail === 'MAX_USES_OUTSIDE_ACTION_LIMIT'
          ? 'This action limits its uses: the grant must state a count of uses no higher than the action allows.'
          : MESSAGES[code]);
    this.name = 'GrantCreateRefusal';
  }
}

/** The asker is a headless run (#3753): its own id and the agent the run row names (the only holder it may have). */
export interface RunRequester { runId: string; agentId: string }

/** A run that is not a live run of this App for this agent, judged on the locked row. Concealing: the tool answers it as APP_NOT_FOUND. */
export class GrantRunGone extends Error {
  constructor() { super('App not found.'); this.name = 'GrantRunGone'; }
}

/** The asker. `workerId` null is a PERSON who manages the App (#3711, the caller's gate has judged `managesApp` under the same locks); a worker id is a bound worker session. */
export interface GrantRequester { userId: string; workerId: string | null; sessionId: string | null }

export interface CreateGrantArgs {
  appId: string;
  requester: GrantRequester | RunRequester;
  holder: { kind: GrantHolderKind; id: string };
  action: string;
  values: unknown;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  maxUses?: number | null;
  reason: string;
  /** The agent whose authority anchor the caller holds (null: none). An agent holder is accepted only if it is exactly this agent. */
  heldAgentAnchor?: string | null;
  /**
   * V86 (#4067, cor:acl:140:07): whether the REQUESTER can read this memory, judged on the transaction's own context (the calling
   * worker's session on the worker arm, the person on the manager arm). A node-typed value must name a node in a memory this says yes to.
   */
  canReadMemory: (memoryId: string) => Promise<boolean>;
}

// #3834 / ruling0266, cor:acl:140:01: admission only; stored terms remain rebuildable under :09.
const MAX_REASON_CHARACTERS = 2000;
const MAX_LIST_ENTRIES = 100;

/** A stored node id: a token with no scheme, colon, dot, space or newline (cuids, 32-hex ids), never a URN or free text. */
const NODE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Judge a value by its parameter's declared type. An unknown type is refused (fail closed), so a new type needs its rule here. */
function valueMatchesType(type: string, value: unknown): boolean {
  // #3998 (cor:acl:140:09, secret forms): a secret id is ONE stored id, never a list or the wildcard; the mark is one of two tokens, exactly.
  if (type === 'secret-ref') return typeof value === 'string' && NODE_ID_RE.test(value);
  if (type === 'secret-mark') return value === 'keep' || value === 'delete';
  if (type === 'https-prefix') return isSecretUsePrefix(value);
  if (type === 'header-name') return isSecretUseHeaderName(value);
  if (type !== 'node-ref') return false;
  const one = (v: unknown) => v === '*' || (typeof v === 'string' && NODE_ID_RE.test(v));
  return Array.isArray(value) ? value.every(one) : one(value);
}

/** The one action a person may hold (#3998). */
const SECRET_REVEAL_ACTION = 'secret.reveal';

interface ActionRow { name: string; parameters: unknown; max_uses: number | null }
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

  // A run asks (#3753): the run row, locked FOR SHARE after the caller's anchors, must be RUNNING in this App and name this agent, so a run
  // that finished first is seen here and one that finishes next waits for this transaction. No person or worker is read or credited.
  const run = 'runId' in requester ? requester : null;
  const person = 'runId' in requester ? null : requester;
  if (run) {
    const rows = await tx.$queryRaw<Array<{ app_id: string; agent_id: string | null; status: string }>>`
      SELECT app_id, agent_id, status::text AS status FROM app_runs WHERE id = ${run.runId} FOR SHARE`;
    if (rows.length !== 1 || rows[0]!.app_id !== appId || rows[0]!.agent_id !== run.agentId || rows[0]!.status !== 'RUNNING') throw new GrantRunGone();
    // The holder is exactly the run's own agent, anchored by the caller: any other kind or id is the one holder refusal.
    if (holder.kind !== 'agent' || holder.id !== run.agentId) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  }

  // The requester: a live person (and, for a worker session, a live worker of THIS App), locked so a retirement either committed (seen here) or waits.
  if (person) {
    const users = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${person.userId} AND deleted_at IS NULL FOR SHARE`;
    if (users.length === 0) throw new GrantCreateRefusal('GRANT_REQUESTER_NOT_WORKER');
  }
  let me: WorkerRow | null = null;
  if (person && person.workerId !== null) {
    const workers = await tx.$queryRaw<WorkerRow[]>`
      SELECT id, app_id, agent_id, retired_at FROM workers WHERE id = ${person.workerId} FOR SHARE`;
    me = workers[0] ?? null;
    if (!me || me.retired_at !== null || me.app_id !== appId) throw new GrantCreateRefusal('GRANT_REQUESTER_NOT_WORKER');
  }

  // The holder. A worker session: itself or its role agent. A manager (no `me`): any live worker of this App, or an agent installed
  // and licensed in it (#3711, cor:acl:140:05; ruling 0253 item 4). Anything else, and anything outside this App, is the one refusal.
  if (holder.kind === 'worker') {
    // A use grant is consumed only by a run of its agent or App (readClientReveal prepareSecretUse); a worker holder could never consume it,
    // so signing one would mint a live read client nothing can read. Refused here, not left to fail at use.
    if (args.action === 'secret.use') throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
    if (me && holder.id !== me.id) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
    // Carry 1 (#3792, Ralion): the insert guard checks that a worker holder EXISTS, not that it belongs to this App.
    const held = await tx.$queryRaw<WorkerRow[]>`SELECT id, app_id, agent_id, retired_at FROM workers WHERE id = ${holder.id} FOR SHARE`;
    if (!held[0] || held[0].app_id !== appId || held[0].retired_at !== null) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  } else if (holder.kind === 'agent') {
    // The locked worker row names the role agent NOW; the caller anchored the agent it saw before locking. A role change between
    // the two (A to B) would otherwise accept an agent no anchor protects, so the holder must be both: refuse on drift. A manager
    // has no role agent: the caller anchored the named agent itself, so the holder must be exactly the anchored one.
    if ((me && holder.id !== me.agent_id) || args.heldAgentAnchor !== holder.id) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
    // Held by the agent in this App: installed, licensed and not deleted here, judged on the locked state.
    const agents = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ${holder.id} AND deleted_at IS NULL FOR SHARE`;
    if (agents.length === 0 || !(await isAgentInstalledAndLicensed(tx, appId, holder.id))) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  } else if (holder.kind === 'app' && args.action === 'secret.use' && !me && holder.id === appId) {
    // Only this App's run may consume an App-held use grant; keep the holder alive until insertion.
    const apps = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM apps WHERE id = ${holder.id} AND deleted_at IS NULL FOR SHARE`;
    if (apps.length === 0) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  } else if (holder.kind === 'user' && args.action === SECRET_REVEAL_ACTION) {
    // #3998: a PERSON holds a secret.reveal grant (the one action that reads its secret on a server-hosted passkey page). Live,
    // locked FOR SHARE so an erasure that comes next waits and ends the new row through endHeldGrants. No other action has a person holder.
    const people = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${holder.id} AND deleted_at IS NULL FOR SHARE`;
    if (people.length === 0) throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  } else {
    throw new GrantCreateRefusal('GRANT_HOLDER_NOT_ALLOWED');
  }

  // The action: a registered row (no free-text stand-in). Its declared parameters are the values' whole boundary.
  const actions = await tx.$queryRaw<ActionRow[]>`SELECT name, parameters, max_uses FROM actions WHERE name = ${args.action}`;
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
    if (Array.isArray(v) && v.length > MAX_LIST_ENTRIES) throw new GrantCreateRefusal('GRANT_VALUES_INVALID', 'LIST_TOO_LONG');
    if (!valueMatchesType(p.type, v)) throw new GrantCreateRefusal('GRANT_VALUES_INVALID', `${p.name} is not a ${p.type}`);
    if (p.refusesWildcard && v === '*') throw new GrantCreateRefusal('GRANT_VALUES_INVALID', `${p.name} refuses a wildcard`);
  }

  // V86 (#4067, ruling 0265, cor:acl:140:07): a grant may name only a node its REQUESTER can read. The signer shows every node as its
  // canonical URN, so an id that resolves to nothing could never be signed. A missing, deleted or unreadable node is the SAME refusal
  // (same code, same detail as a malformed id), so this is no existence oracle. Judged before the insert: a refusal stores nothing.
  for (const p of declared) {
    if (p.type !== 'node-ref') continue;
    const v = (values as Record<string, unknown>)[p.name];
    const ids = [...new Set((Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== '*'))];
    if (ids.length === 0) continue;
    const nodes = await tx.node.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, memoryId: true } });
    let ok = nodes.length === ids.length;
    for (const memoryId of ok ? new Set(nodes.map((n) => n.memoryId)) : []) {
      if (!(await args.canReadMemory(memoryId))) { ok = false; break; }
    }
    if (!ok) throw new GrantCreateRefusal('GRANT_VALUES_INVALID', `${p.name} is not a ${p.type}`);
  }

  // #3998: a secret-ref names a secret of THIS App whose kind a model may read (an inject-only kind has no reveal client). A missing,
  // other-App, org, user or inject-only secret is the same refusal as a malformed id, so this is no existence oracle.
  for (const p of declared) {
    if (p.type !== 'secret-ref') continue;
    const secretId = (values as Record<string, unknown>)[p.name] as string;
    // Judge ownership before locking, so a secret of another App is never locked on a requester's say-so.
    if (action.name === 'secret.use' && !(await tx.secret.findFirst({ where: { id: secretId, ownerType: 'app', ownerId: appId }, select: { id: true } }))) {
      throw new GrantCreateRefusal('GRANT_VALUES_INVALID', `${p.name} is not a ${p.type}`);
    }
    if (action.name === 'secret.use' && !(await lockSecretRow(tx, secretId))) throw new GrantCreateRefusal('GRANT_VALUES_INVALID', `${p.name} is not a ${p.type}`);
    const secret = await tx.secret.findFirst({ where: { id: secretId, ownerType: 'app', ownerId: appId }, select: { kind: true, metadata: true } });
    if (!secret || (action.name === 'secret.use' ? secret.kind !== 'webfetch-auth' : !isModelReadableKind(secret.kind))) throw new GrantCreateRefusal('GRANT_VALUES_INVALID', `${p.name} is not a ${p.type}`);
    if (action.name === 'secret.use') {
      try {
        const value = await currentAppSecretValue(tx, { id: secretId, ownerId: appId });
        assertSecretUseHeader((values as Record<string, unknown>)['binding-header'] as string, value, {});
        // The same judgment prepareSecretUse makes at use (blind seat P2-1, #4776): a grant whose signed prefix lies outside the secret's own
        // urlPrefix, or whose secret has no urlPrefix or a different auth type, could never be used, so it is never signable.
        const metadata = secret.metadata as Record<string, unknown> | null;
        if (!metadata || typeof metadata.urlPrefix !== 'string' || metadata.type !== (value as { type?: unknown }).type) throw new Error('metadata');
        assertUrlWithinPrefix((values as Record<string, unknown>)['binding-prefix'] as string, metadata.urlPrefix);
      } catch {
        throw new GrantCreateRefusal('GRANT_VALUES_INVALID', 'Invalid secret use binding');
      }
    }
  }

  // Count Unicode code points like task findings, with a UTF-16 fast bound so counting work is bounded.
  // Do NOT put this admission rule in grantTermsBytes: pre-existing larger rows must stay signable/verifiable.
  if (typeof args.reason === 'string' && (args.reason.length > MAX_REASON_CHARACTERS * 2 || Array.from(args.reason).length > MAX_REASON_CHARACTERS)) {
    throw new GrantCreateRefusal('GRANT_TERMS_INVALID', 'REASON_TOO_LONG');
  }

  // Every term is written exactly as the signature will cover it, so a row that cannot be written as `hadron-grant-terms-v1`
  // is refused now and never becomes a grant nobody can sign.
  const startsAt = args.startsAt ?? null;
  const expiresAt = args.expiresAt ?? null;
  const maxUses = args.maxUses ?? null;
  const limit = autoDeleteLimitRefusal(['secret.reveal', 'secret.use'].includes(args.action) && (values as Record<string, unknown>)['auto-delete'] === 'delete', expiresAt, maxUses);
  if (limit) throw new GrantCreateRefusal(limit.code);
  try {
    grantTermsBytes({ appId, holder, action: action.name, values, startsAt, expiresAt, maxUses, reason: args.reason });
  } catch (e) {
    if (e instanceof GrantTermsError) throw new GrantCreateRefusal(e.reason === 'BAD_VALUES' ? 'GRANT_VALUES_INVALID' : 'GRANT_TERMS_INVALID', e.reason);
    throw e;
  }
  if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) throw new GrantCreateRefusal('GRANT_TERMS_INVALID', 'expires must follow starts');
  // #4163 (cor:acl:140:02, V50): an action that limits its uses has its grants written to say so. The grant's own count can only
  // narrow the action's, and it must be stated, so the signed terms show the limit the signer is told of ("once") and the count is
  // spent on the row. A grant outside the bound is refused now and stores nothing.
  if (action.max_uses !== null && (maxUses === null || maxUses > action.max_uses)) {
    throw new GrantCreateRefusal('GRANT_TERMS_INVALID', 'MAX_USES_OUTSIDE_ACTION_LIMIT');
  }

  const id = generateId();
  // (kind app is refused above; kind user only for secret.reveal)
  const userId = holder.kind === 'user' ? holder.id : null;
  const agentId = holder.kind === 'agent' ? holder.id : null;
  const workerId = holder.kind === 'worker' ? holder.id : null;
  const granteeAppId = holder.kind === 'app' ? holder.id : null;
  const asker = person ? { ...person, runId: null } : { userId: null, workerId: null, sessionId: null, runId: run!.runId };
  await tx.$executeRaw`
    INSERT INTO grants (id, app_id, user_id, agent_id, worker_id, grantee_app_id, requested_by_user_id, requested_by_worker_id, requested_by_session_id, requested_by_run_id,
                        action, action_values, starts_at, expires_at, max_uses, reason, created_at, updated_at)
    VALUES (${id}, ${appId}, ${userId}, ${agentId}, ${workerId}, ${granteeAppId}, ${asker.userId}, ${asker.workerId}, ${asker.sessionId}, ${asker.runId},
            ${action.name}, ${JSON.stringify(values)}::jsonb, ${startsAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC', ${expiresAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC', ${maxUses}, ${args.reason},
            (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`;
  return id;
}
