/** Execute the real SQL against a private harness DB, including a repeat and real table recreation. */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeEach, it, expect } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
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
