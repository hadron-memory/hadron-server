/** #3557: run the real strip migration SQL against a private harness DB, including reruns. */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeEach, it, expect } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureCurrentNodeRevisionInTransaction } from './nodeRevisionSnapshot.js';
const migration = readFileSync(new URL('../../prisma/migrations/20261110230000_chat_root_strip_mirrored_names/migration.sql', import.meta.url), 'utf8');
let memoryId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'strip3557m', urn: `strip3557m-${generateId()}` } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `strip3557m-${generateId()}`, name: 'm', class: 'knowledge' } })).id;
});
const names = { conversationName: 'intake', stageName: 'first' };
const mk = async (loc: string, data: object, row: object | null, extra: object = {}, nodeType = 'record') => {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType, data, ...extra } });
  if (row) await db.chatRootEngineState.create({ data: { chatRootNodeId: n.id, state: row } });
  return n;
};
const dataOf = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).data;
async function run() { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); try { await c.query(migration); } finally { await c.end(); } }
it('strips both names where the row holds them, keeps every other key, and a rerun is a no-op', async () => {
  const n = await mk('chats:one', { scope: 'private', ...names, goalStack: 42 }, names);
  await run(); expect(await dataOf(n.id)).toEqual({ scope: 'private', goalStack: 42 });
  const snap = await db.node.findUniqueOrThrow({ where: { id: n.id } });
  await run(); expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toEqual(snap);
  expect((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: n.id } })).state).toEqual(names);
});
it('keep matrix: no row, key absent from the row, malformed copy, malformed row value, encrypted memory, envelope data', async () => {
  const noRow = await mk('chats:norow', { ...names }, null);
  const partial = await mk('chats:partial', { ...names }, { conversationName: 'intake' });
  const badCopy = await mk('chats:badcopy', { conversationName: 7, stageName: 'first' }, names);
  const badRow = await mk('chats:badrow', { ...names }, { conversationName: 5, stageName: 'first' });
  const envelope = await mk('chats:env', { __enc: 'opaque', stageName: 'x' }, names);
  await run();
  expect(await dataOf(noRow.id)).toEqual(names);
  expect(await dataOf(partial.id)).toEqual({ stageName: 'first' });
  expect(await dataOf(badCopy.id)).toEqual({ conversationName: 7 });
  expect(await dataOf(badRow.id)).toEqual({ conversationName: 'intake' });
  expect(await dataOf(envelope.id)).toEqual({ __enc: 'opaque', stageName: 'x' });
  await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
  const enc = await mk('chats:enc', { ...names }, names);
  await run(); expect(await dataOf(enc.id)).toEqual(names);
});
it('tombstones are included; non-root rows (children, other types, other locs) are untouched', async () => {
  const dead = await mk('chats:dead', { ...names }, names, { deletedAt: new Date() });
  const child = await mk('chats:dead:messages', { ...names }, names);
  const other = await mk('other', { ...names }, names);
  const team = await mk('chats:team', { ...names }, names, {}, 'chat');
  await run();
  expect(await dataOf(dead.id)).toEqual({});
  for (const n of [child, other, team]) expect(await dataOf(n.id)).toEqual(names);
});
it.each([false, true])('refresh marker only where previously synced (drift=%s)', async drift => {
  const n = await mk('chats:marker', { ...names }, names);
  await db.node.update({ where: { id: n.id }, data: { revisionContentHash: 'refresh', authorshipKind: 'TASK', authoredByTask: 'author', authoredByRevision: 1, authoredAt: new Date() } });
  if (drift) await db.node.update({ where: { id: n.id }, data: { name: 'unrevisioned' } });
  await run();
  await db.$transaction(tx => ensureCurrentNodeRevisionInTransaction(tx, n.id, { expectedMemoryId: memoryId }));
  expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ revSeq: n.revSeq + (drift ? 1 : 0), authoredByTask: drift ? null : 'author' });
});
