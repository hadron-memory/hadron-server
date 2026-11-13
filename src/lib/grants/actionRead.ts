/**
 * #3708 (Grants S1c; hrn:node:hadronmemory.com:specs:cor:acl:140:02): the data-layer read of the action registry (the `actions`
 * table that src/lib/grants/actions.ts seeds). Who may read is decided by the CALLER (the resolver's gate in
 * resolvers.grantActions.ts); this module owns the projection, and it is the same for every caller: the row's name, source, tool,
 * parameters, enforcement level and issuer rule. The summary template is deliberately NOT projected (ask item 11 is its own slice).
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { ActionEnforcement, ActionParameter } from './actions.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface ActionView {
  name: string;
  source: string;
  tool: string | null;
  parameters: ActionParameter[];
  enforcement: ActionEnforcement;
  issuerRule: string;
}

const SELECT = { name: true, source: true, tool: true, parameters: true, enforcement: true, issuerRule: true } as const;

function toView(row: { name: string; source: string; tool: string | null; parameters: unknown; enforcement: string; issuerRule: string }): ActionView {
  return {
    name: row.name, source: row.source, tool: row.tool, enforcement: row.enforcement as ActionEnforcement, issuerRule: row.issuerRule,
    parameters: Array.isArray(row.parameters) ? (row.parameters as ActionParameter[]) : [],
  };
}

/** The registry page, by name, with the real total (limit 0 reads the count only). */
export async function listActions(db: Db, page: { take: number; skip: number }): Promise<{ items: ActionView[]; total: number }> {
  const [rows, total] = await Promise.all([
    page.take > 0 ? db.action.findMany({ select: SELECT, orderBy: { name: 'asc' }, take: page.take, skip: page.skip }) : Promise.resolve([]),
    db.action.count(),
  ]);
  return { items: rows.map(toView), total };
}

/** One action by its exact name, or null. */
export async function getAction(db: Db, name: string): Promise<ActionView | null> {
  const row = await db.action.findUnique({ where: { name }, select: SELECT });
  return row ? toView(row) : null;
}
