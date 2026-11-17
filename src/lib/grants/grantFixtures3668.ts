/**
 * #3668 S1a test fixtures: synthetic action and grant rows, inserted with RAW SQL so a pin never depends on a generated
 * model and can reach the database guards directly. Synthetic rows exist only inside these isolated tests; no shipped
 * code path writes a grant or an action (S1a has no writer).
 */
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../id.js';

/** A raw SQL fragment as a column value (a time computed on the database clock, for instance). */
export class RawSql { constructor(readonly sql: string) {} }
export const raw = (sql: string): RawSql => new RawSql(sql);
export const DB_NOW = "(clock_timestamp() AT TIME ZONE 'UTC')";
export const dbNowPlus = (interval: string): RawSql => raw(`${DB_NOW} + interval '${interval}'`);

export const TEST_ACTION = 'test.s1a.act';

export interface World {
  orgId: string; appId: string; app2Id: string; userId: string; user2Id: string; agentId: string; workerId: string; sessionId: string;
}

export async function seedWorld(): Promise<World> {
  const tag = generateId().slice(0, 8);
  const org = await db.organization.create({ data: { name: `g-${tag}`, urn: `g-${tag}.test` } });
  const [app, app2] = await Promise.all([
    db.app.create({ data: { organizationId: org.id, name: 'g-app', urn: `${org.urn}:app` } }),
    db.app.create({ data: { organizationId: org.id, name: 'g-app2', urn: `${org.urn}:app2` } }),
  ]);
  const [u1, u2] = await Promise.all([db.user.create({ data: { handle: `g1-${tag}` } }), db.user.create({ data: { handle: `g2-${tag}` } })]);
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'g-agent', urn: `${org.urn}:agent` } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'g-worker', slug: `g-worker-${tag}` } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, workerId: worker.id, agentId: agent.id } as never });
  await ensureTestAction();
  return { orgId: org.id, appId: app.id, app2Id: app2.id, userId: u1.id, user2Id: u2.id, agentId: agent.id, workerId: worker.id, sessionId: session.id };
}

/** A synthetic registered action (the registered-action FK needs a target). Removed by {@link dropTestActions}. */
export async function ensureTestAction(name = TEST_ACTION): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO actions (name, source, parameters, enforcement, issuer_rule, summary_template, created_at, updated_at)
     VALUES ($1, 'PLATFORM', '[]'::jsonb, 'RECORDED_ONLY', 'TEST_ONLY', 'test', ${DB_NOW}, ${DB_NOW}) ON CONFLICT (name) DO NOTHING`, name);
}
export async function dropTestActions(): Promise<void> {
  await db.$executeRawUnsafe(`DELETE FROM actions WHERE name LIKE 'test.s1a.%'`);
}

type Val = string | number | boolean | Date | null | RawSql | Record<string, unknown> | unknown[];

function build(table: string, values: Record<string, Val>): { text: string; params: unknown[] } {
  const cols: string[] = []; const exprs: string[] = []; const params: unknown[] = [];
  for (const [col, v] of Object.entries(values)) {
    cols.push(col);
    if (v instanceof RawSql) exprs.push(v.sql);
    else if (v !== null && typeof v === 'object' && !(v instanceof Date)) { params.push(JSON.stringify(v)); exprs.push(`$${params.length}::jsonb`); }
    else { params.push(v); exprs.push(`$${params.length}`); }
  }
  return { text: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${exprs.join(', ')})`, params };
}

/** The columns every grant row needs, with a user holder by default. Override any of them. */
export function grantValues(w: World, over: Record<string, Val> = {}): Record<string, Val> {
  return {
    id: generateId(), app_id: w.appId, user_id: w.userId, action: TEST_ACTION, action_values: {}, reason: 'because',
    created_at: raw(DB_NOW), updated_at: raw(DB_NOW), ...over,
  };
}

/** Insert one grant row exactly as given: the database guards run. */
export async function insertGrant(w: World, over: Record<string, Val> = {}): Promise<string> {
  const values = grantValues(w, over);
  const { text, params } = build('grants', values);
  await db.$executeRawUnsafe(text, ...params);
  return values.id as string;
}

/**
 * Insert a row the insert guard would refuse (an ACTIVE or revoked row, which no shipped path can make yet), by
 * disabling that one trigger for this transaction only. The test-only way to build the states a later slice will reach.
 */
export async function insertGrantUnguarded(w: World, over: Record<string, Val> = {}): Promise<string> {
  const values = grantValues(w, over);
  const { text, params } = build('grants', values);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRawUnsafe(text, ...params);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
  return values.id as string;
}

export async function insertEvent(w: World, grantId: string, over: Record<string, Val> = {}): Promise<string> {
  const values: Record<string, Val> = { id: generateId(), grant_id: grantId, app_id: w.appId, action: 'CREATE', ...over };
  const { text, params } = build('grant_events', values);
  await db.$executeRawUnsafe(text, ...params);
  return values.id as string;
}

/**
 * #4067 (V86): a PUBLIC knowledge memory in the org with `n` live nodes, readable by every test user, for grants whose node-typed
 * value must name a node the requester can read. Returns the node ids.
 */
export async function seedReadableNodes(orgId: string, n = 1): Promise<string[]> {
  const tag = generateId().slice(0, 8);
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `pub-${tag}.test:kb`, name: `pub-${tag}`, class: 'knowledge', visibility: 'PUBLIC' } });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `n${i}`, name: `n${i}`, nodeType: 'info', content: 'x' } as never })).id);
  }
  return ids;
}
