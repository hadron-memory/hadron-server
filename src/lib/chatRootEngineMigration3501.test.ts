/** Execute the real SQL against a private harness DB, including a repeat and real table recreation. */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeEach, it, expect } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { validEngineValue } from './chatRootEngineState.js';
import { updateChatRootData } from './chatRoot.js';
import { ensureCurrentNodeRevisionInTransaction } from './nodeRevisionSnapshot.js';
const migration = readFileSync(new URL('../../prisma/migrations/20261106010000_chat_root_engine_state/migration.sql', import.meta.url), 'utf8');
let memoryId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'migration3501', urn: `mig3501-${generateId()}` } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `mig3501-${generateId()}`, name: 'migration', class: 'knowledge' } })).id;
});
const state = { conversationName: 'intake', stageName: 'first', routeHistory: [], goalStack: [], lastOffTrackReason: 'reason', lastOffTrackAt: '2026-11-06T00:00:00.000Z' };
const root = (loc = 'chats:one', data: object = state, nodeType = 'record') => db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType, data } });
async function run() { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); try { await c.query(migration); } finally { await c.end(); } }
it.each([false, true])('9: strips only four keys, keeps mirrors; conditional marker preserves honest drift (%s)', async drift => {
  const n = await root(); await db.node.update({ where: { id: n.id }, data: { revisionContentHash: 'refresh', authorshipKind: 'TASK', authoredByTask: 'author', authoredByRevision: 1, authoredAt: new Date() } });
  if (drift) await db.node.update({ where: { id: n.id }, data: { name: 'unrevisioned' } });
  await run();
  const row = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: n.id } }); expect(row.state).toEqual(state);
  const after = await db.node.findUniqueOrThrow({ where: { id: n.id } }); expect(after.data).toEqual({ conversationName: 'intake', stageName: 'first' });
  await db.$transaction(tx => ensureCurrentNodeRevisionInTransaction(tx, n.id, { expectedMemoryId: memoryId }));
  expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ revSeq: n.revSeq + (drift ? 1 : 0), authoredByTask: drift ? null : 'author' });
  await run(); expect(await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: n.id } })).toEqual(row);
});
it('9: flag-encrypted but still plaintext roots and envelope-shaped data are excluded', async () => {
  const n = await root(); await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
  await run(); expect(await db.chatRootEngineState.count()).toBe(0); expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).data).toEqual(state);
  await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
  await db.node.update({ where: { id: n.id }, data: { data: { __enc: 'opaque', stageName: 'not-plaintext' } } });
  await run(); expect(await db.chatRootEngineState.count()).toBe(0);
});
it('9: tombstones are included, malformed values retained, existing row wins and unrelated roots stay untouched', async () => {
  const n = await root('chats:dead', { ...state, goalStack: 42, lastOffTrackAt: 'invalid' });
  await db.node.update({ where: { id: n.id }, data: { deletedAt: new Date() } });
  await root('chats:dead:messages'); await root('other'); await root('chats:team', state, 'chat');
  await run(); expect(await db.chatRootEngineState.count()).toBe(1);
  expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).data).toEqual({ conversationName: 'intake', stageName: 'first', goalStack: 42, lastOffTrackAt: 'invalid' });
  await db.chatRootEngineState.update({ where: { chatRootNodeId: n.id }, data: { state: { stageName: 'live' } } });
  await run(); expect((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: n.id } })).state).toEqual({ stageName: 'live' });
});
it('real table PK/FK cascades hard root deletion and has no memoryId/plaintext routing column', async () => {
 const n = await root(); const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
 try { await c.query('BEGIN'); await c.query('DROP TABLE chat_root_engine_states'); await c.query(migration);
  const fk = await c.query("SELECT confdeltype,confupdtype FROM pg_constraint WHERE conrelid='chat_root_engine_states'::regclass AND contype='f'"); expect(fk.rows).toEqual([{ confdeltype: 'c', confupdtype: 'c' }]);
  const columns = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='chat_root_engine_states' ORDER BY ordinal_position"); expect(columns.rows.map(r => r.column_name)).toEqual(['chat_root_node_id','state','updated_at']);
  await c.query('DELETE FROM nodes WHERE id=$1',[n.id]); expect((await c.query('SELECT count(*)::int n FROM chat_root_engine_states')).rows).toEqual([{ n: 0 }]);
 } finally { await c.query('ROLLBACK'); await c.end(); }
});

const parityFixtures: Array<[string, unknown, boolean]> = [
  ['routeHistory', [{ action: 'ENTER', timestamp: '2026-01-01T00:00:00Z', language: 5 }], true],
  ['goalStack', [{ description: 'goal', createdBy: 'USER', status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z', language: 5 }], false],
  ['lastOffTrackAt', '2026-02-30T00:00:00Z', false],
  ['lastOffTrackAt', '2024-02-29T00:00:00Z', true],
  ['lastOffTrackAt', '2026-02-29T00:00:00Z', false],
  ['lastOffTrackAt', '2026-01-01T00:00:00', true],
  ['lastOffTrackAt', '2026-01-01T00:00Z', true],
  ['lastOffTrackAt', '2026-01-01T24:00:00Z', true],
  ['lastOffTrackAt', '2026-01-01T24:00:01Z', false],
  ['lastOffTrackAt', '2026-01-01T00:00:00+23:59', true],
  ['lastOffTrackAt', '2026-01-01T00:00:00+24:00', false],
  ['lastOffTrackAt', '2026-01-01T00:00:60Z', false],
  ['lastOffTrackAt', null, false],
  ['stageName', '\t', false],
  ['stageName', '\u00a0', false],
  ['stageName', '\ufeff', false],
  ['stageName', ' first ', true],
  ['routeHistory', [{ action: 'ENTER', timestamp: '2026-01-01T00:00:00Z', trigger: { type: 'X', content: null } }], false],
];
it.each(parityFixtures)('SQL/runtime JSON-domain parity %s %j', async (key, value, expected) => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(migration.slice(0, migration.indexOf('DO $$')));
    for (const zone of ['UTC', 'Pacific/Auckland']) {
      await c.query("SELECT set_config('TimeZone',$1,true)", [zone]);
      const sql = await c.query('SELECT hadron_3501_valid($1,$2::jsonb) valid', [key, JSON.stringify(value)]);
      expect({ zone, sql: sql.rows[0].valid, runtime: validEngineValue(key, value) }).toEqual({ zone, sql: expected, runtime: expected });
    }
  } finally { await c.query('ROLLBACK'); await c.end(); }
});
it.each([
  ['routeHistory', [{ action: 'ENTER', timestamp: '2026-01-01T00:00:00Z', language: 5 }]],
  ['lastOffTrackAt', '2026-02-30T00:00:00Z'],
] as Array<[string, unknown]>)('migration then real locked write never loses legacy %s', async (key, value) => {
  const n = await root('chats:parity', { ...state, [key]: value });
  await run();
  await updateChatRootData(db, { id: n.id, memoryId, loc: n.loc }, { id: memoryId, isEncrypted: false }, d => d);
  const data = (await db.node.findUniqueOrThrow({ where: { id: n.id } })).data as Record<string, unknown>;
  const engine = (await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: n.id } })).state as Record<string, unknown>;
  expect(Object.hasOwn(engine, key) ? engine[key] : data[key]).toEqual(value);
});
it('a legacy value absent from an existing authoritative row stays inert and is not silently deleted', async () => {
  const history = [{ action: 'ENTER', timestamp: '2026-01-01T00:00:00Z' }];
  const n = await root('chats:unrepresented', { ...state, routeHistory: history });
  await db.chatRootEngineState.create({ data: { chatRootNodeId: n.id, state: { conversationName: 'intake', stageName: 'first' } } });
  let seen: unknown = 'not called';
  await updateChatRootData(db, { id: n.id, memoryId, loc: n.loc }, { id: memoryId, isEncrypted: false }, d => { seen = d.routeHistory; return d; });
  expect(seen).toBeUndefined(); // no fallback into the live engine
  expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).data).toHaveProperty('routeHistory', history);
  expect((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: n.id } })).state).not.toHaveProperty('routeHistory');
});
it('migration updated_at is UTC even in a non-UTC database session', async () => {
  const n = await root(); const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { await c.query('BEGIN'); await c.query("SET LOCAL TIME ZONE 'Pacific/Auckland'"); await c.query(migration);
    const out = await c.query("SELECT abs(extract(epoch from (updated_at-(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))::float seconds FROM chat_root_engine_states WHERE chat_root_node_id=$1", [n.id]);
    expect(out.rows[0].seconds).toBeLessThan(60);
  } finally { await c.query('ROLLBACK'); await c.end(); }
});
