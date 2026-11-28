/**
 * #5485 (Asks 1 and 2; Holger 2026-11-28) — the task role family and stage 1 of the retype, run as the real SQL.
 *
 * Each test first puts the database back into the shape it had before this migration (no task-role CHECK), builds
 * its rows through that shape, then runs prisma/migrations/20261128020000_task_role_family/migration.sql in one
 * batch, as `prisma migrate deploy` sends it.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureCurrentNodeRevisionInTransaction } from './nodeRevisionSnapshot.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MIGRATION = read('../../prisma/migrations/20261128020000_task_role_family/migration.sql');
const SOURCE = read('../../prisma/task-role-family.sql');
const POST_PUSH = read('../../prisma/post-push.sql');

async function sql(text: string) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await c.query(text); } finally { await c.end(); }
}
const beforeTheMigration = () => sql('ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_nodes_task_role_runnable"');
const migrate = () => sql(MIGRATION);

let orgId: string;
let agentMem: string;
let installMem: string;
let knowledgeMem: string;
let looseSystemMem: string;

beforeEach(async () => {
  await cleanDb(db);
  await beforeTheMigration();
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'm5485', urn: 'm5485-org' } })).id;
  const memory = async (name: string, data: Record<string, unknown>) =>
    (await db.memory.create({ data: { id: generateId(), name, urn: `m5485-org:${name}`, organizationId: orgId, ...data } as never })).id;
  agentMem = await memory('sys', { class: 'system' });
  const agentId = (await db.agent.create({ data: { id: generateId(), name: 'Ada', urn: 'm5485-org:ada', organizationId: orgId, systemMemoryId: agentMem } })).id;
  const appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: 'm5485-org:app', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
  installMem = await memory('install', { class: 'system', appId, installOfAgentId: agentId, isInstallMemory: true });
  knowledgeMem = await memory('kb', { class: 'knowledge' });
  looseSystemMem = await memory('loose', { class: 'system' });
});
afterAll(async () => { await cleanDb(db); await sql(SOURCE); });

const put = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `text of ${loc}`, ...extra } });
const kind = async (id: string) => {
  const n = await db.node.findUniqueOrThrow({ where: { id }, select: { nodeType: true, role: true } });
  return [n.nodeType, n.role];
};

describe('#5485 the migration is its one source, and never refuses', () => {
  it('carries the source verbatim and post-push includes it after the boot-prompt invariants', () => {
    expect(MIGRATION).toContain(SOURCE);
    const a = POST_PUSH.indexOf('\\ir boot-prompt-invariants.sql');
    const b = POST_PUSH.indexOf('\\ir task-role-family.sql');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  it('has no statement that raises, and takes ACCESS EXCLUSIVE on nodes before its first write', () => {
    const code = MIGRATION.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(code).not.toMatch(/HDPRF/);
    const lock = MIGRATION.indexOf('LOCK TABLE "nodes" IN ACCESS EXCLUSIVE MODE');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(MIGRATION.indexOf('UPDATE "nodes"'));
  });
});

describe('#5485 Ask 1: the role step runs in every memory, role only', () => {
  it.each([['an Agent system memory', () => agentMem], ['an install memory', () => installMem], ['an ordinary memory', () => knowledgeMem], ['a system memory that is no placement', () => looseSystemMem]])(
    'in %s a runnable node with no role gets task, role-task gets task.role, another role is kept',
    async (_name, mem) => {
      const m = mem();
      const none = await put(m, 'work:none', { isRunnable: true });
      const legacy = await put(m, 'work:legacy', { isRunnable: true, role: 'role-task' });
      const other = await put(m, 'work:other', { isRunnable: true, role: 'review' });
      const process = await put(m, 'work:process', { role: 'process' });
      const plain = await put(m, 'work:plain');
      const typedTask = await put(m, 'work:typed', { isRunnable: true, nodeType: 'task' });
      await migrate();
      expect((await kind(none.id))[1]).toBe('task');
      expect((await kind(legacy.id))[1]).toBe('task.role');
      expect((await kind(other.id))[1]).toBe('review');
      expect(await kind(process.id)).toEqual([expect.any(String), 'process']);
      expect((await kind(plain.id))[1]).toBeNull();
      expect((await kind(typedTask.id))[1]).toBe('task');
    },
  );

  it('only the role moves outside a system placement: no node changes type', async () => {
    const a = await put(knowledgeMem, 'tasks:a', { isRunnable: true, nodeType: 'task' });
    const b = await put(knowledgeMem, 'tasks:b', { isRunnable: true });
    const c = await put(looseSystemMem, 'tasks:c', { isRunnable: true, nodeType: 'info' });
    const p = await put(knowledgeMem, 'processes:p', { role: 'process.release' });
    const parent = await put(knowledgeMem, 'tasks', {});
    await migrate();
    expect(await kind(a.id)).toEqual(['task', 'task']);
    expect(await kind(b.id)).toEqual(['info', 'task']);
    expect(await kind(c.id)).toEqual(['info', 'task']);
    expect(await kind(p.id)).toEqual(['info', 'process.release']);
    expect(await kind(parent.id)).toEqual(['info', null]);
  });

  it('a runnable node with another role is kept and counted, never refused', async () => {
    await put(agentMem, 'work:other', { isRunnable: true, role: 'review' });
    await put(knowledgeMem, 'work:other2', { isRunnable: true, role: 'spec' });
    const notices: string[] = [];
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    c.on('notice', (n) => notices.push(n.message));
    await c.connect();
    try { await c.query(MIGRATION); } finally { await c.end(); }
    expect(notices.join('\n')).toMatch(/runnable node.* another role.*2/i);
  });

  it('a task-family role on a row that is not runnable is cleared, so the CHECK can hold; role-task there is left', async () => {
    const bad = await put(knowledgeMem, 'x:bad', { role: 'task' });
    const bad2 = await put(knowledgeMem, 'x:bad2', { role: 'task.role' });
    const legacy = await put(knowledgeMem, 'x:legacy', { role: 'role-task' });
    await migrate();
    expect((await kind(bad.id))[1]).toBeNull();
    expect((await kind(bad2.id))[1]).toBeNull();
    expect((await kind(legacy.id))[1]).toBe('role-task');
  });
});

describe('#5485 Ask 2: stage 1 of the retype, in Agent system memories and install memories only', () => {
  it('retypes every runnable node, every process-family node and the two parents; only task and info rows', async () => {
    const rows: Array<[string, string, [string, string | null]]> = [];
    const add = async (what: string, mem: string, loc: string, extra: Record<string, unknown>, want: [string, string | null]) => {
      rows.push([what, (await put(mem, loc, extra)).id, want]);
    };
    for (const [label, mem] of [['agent', agentMem], ['install', installMem]] as const) {
      await add(`${label}: runnable info`, mem, 'tasks:a', { isRunnable: true }, ['system', 'task']);
      await add(`${label}: runnable typed task, role-task`, mem, 'tasks:b', { isRunnable: true, nodeType: 'task', role: 'role-task' }, ['system', 'task.role']);
      await add(`${label}: runnable with another role`, mem, 'tasks:c', { isRunnable: true, role: 'review' }, ['system', 'review']);
      await add(`${label}: process`, mem, 'processes:p', { role: 'process' }, ['system', 'process']);
      await add(`${label}: process sub-role`, mem, 'processes:q', { role: 'process.release', nodeType: 'task' }, ['system', 'process.release']);
      await add(`${label}: tasks parent`, mem, 'tasks', {}, ['system', null]);
      await add(`${label}: processes parent`, mem, 'processes', {}, ['system', null]);
      await add(`${label}: a plain node`, mem, 'notes:plain', {}, ['info', null]);
      await add(`${label}: a plain node under tasks`, mem, 'tasks:notes', {}, ['info', null]);
      // Never retyped: a custom type, a record, a chat-message.
      await add(`${label}: record under tasks`, mem, 'tasks:run-1', { nodeType: 'record', isRunnable: true }, ['record', 'task']);
      await add(`${label}: chat-message under processes`, mem, 'processes:m:1', { nodeType: 'chat-message', seq: 1, role: 'process' }, ['chat-message', 'process']);
      await add(`${label}: custom type`, mem, 'tasks:custom', { nodeType: 'transcript', isRunnable: true }, ['transcript', 'task']);
      await add(`${label}: soft-deleted runnable`, mem, 'tasks:gone', { isRunnable: true, deletedAt: new Date() }, ['system', 'task']);
    }
    await add('ordinary memory: runnable', knowledgeMem, 'tasks:a', { isRunnable: true }, ['info', 'task']);
    await add('ordinary memory: process', knowledgeMem, 'processes:p', { role: 'process' }, ['info', 'process']);
    await add('ordinary memory: parents', knowledgeMem, 'processes', {}, ['info', null]);
    await add('loose system memory: runnable', looseSystemMem, 'tasks:a', { isRunnable: true }, ['info', 'task']);
    const before = new Map((await db.node.findMany({ select: { id: true, content: true, loc: true, memoryId: true, deletedAt: true, revSeq: true } })).map((n) => [n.id, n]));
    await migrate();
    for (const [what, id, want] of rows) expect(await kind(id), what).toEqual(want);
    for (const n of await db.node.findMany({ select: { id: true, content: true, loc: true, memoryId: true, deletedAt: true, revSeq: true } })) expect(n, n.loc).toEqual(before.get(n.id));
    const snapshot = await db.node.findMany({ orderBy: { id: 'asc' } });
    await migrate();
    expect(await db.node.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
  });

  it('a comment under tasks is never retyped', async () => {
    const target = await put(agentMem, 'tasks:a', { isRunnable: true });
    const id = generateId();
    await db.$transaction(async (tx) => {
      await tx.node.create({ data: { id, memoryId: agentMem, loc: 'tasks:a:comment', name: 'c', nodeType: 'comment', content: 'x' } });
      await tx.commentMeta.create({ data: { nodeId: id, targetNodeId: target.id, threadState: 'OPEN', authorKey: `u:${id}` } });
      await tx.edge.create({ data: { memoryId: agentMem, sourceId: id, targetId: target.id, loc: 'tasks:a:comment-anchor', name: 'comment-anchor', governedKind: 'COMMENT_ANCHOR', anchorRevNo: 1, anchorApprovalHash: 'a'.repeat(64) } });
    });
    await migrate();
    expect((await kind(id))[0]).toBe('comment');
    expect((await kind(target.id))[0]).toBe('system');
  });

  it('keeps the revision fingerprint in step: a migrated row is not read as changed outside a revisioned writer, and a drifted one still is', async () => {
    const synced = await put(agentMem, 'tasks:a', { isRunnable: true });
    const drifted = await put(agentMem, 'tasks:b', { isRunnable: true });
    await sql(`UPDATE nodes SET name = 'changed behind the revision system' WHERE id = '${drifted.id}'`);
    await migrate();
    const reconcile = (id: string) => db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: agentMem }));
    expect(await reconcile(synced.id)).toBe(synced.revSeq);
    expect(await db.nodeRevision.count({ where: { nodeId: synced.id } })).toBe(0);
    expect(await reconcile(drifted.id)).toBe(drifted.revSeq + 1);
  });

  it('an approved task reads approved after: its approval columns are untouched', async () => {
    const t = await put(agentMem, 'tasks:a', { isRunnable: true });
    await db.node.update({ where: { id: t.id }, data: { approvedRevNo: 1, approvedAt: new Date(), approvedByInfo: 'a writer, before the migration', approvalHash: 'b'.repeat(64) } });
    const cols = { approvedRevNo: true, approvedAt: true, approvedBy: true, approvedByInfo: true, approvalHash: true } as const;
    const before = await db.node.findUniqueOrThrow({ where: { id: t.id }, select: cols });
    await migrate();
    expect(await db.node.findUniqueOrThrow({ where: { id: t.id }, select: cols })).toEqual(before);
  });
});

describe('#5485 the database rule: a task-family role only on a runnable row', () => {
  it('refuses the task roles on a row that is not runnable, and a generic update cannot clear isRunnable and leave the role', async () => {
    await migrate();
    await expect(put(knowledgeMem, 'a', { role: 'task' })).rejects.toThrow(/chk_nodes_task_role_runnable/);
    await expect(put(knowledgeMem, 'b', { role: 'task.role', isRunnable: false })).rejects.toThrow(/chk_nodes_task_role_runnable/);
    const t = await put(knowledgeMem, 'c', { role: 'task', isRunnable: true });
    await expect(db.node.update({ where: { id: t.id }, data: { isRunnable: false } })).rejects.toThrow(/chk_nodes_task_role_runnable/);
    await expect(db.node.update({ where: { id: t.id }, data: { isRunnable: null } })).rejects.toThrow(/chk_nodes_task_role_runnable/);
  });

  it('the reverse is not enforced: a runnable node may carry another role or none, and a similar role is not a task role', async () => {
    await migrate();
    await put(knowledgeMem, 'a', { isRunnable: true });
    await put(knowledgeMem, 'b', { isRunnable: true, role: 'review' });
    await put(knowledgeMem, 'c', { role: 'tasks' });
    await put(knowledgeMem, 'd', { role: 'taskmaster' });
    await put(knowledgeMem, 'e', { role: 'role-task' });
  });
});
