/**
 * #3483 (Grants phase 3, first control; cor:agt:010:01 rev 46 "A worker always needs a grant", cor:acl:140:03 / :06): a
 * worker-bound session needs a live, signed grant to create a schedule or webhook, or to make a schedule edit that re-captures
 * its automation. A person's own create is unchanged.
 *
 * OFF IN EVERY BUILD until Holger's go (ruling 0179: "Until the portal has this capability, we continue as we have"). While the
 * switch is off the doors behave exactly as on main: nothing here is read, locked or spent.
 *
 * What admits (the consumer plan on #3483, gate 6756824828): a `grants` row whose action is the door's action, whose App is the
 * act's App (ruling 0255 item 20b), whose `entryNode` value is the act's RESOLVED entry node id (never a URN, never the
 * wildcard), which is live by {@link grantLiveSql} (activated by a signature, not revoked, holder not gone, App not deleted,
 * started, not expired, not spent), and which reaches the worker by {@link workersReachedByGrant} (the worker itself, or its role
 * agent's live workers in the App; never down a base chain). Anything else is the ONE refusal {@link triggerGrantRequired}.
 *
 * Spending, in the act's own transaction: the Worker row FOR SHARE first, then the candidate grant rows FOR UPDATE as the act's
 * LAST lock (the order every grant ender uses: holder rows, then grant rows), judged after the lock on the database clock, then a
 * guarded `use_count + 1` that must change exactly one row, and one `grant_events` USE row (worker, session, App). The act's
 * own write follows in the same transaction, so a refused or failed act spends nothing and records nothing.
 */
import { GraphQLError } from 'graphql';
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { boundWorkerId } from '../bootPrompt.js';
import { currentActorAmbiguity } from '../requestActor.js';
import { generateId } from '../id.js';
import { GRANT_DB_NOW, grantLiveSql } from './live.js';
import { workersReachedByGrant } from './reach.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** The two actions this door consumes (cor:acl:140:02, seeded by #3707). */
export type TriggerGrantAction = 'schedule.create' | 'webhook.create';

/**
 * The switch. Read on every call; ONLY the exact value `true` turns enforcement on. Unset, empty, `1`, `TRUE`, `yes` and
 * anything else mean main's behaviour, so no default and no near-miss spelling enables it (#3483 acceptance 13).
 */
export function workerTriggerGrantEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKER_TRIGGER_GRANT_ENFORCED === 'true';
}

/**
 * Open in cor:agt:010:01 rev 46 (Vera's Q17, Holger decides): may a session a HOST launched spend a single-use grant? Built as
 * NO, Vera's recommendation: a launched session (`sessions.launch_operation_id` set) is admitted only by a repeating grant
 * (`max_uses` NULL). The ONE place the answer lives; the ruling changes this constant.
 */
export const HOST_LAUNCHED_MAY_SPEND_SINGLE_USE = false;

/** Whether a session of this kind may use a grant with this cap. */
export function sessionMayUseGrant(maxUses: number | null, hostLaunched: boolean, hostLaunchedMaySpendSingleUse = HOST_LAUNCHED_MAY_SPEND_SINGLE_USE): boolean {
  return maxUses === null || !hostLaunched || hostLaunchedMaySpendSingleUse;
}

const REFUSAL_MESSAGE = 'A worker needs a signed grant from a person to set up this automation. Ask a person who manages the App to grant it.';

/**
 * The ONE refusal for every miss (no grant, pending, spent, expired, revoked, holder gone, another worker, entry node, App or
 * action, a base agent's grant, a host-launched session with only a single-use grant). Fixed text: it never names a grant,
 * a worker or a value, so it is no oracle for which grants exist.
 */
export function triggerGrantRequired(): GraphQLError {
  return new GraphQLError(REFUSAL_MESSAGE, { extensions: { code: 'TRIGGER_GRANT_REQUIRED' } });
}

/** A worker-bound caller: the worker it acts as (null when that cannot be told: an ambiguous actor or a refused binding). */
export interface WorkerBoundActor { workerId: string | null; sessionId: string | null; hostLaunched: boolean }

/**
 * THE worker test (shared with `requireAdopterContext`, so the adoption doors and this door can't drift): a bound worker, an
 * ambiguous MCP actor, a refused session binding, or a session row that names a worker. Null for every other caller (a person
 * acting as themselves, and the callers the doors already handle as on main).
 */
export async function workerBoundActor(ctx: Pick<Context, 'db' | 'sessionId' | 'sessionBindingRefused'>): Promise<WorkerBoundActor | null> {
  const bound = boundWorkerId();
  const session = ctx.sessionId
    ? await ctx.db.session.findFirst({ where: { id: ctx.sessionId }, select: { workerId: true, launchOperationId: true } })
    : null;
  const sessionWorker = session?.workerId ?? null;
  if (!bound && currentActorAmbiguity() === null && !ctx.sessionBindingRefused && !sessionWorker) return null;
  const ambiguous = currentActorAmbiguity() !== null || !!ctx.sessionBindingRefused || (bound !== null && sessionWorker !== null && bound !== sessionWorker);
  return {
    workerId: ambiguous ? null : bound ?? sessionWorker,
    sessionId: session ? ctx.sessionId ?? null : null,
    hostLaunched: !!session?.launchOperationId,
  };
}

interface Candidate { id: string; max_uses: number | null; live: boolean }

/** The candidate rows for one act: this action, this App, this entry node (a single value or a list holding it), held by the worker or its agent. */
function candidatesSql(appId: string, action: TriggerGrantAction, entryNodeId: string, workerId: string, agentId: string, lock: boolean): Prisma.Sql {
  const filter = Prisma.sql`g.app_id = ${appId} AND g.action = ${action}
    AND (g.action_values -> 'entryNode' = to_jsonb(${entryNodeId}::text)
      OR (jsonb_typeof(g.action_values -> 'entryNode') = 'array' AND g.action_values -> 'entryNode' ? ${entryNodeId}))
    AND (g.worker_id = ${workerId} OR g.agent_id = ${agentId})`;
  return lock
    ? Prisma.sql`SELECT g.id FROM grants g WHERE ${filter} ORDER BY g.id FOR UPDATE`
    : Prisma.sql`SELECT g.id FROM grants g WHERE ${filter}`;
}

/**
 * The grant this act would use, or null. With `lock`, the worker row is taken FOR SHARE first (a `retireWorker` that committed
 * is seen; one that comes next waits), then the candidates FOR UPDATE in id order as the LAST lock, and only then are they
 * judged, in a second statement on the database clock (live.ts's lock-then-judge). Exactly one is chosen: a capped grant before
 * an uncapped one, then the oldest (gate 6756824828, item 4).
 */
export async function findAdmittingGrant(
  db: Db,
  args: { appId: string; action: TriggerGrantAction; entryNodeId: string | null; actor: WorkerBoundActor; lock: boolean },
): Promise<string | null> {
  const { appId, action, entryNodeId, actor, lock } = args;
  if (!actor.workerId || !entryNodeId) return null;
  const workers = lock
    ? await db.$queryRaw<Array<{ agent_id: string; app_id: string; retired_at: Date | null }>>`SELECT agent_id, app_id, retired_at FROM workers WHERE id = ${actor.workerId} FOR SHARE`
    : await db.$queryRaw<Array<{ agent_id: string; app_id: string; retired_at: Date | null }>>`SELECT agent_id, app_id, retired_at FROM workers WHERE id = ${actor.workerId}`;
  const worker = workers[0];
  if (!worker || worker.app_id !== appId || worker.retired_at !== null) return null;
  const locked = await db.$queryRaw<Array<{ id: string }>>(candidatesSql(appId, action, entryNodeId, actor.workerId, worker.agent_id, lock));
  if (locked.length === 0) return null;
  const judged = await db.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT g.id, g.max_uses, ${grantLiveSql('g')} AS live FROM grants g
    WHERE g.id IN (${Prisma.join(locked.map((r) => r.id))})
    ORDER BY (g.max_uses IS NULL), g.created_at, g.id`);
  for (const g of judged) {
    if (!g.live || !sessionMayUseGrant(g.max_uses, actor.hostLaunched)) continue;
    if ((await workersReachedByGrant(db, g.id)).includes(actor.workerId)) return g.id;
  }
  return null;
}

/**
 * Charge one use of `grantId`, which the caller holds FOR UPDATE: a guarded `use_count + 1` that must change exactly one row
 * while the grant is still live, then the USE event. Throws {@link triggerGrantRequired} when the row no longer qualifies, so
 * the caller's transaction rolls back with nothing spent.
 */
export async function spendTriggerGrant(
  tx: Prisma.TransactionClient,
  grantId: string,
  record: { appId: string; workerId: string; sessionId: string | null },
): Promise<void> {
  const changed = await tx.$executeRaw(Prisma.sql`
    UPDATE grants SET use_count = use_count + 1, updated_at = ${GRANT_DB_NOW}
    WHERE id = ${grantId} AND app_id = ${record.appId} AND ${grantLiveSql('grants')}`);
  if (changed !== 1) throw triggerGrantRequired();
  await tx.grantEvent.create({
    data: { id: generateId(), grantId, appId: record.appId, action: 'USE', workerId: record.workerId, sessionId: record.sessionId },
  });
}

/**
 * The door's admission, in the act's transaction. A no-op while the switch is off or for a caller that is not worker-bound;
 * otherwise it finds, locks and spends exactly one admitting grant, or throws the one refusal. Call it AFTER the act's own
 * refusals that need no grant and BEFORE its write, inside the same transaction as the write.
 */
export async function admitWorkerTrigger(
  tx: Prisma.TransactionClient,
  ctx: Pick<Context, 'db' | 'sessionId' | 'sessionBindingRefused'>,
  args: { appId: string; action: TriggerGrantAction; entryNodeId: string | null },
): Promise<void> {
  if (!workerTriggerGrantEnforced()) return;
  const actor = await workerBoundActor({ ...ctx, db: tx as never });
  if (!actor) return;
  const grantId = await findAdmittingGrant(tx, { ...args, actor, lock: true });
  if (!grantId) throw triggerGrantRequired();
  await spendTriggerGrant(tx, grantId, { appId: args.appId, workerId: actor.workerId!, sessionId: actor.sessionId });
}

/**
 * The preview's verdict (#3483 row 10): whether a worker-bound caller's create would be admitted, with no lock and no spend.
 * True for every caller the door does not judge (switch off, not worker-bound).
 */
export async function workerTriggerWouldBeAdmitted(
  ctx: Pick<Context, 'db' | 'sessionId' | 'sessionBindingRefused'>,
  args: { appId: string; action: TriggerGrantAction; entryNodeId: string | null },
): Promise<boolean> {
  if (!workerTriggerGrantEnforced()) return true;
  const actor = await workerBoundActor(ctx);
  if (!actor) return true;
  return (await findAdmittingGrant(ctx.db, { ...args, actor, lock: false })) !== null;
}
