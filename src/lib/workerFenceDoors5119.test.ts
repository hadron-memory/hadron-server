/**
 * #5119: the worklog door (kind pr) and a team-chat post that resumes the same lapsed session, in one memory, both with the
 * #1162 worker fence ON. Both writes name one worker, and the fence row is held to commit, so they must take the Session row and the
 * fence in ONE order: the worklog door used to take the fence (its node insert) and then the Session row, the post the Session row
 * and then the fence, and the pair died with 40P01.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { waitForLockWaiters } from '../test/lockWait.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { generateId } from './id.js';
import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const DAY = 86_400_000;
let member: string;
let appId: string;
let sessionId: string;
const ctx = (client = db): Context => ({ db: client, userId: member, roles: ['READER'] }) as Context;
const post = (body: string, client = db) => M.createTeamChatMessage({}, { appRef: appId, sessionRef: sessionId, body }, ctx(client));
const record = (n: number, client = db) =>
  M.recordTeamWork({}, { appRef: appId, sessionRef: sessionId, tool: 'github', kind: 'pr', ref: `o/r#${n}`, action: 'opened' }, ctx(client));
const lapse = () => db.$executeRaw`UPDATE sessions SET updated_at = ${new Date(Date.now() - 3 * DAY)}, started_at = ${new Date(Date.now() - 3 * DAY)} WHERE id = ${sessionId}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'nt-doors', urn: 'nt-doors.example' } });
  const user = async (handle: string) => (await db.user.create({ data: { id: generateId(), handle, roles: ['READER'] } })).id;
  const orgAdmin = await user('nt-oa');
  member = await user('nt-member');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgAdmin, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, { db, userId: orgAdmin, roles: ['READER'] } as Context);
  await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId, loc: 'roles:server-engineer', name: 'server-engineer', content: 'You are {{worker.name}}.' } });
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } })).id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.appMember.create({ data: { appId, userId: member, role: 'member' } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Anne', slug: 'anne', heldByUserId: member } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId, workerId: worker.id, agentId: agent.id, userId: member } })).id;
  // The first of each makes its parents, so the raced writes are the plain appends.
  await record(1);
  await post('hello');
});

/** Wraps `db` so the FIRST `tx.node.create` matching `when` can be held: `onCreated` fires once the row exists (or, with `before`, just before). */
function holdingNodeCreate(when: (args: any) => boolean, hold: { reached: () => void; released: Promise<void>; before?: boolean }) {
  return new Proxy(db, { get(t, p) {
    const real = Reflect.get(t, p) as unknown;
    if (p !== '$transaction') return typeof real === 'function' ? real.bind(t) : real;
    return (fn: (tx: unknown) => Promise<unknown>, opts: unknown) => (t.$transaction as any)((tx: any) => fn(new Proxy(tx, { get(x, q) {
      const inner = Reflect.get(x, q) as any;
      if (q !== 'node') return typeof inner === 'function' ? inner.bind(x) : inner;
      return new Proxy(inner, { get: (n, m) => typeof (n as any)[m] !== 'function' ? (n as any)[m] : m !== 'create' ? (n as any)[m].bind(n) : async (args: any) => {
        if (!when(args)) return (n as any).create(args);
        if (hold.before) { hold.reached(); await hold.released; return (n as any).create(args); }
        const row = await (n as any).create(args);
        hold.reached();
        await hold.released;
        return row;
      } });
    } })), opts);
  } });
}
const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)));
const isWorklog = (args: any) => String(args?.data?.loc ?? '').startsWith('worklog');
const isMessage = (args: any) => args?.data?.nodeType === 'chat-message';

async function expectBothWritten() {
  expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } }).then((s) => s.prNumber)).toBe(2);
  expect(await db.node.count({ where: { nodeType: 'record', objectType: { not: null }, name: { contains: 'o/r#2' } } })).toBe(1);
  expect(await db.node.count({ where: { nodeType: 'chat-message', content: { contains: 'resumes' } } })).toBe(1);
}

it('the worklog door held right after its node insert, then a post that resumes the same lapsed session: both commit, no deadlock', async () => {
  await lapse();
  let reached!: () => void;
  let release!: () => void;
  const atRecorded = new Promise<void>((r) => { reached = r; });
  const released = new Promise<void>((r) => { release = r; });
  const recorded = settle(record(2, holdingNodeCreate(isWorklog, { reached, released }) as typeof db));
  await atRecorded;
  const posted = settle(post('resumes'));
  await waitForLockWaiters(db, 1);
  release();
  expect([await recorded, await posted]).toEqual(['ok', 'ok']);
  await expectBothWritten();
});

it('the reverse interleaving: the post held right before its message insert (Session row and fence taken), then the worklog door: both commit, no deadlock', async () => {
  await lapse();
  let reached!: () => void;
  let release!: () => void;
  const atInsert = new Promise<void>((r) => { reached = r; });
  const released = new Promise<void>((r) => { release = r; });
  const posted = settle(post('resumes', holdingNodeCreate(isMessage, { reached, released, before: true }) as typeof db));
  await atInsert;
  const recorded = settle(record(2));
  await waitForLockWaiters(db, 1);
  release();
  expect([await posted, await recorded]).toEqual(['ok', 'ok']);
  await expectBothWritten();
});
