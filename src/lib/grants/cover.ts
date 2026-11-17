/**
 * #4162 (cor:acl:140:10, :02, :03, :06; cor:agt:040:11; Holger 2026-11-13: grant support for a subject is generic): the ONE check for
 * which grant covers an act, and the ONE spend, so every door that uses a grant asks the same question the same way, as
 * `live.ts` already does for "is this grant live". The boot-prompt door and the trigger door call it, and so will secrets (S3, S5).
 *
 * WHAT IS GENERIC, AND WHAT IS NOT. Three behaviours the first draft of this issue treated as drift are RULED per action, so each is a
 * parameter of the check, read from the action's own declaration (actions.ts), never a universal here:
 *  - REACH (`action.reach`): who may hold a grant that covers a worker's act. A boot-prompt grant is held by the worker itself, not its
 *    role agent (cor:agt:040:11 V50); a trigger grant's role agent reaches its live workers (cor:acl:140:06, Decided); a person-held
 *    `secret.reveal` reaches no agent or worker (R5, Decided: `NO_WORKER`).
 *  - LIST acceptance (`action.listParameters`): whether a parameter's value may be a LIST of ids, a grant covering any member. Nothing
 *    declared it before: the edit door hard-coded "a list is no match", the batch and trigger doors used membership.
 *  - The COUNT rule (`action.maxUses`): the edit action is single use, the batch action has no count. When an action states a count, a
 *    grant's own cap may not exceed it, and a grant stored with as many USE events as the count is spent although its `use_count` says
 *    zero (a grant used before the count existed, #4163's migration guard, ruling 0259). With no action count, neither applies.
 *
 * WHAT IS NOT HERE. The hour (an action's lifetime from activation) and the count's `use_count` arithmetic belong to the shared live
 * definition (`grantLiveSql`, `chargeGrantUse` in live.ts, #4163): this module calls them and states neither (a grep pin).
 *
 * COVER, by the parameter's declared TYPE: for a reference type (`node-ref`, `secret-ref`) the stored value is the act's id, or a list
 * holding it where the parameter declares lists, or the wildcard where the action accepts one. An unknown type covers nothing. An act
 * must name a value for EVERY declared parameter. {@link valueCovers} and {@link coverSql} are two spellings of one rule, pinned
 * against each other (cover4162.test.ts), as `live3668.test.ts` does for live.
 *
 * LOCKS. With `lock` the candidate rows (cover + holder only) are locked in id order in one statement, THEN judged on the database
 * clock in a second (lock-then-judge, as `readGrantForUpdate` does for one row), and the caller takes this as its LAST lock.
 * An act no grant covers gets the DOOR'S own no-grant refusal: this module returns no grant and names none.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { PLATFORM_ACTIONS, type ActionParameter, type GrantReach } from './actions.js';
import { chargeGrantUse, grantLiveSql } from './live.js';
import { workersReachedByGrant } from './reach.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** The parts of an action's declaration the check reads. {@link PLATFORM_ACTIONS} entries satisfy it. */
export interface CoverableAction {
  name: string;
  parameters: readonly ActionParameter[];
  reach?: GrantReach;
  listParameters?: readonly string[];
  maxUses?: number;
}

/** The declaration of a platform action by name. */
export function coverableAction(name: string): CoverableAction {
  const a = PLATFORM_ACTIONS.find((x) => x.name === name);
  if (!a) throw new Error(`unknown platform action ${name}`);
  return a;
}

/** The parameter types whose value is a reference to something with an id; any other type covers nothing. */
const REFERENCE_TYPES: ReadonlySet<string> = new Set(['node-ref', 'secret-ref']);
const WILDCARD = '*';

/** Whether a grant's stored value for `param` covers an act that names `id` there. */
export function valueCovers(action: CoverableAction, param: string, stored: unknown, id: string): boolean {
  const p = action.parameters.find((x) => x.name === param);
  if (!p || !REFERENCE_TYPES.has(p.type)) return false;
  if (typeof stored === 'string') return stored === WILDCARD ? !p.refusesWildcard : stored === id;
  if (Array.isArray(stored)) return id !== WILDCARD && (action.listParameters ?? []).includes(param) && stored.some((x) => typeof x === 'string' && x === id);
  return false;
}

/** The SQL spelling of {@link valueCovers} for one parameter, over `col` (the jsonb value). */
function valueCoversSql(action: CoverableAction, p: ActionParameter, col: Prisma.Sql, id: string): Prisma.Sql {
  const arms: Prisma.Sql[] = [Prisma.sql`(jsonb_typeof(${col}) = 'string' AND (${col} #>> '{}') = ${id} AND (${col} #>> '{}') <> ${WILDCARD})`];
  if ((action.listParameters ?? []).includes(p.name) && id !== WILDCARD) arms.push(Prisma.sql`(jsonb_typeof(${col}) = 'array' AND ${col} ? ${id})`);
  if (!p.refusesWildcard) arms.push(Prisma.sql`(jsonb_typeof(${col}) = 'string' AND (${col} #>> '{}') = ${WILDCARD})`);
  return Prisma.sql`(${Prisma.join(arms, ' OR ')})`;
}

/** The SQL spelling of "this grant's values cover the act" over the grants table aliased `alias` (a literal, never input). */
export function coverSql(action: CoverableAction, alias: string, values: Record<string, string>): Prisma.Sql {
  const a = Prisma.raw(`"${alias.replace(/"/g, '')}"`);
  if (action.parameters.length === 0) return Prisma.sql`FALSE`;
  const parts: Prisma.Sql[] = [];
  for (const p of action.parameters) {
    const id = values[p.name];
    if (typeof id !== 'string' || !REFERENCE_TYPES.has(p.type)) return Prisma.sql`FALSE`;
    parts.push(valueCoversSql(action, p, Prisma.sql`(${a}.action_values -> ${p.name})`, id));
  }
  return Prisma.sql`(${Prisma.join(parts, ' AND ')})`;
}

/** The count rule of an action that states one (see the module comment): a grant's own cap within it, and no more USE events than it. */
function countRuleSql(action: CoverableAction, alias: string): Prisma.Sql {
  if (action.maxUses === undefined) return Prisma.sql`TRUE`;
  const a = Prisma.raw(`"${alias.replace(/"/g, '')}"`);
  return Prisma.sql`((${a}.max_uses IS NULL OR ${a}.max_uses <= ${action.maxUses})
    AND (SELECT count(*) FROM grant_events cover_ev WHERE cover_ev.grant_id = ${a}.id AND cover_ev.action = 'USE') < ${action.maxUses})`;
}

export interface CoverArgs {
  appId: string;
  action: CoverableAction;
  /** The worker acting. (A run or a person as the actor comes with the doors that need it.) */
  workerId: string;
  /** The worker's role agent, for an action whose reach includes it; ignored otherwise. */
  roleAgentId?: string | null;
  /** The act's id for EACH declared parameter. */
  values: Record<string, string>;
  /** Lock the candidate rows to the end of the caller's transaction (`UPDATE` to spend, `SHARE` to hold against a revocation). Omit for a read. */
  lock?: 'SHARE' | 'UPDATE';
  /** `CAPPED_FIRST`: a capped grant before an uncapped one, then the oldest created (the trigger door); `ACTIVATED`: oldest activation first (the boot-prompt door). */
  order: 'CAPPED_FIRST' | 'ACTIVATED';
  /** Judge only this grant (the caller already chose it). */
  onlyId?: string;
}

export interface CoveringGrant { id: string; maxUses: number | null; issuerUserId: string | null }

/**
 * The live grants that cover this act and reach this worker, in the door's order. Empty when none does, including when the action's
 * reach is `NO_WORKER`. Reads nothing about the act's own refusal and spends nothing.
 */
export async function findCoveringGrants(db: Db, a: CoverArgs): Promise<CoveringGrant[]> {
  const reach = a.action.reach ?? 'WORKER';
  if (reach === 'NO_WORKER') return [];
  const holder = reach === 'WORKER_OR_ROLE_AGENT' && a.roleAgentId
    ? Prisma.sql`(g.worker_id = ${a.workerId} OR g.agent_id = ${a.roleAgentId})`
    : Prisma.sql`g.worker_id = ${a.workerId}`;
  const only = a.onlyId === undefined ? Prisma.empty : Prisma.sql` AND g.id = ${a.onlyId}`;
  const lock = a.lock === 'UPDATE' ? Prisma.sql` FOR UPDATE` : a.lock === 'SHARE' ? Prisma.sql` FOR SHARE` : Prisma.empty;
  const locked = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT g.id FROM grants g
    WHERE g.app_id = ${a.appId} AND g.action = ${a.action.name} AND ${holder} AND ${coverSql(a.action, 'g', a.values)}${only}
    ORDER BY g.id${lock}`);
  if (locked.length === 0) return [];
  const order = a.order === 'CAPPED_FIRST' ? Prisma.sql`(g.max_uses IS NULL), g.created_at, g.id` : Prisma.sql`g.activated_at, g.id`;
  const judged = await db.$queryRaw<Array<{ id: string; max_uses: number | null; issuer_user_id: string | null }>>(Prisma.sql`
    SELECT g.id, g.max_uses, g.issuer_user_id FROM grants g
    WHERE g.id IN (${Prisma.join(locked.map((r) => r.id))}) AND ${grantLiveSql('g')} AND ${countRuleSql(a.action, 'g')}
    ORDER BY ${order}`);
  const out: CoveringGrant[] = [];
  for (const g of judged) {
    if (!(await workersReachedByGrant(db, g.id)).includes(a.workerId)) continue;
    out.push({ id: g.id, maxUses: g.max_uses, issuerUserId: g.issuer_user_id });
  }
  return out;
}

/**
 * THE spend, in the act's own transaction, on a grant the caller holds FOR UPDATE: the shared guarded `use_count + 1` (live.ts), which
 * must change exactly one row while the grant is still live, then one USE event naming the worker, the session if any and the App.
 * A miss (the grant stopped qualifying between the judgement and the guard) throws `refusal()`, the DOOR'S own refusal, so the
 * caller's transaction rolls back with nothing spent.
 */
export async function spendGrant(
  tx: Prisma.TransactionClient,
  grantId: string,
  record: { appId: string; workerId: string; sessionId: string | null },
  refusal: () => Error,
): Promise<void> {
  if (!(await chargeGrantUse(tx, grantId, record.appId))) throw refusal();
  await tx.grantEvent.create({
    data: { id: generateId(), grantId, appId: record.appId, action: 'USE', workerId: record.workerId, sessionId: record.sessionId },
  });
}
