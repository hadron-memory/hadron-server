/**
 * #4162 PLACEHOLDER (red-first commit): a NAIVE shared check with the two universals the gate rejected, so the pins in
 * cover4162.test.ts can show which ruled per-action behaviour a naive consolidation erases. Replaced in the next commit.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import type { ActionParameter, GrantReach } from './actions.js';
import { PLATFORM_ACTIONS } from './actions.js';
import { GRANT_DB_NOW, chargeGrantUse, grantLiveSql } from './live.js';
import { workersReachedByGrant } from './reach.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface CoverableAction {
  name: string; parameters: readonly ActionParameter[]; reach?: GrantReach; listParameters?: readonly string[]; maxUses?: number;
}
export function coverableAction(name: string): CoverableAction {
  const a = PLATFORM_ACTIONS.find((x) => x.name === name);
  if (!a) throw new Error(`unknown action ${name}`);
  return a;
}
export function valueCovers(_action: CoverableAction, _param: string, stored: unknown, id: string): boolean {
  return stored === id || (Array.isArray(stored) && stored.includes(id));   // naive: a list covers for EVERY parameter
}
export interface CoverArgs {
  appId: string; action: CoverableAction; workerId: string; roleAgentId?: string | null; values: Record<string, string>;
  lock?: 'SHARE' | 'UPDATE'; order: 'CAPPED_FIRST' | 'ACTIVATED'; onlyId?: string;
}
export interface CoveringGrant { id: string; maxUses: number | null; issuerUserId: string | null }

export async function findCoveringGrants(db: Db, a: CoverArgs): Promise<CoveringGrant[]> {
  const [param, id] = Object.entries(a.values)[0]!;
  const rows = await db.$queryRaw<Array<{ id: string; max_uses: number | null; issuer_user_id: string | null; v: unknown }>>(Prisma.sql`
    SELECT g.id, g.max_uses, g.issuer_user_id, g.action_values -> ${param} AS v FROM grants g
    WHERE g.app_id = ${a.appId} AND g.action = ${a.action.name} AND ${grantLiveSql('g')} AND g.activated_at <= ${GRANT_DB_NOW}
      AND (g.worker_id = ${a.workerId} OR g.agent_id = ${a.roleAgentId ?? null})
    ORDER BY g.created_at, g.id`);
  const out: CoveringGrant[] = [];
  for (const r of rows) {
    if (!valueCovers(a.action, param, r.v, id)) continue;
    if (!(await workersReachedByGrant(db, r.id)).includes(a.workerId)) continue;   // naive: reach is always workersReachedByGrant
    out.push({ id: r.id, maxUses: r.max_uses, issuerUserId: r.issuer_user_id });
  }
  return out;
}

export async function spendGrant(
  tx: Prisma.TransactionClient, grantId: string, record: { appId: string; workerId: string; sessionId: string | null }, refusal: () => Error,
): Promise<void> {
  if (!(await chargeGrantUse(tx, grantId, record.appId))) throw refusal();
  await tx.grantEvent.create({ data: { id: generateId(), grantId, appId: record.appId, action: 'USE', workerId: record.workerId, sessionId: record.sessionId } });
}

/** PLACEHOLDER: the real fragment arrives with the implementation. */
export function coverSql(_action: CoverableAction, _alias: string, _values: Record<string, string>): Prisma.Sql {
  return Prisma.sql`TRUE`;
}
