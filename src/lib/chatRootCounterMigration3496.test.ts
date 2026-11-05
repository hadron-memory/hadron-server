/** #3496 — execute the actual additive migration, not db-push's schema-only surrogate. */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeEach, describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { computeRevisionStateHash, ensureCurrentNodeRevisionInTransaction } from './nodeRevisionSnapshot.js';
import { appendChatMessage } from './chatRoot.js';
const migration = readFileSync(new URL('../../prisma/migrations/20261105150000_chat_root_counters/migration.sql', import.meta.url), 'utf8');
let memoryId: string;
beforeEach(async () => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { id: generateId(), name: 'migration', urn: `mig-${generateId()}` } });
    memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `mig-${generateId()}`, name: 'migration', class: 'knowledge' } })).id;
});
async function root(data: unknown, loc = 'chats:agent', nodeType = 'record') {
    return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType, data: data === null ? Prisma.JsonNull : data as Prisma.InputJsonValue } });
}
async function run() { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); try {
    await c.query(migration);
}
finally {
    await c.end();
} }
async function reconcile(id: string) { await db.$transaction(tx => ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: memoryId })); }
describe('#3496 migration', () => {
    it.each(['record', 'chat'])('backfills synchronized %s roots without revision or stamp loss; idempotent', async (nodeType) => {
        const n = await root({ messageCount: 57, lastMessageAt: '2026-01-01T00:00:00Z', title: 'keep' }, 'chats:agent', nodeType);
        await db.node.update({ where: { id: n.id }, data: { authorshipKind: 'TASK', authoredByTask: 'tasks:author', authoredByRevision: 1, authoredAt: new Date(), revisionContentHash: 'refresh' } });
        await run();
        const counter = await db.chatRootCounter.findUniqueOrThrow({ where: { chatRootNodeId: n.id } });
        expect(counter.messageCount).toBe(57);
        expect(counter.lastMessageAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        await reconcile(n.id);
        const after = await db.node.findUniqueOrThrow({ where: { id: n.id } });
        expect(after.data).toEqual({ title: 'keep' });
        expect(after.revSeq).toBe(n.revSeq);
        expect(after.authoredByTask).toBe('tasks:author');
        expect(after.revisionContentHash).toBe(await computeRevisionStateHash(db, n.id));
        await run();
        expect(await db.chatRootCounter.findUnique({ where: { chatRootNodeId: n.id } })).toEqual(counter);
    });
    it('excludes containers/messages/non-chat records, includes soft-deleted roots', async () => {
        const roots = await Promise.all([root({ messageCount: 8 }, 'chats'), root({ messageCount: 8 }, 'chats:a:messages'), root({ messageCount: 8 }, 'chats:a:messages:008'), root({ messageCount: 8 }, 'other')]);
        const dead = await root({ messageCount: 33 }, 'chats:dead');
        await db.node.update({ where: { id: dead.id }, data: { deletedAt: new Date() } });
        await run();
        expect((await db.chatRootCounter.findMany()).map(c => c.chatRootNodeId)).toEqual([dead.id]);
        for (const n of roots)
            expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).data).toEqual({ messageCount: 8 });
    });
    it('preserves honest pending drift, exactly one reconcile and cleared stamp', async () => {
        const n = await root({ messageCount: 57 });
        await db.node.update({ where: { id: n.id }, data: { authorshipKind: 'TASK', authoredByTask: 'tasks:author', authoredByRevision: 1, authoredAt: new Date(), revisionContentHash: 'refresh' } });
        await db.node.update({ where: { id: n.id }, data: { name: 'unrevisioned edit' } });
        await run();
        await reconcile(n.id);
        await reconcile(n.id);
        const after = await db.node.findUniqueOrThrow({ where: { id: n.id } });
        expect(after.revSeq).toBe(n.revSeq + 1);
        expect(after.authoredByTask).toBeNull();
    });
    it.each([1.5, 3e10, -1, '12', null])('invalid count %j never aborts and uses zero, while allocator clears MAX(seq)', async (messageCount) => {
        const n = await root({ messageCount });
        await db.node.create({ data: { id: generateId(), memoryId, loc: `${n.loc}:messages:020`, name: 'message', nodeType: 'record', seq: 20, deletedAt: new Date() } });
        await run();
        expect((await db.chatRootCounter.findUniqueOrThrow({ where: { chatRootNodeId: n.id } })).messageCount).toBe(0);
        expect((await appendChatMessage(db, n, { id: memoryId, isEncrypted: false }, async () => { })).seq).toBe(21);
    });
    it.each(['nonsense', 'infinity', '-infinity', 123])('invalid time %j is null, migration completes', async (lastMessageAt) => {
        const n = await root({ messageCount: 2, lastMessageAt });
        await run();
        expect((await db.chatRootCounter.findUniqueOrThrow({ where: { chatRootNodeId: n.id } })).lastMessageAt).toBeNull();
    });
    it.each([[null], ['scalar'], ['messageCount'], [[1, 2]], [['messageCount', 'other']], [42]])('non-object data %j is unchanged and seeds 0/null', async (data) => {
        const n = await root(data);
        await run();
        expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).data).toEqual(data);
        expect(await db.chatRootCounter.findUnique({ where: { chatRootNodeId: n.id } })).toMatchObject({ messageCount: 0, lastMessageAt: null });
    });
    it('does not seed encrypted ciphertext and does not overwrite an existing row', async () => {
        const n = await root({ messageCount: 9 });
        await db.chatRootCounter.create({ data: { chatRootNodeId: n.id, messageCount: 99 } });
        await run();
        expect((await db.chatRootCounter.findUniqueOrThrow({ where: { chatRootNodeId: n.id } })).messageCount).toBe(99);
        await db.chatRootCounter.deleteMany();
        await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
        await run();
        expect(await db.chatRootCounter.count()).toBe(0);
    });
});

it('backfills a finite PostgreSQL timestamp beyond JS Date range and a next send still works',async()=>{
 const {readChatCounters}=await import('./chatRootCounters.js');
 const n=await root({messageCount:9,lastMessageAt:'280000-01-01T00:00:00Z'});await run();
 expect((await readChatCounters(db,[await db.node.findUniqueOrThrow({where:{id:n.id}})])).get(n.id)?.lastMessageAt).toBe('280000-01-01T00:00:00.000Z');
 expect((await appendChatMessage(db,n,{id:memoryId,isEncrypted:false},async()=>{})).seq).toBe(10);
});

it('creates the real table with cascading root identity and deletion, rolled back privately',async()=>{
 const n=await root({messageCount:3});
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');
  await c.query('DROP TABLE chat_root_counters');
  await c.query(migration);
  const fk=await c.query("SELECT confdeltype,confupdtype FROM pg_constraint WHERE conrelid='chat_root_counters'::regclass AND contype='f'");
  expect(fk.rows).toEqual([{confdeltype:'c',confupdtype:'c'}]);
  expect((await c.query('SELECT message_count FROM chat_root_counters WHERE chat_root_node_id=$1',[n.id])).rows).toEqual([{message_count:3}]);
  await c.query('DELETE FROM nodes WHERE id=$1',[n.id]);
  expect((await c.query('SELECT count(*)::int AS n FROM chat_root_counters')).rows).toEqual([{n:0}]);
 } finally {await c.query('ROLLBACK');await c.end();}
});
