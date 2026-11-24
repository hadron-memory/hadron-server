/**
 * #5078: the lock order the fold at commit exists for, through the two real doors. `recordTeamWork` (kind pr) inserts its worklog node and
 * then writes the Session row; `createTeamChatMessage` resumes a lapsed Session (writing its row) and then inserts the message, in the same
 * memory. With a counter row locked by the write itself, one of them dies with 40P01.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaiters } from '../../test/lockWait.js';
import { expectNodeTotalsExact } from '../../test/nodeTotals.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const DAY = 86_400_000;
let member: string;
let appId: string;
let sessionId: string;
const ctx = (client = db): Context => ({ db: client, userId: member, roles: ['READER'] }) as Context;
const post = (body: string, client = db) => M.createTeamChatMessage({}, { appRef: appId, sessionRef: sessionId, body }, ctx(client));
const record = (n: number) =>
  M.recordTeamWork({}, { appRef: appId, sessionRef: sessionId, tool: 'github', kind: 'pr', ref: `o/r#${n}`, action: 'opened' }, ctx());
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

it('a worklog record and a post that resumes the same lapsed session, crossed, both commit with no deadlock', async () => {
  const message = await db.node.findFirstOrThrow({ where: { nodeType: 'chat-message' } });
  const work = await db.node.findFirstOrThrow({ where: { nodeType: 'record', objectType: { not: null } } });
  expect(work.memoryId).toBe(message.memoryId);
  await lapse();
  let reached!: () => void;
  let release!: () => void;
  const atInsert = new Promise<void>((r) => { reached = r; });
  const released = new Promise<void>((r) => { release = r; });
  // Stops the post right before its message insert: it has written the Session row and not yet a node.
  const pausing = new Proxy(db, { get(t, p) {
    const real = Reflect.get(t, p) as unknown;
    if (p !== '$transaction') return typeof real === 'function' ? real.bind(t) : real;
    return (fn: (tx: unknown) => Promise<unknown>, opts: unknown) => (t.$transaction as any)((tx: any) => fn(new Proxy(tx, { get(x, q) {
      const inner = Reflect.get(x, q) as any;
      if (q !== 'node') return typeof inner === 'function' ? inner.bind(x) : inner;
      return new Proxy(inner, { get: (n, m) => m !== 'create' ? (n as any)[m].bind(n) : async (args: unknown) => {
        reached();
        await released;
        return (n as any).create(args);
      } });
    } })), opts);
  } });
  // The #1162 fence makes this pair deadlock on main already (both writes name one worker, and the fence row is held to commit), so it is
  // off here: the pin is that the totals add no edge of their own. With an immediate counter in their place it still dies with 40P01.
  await db.$executeRaw`ALTER TABLE nodes DISABLE TRIGGER worker_reference_fence_1162`;
  try {
    const posted = post('resumes', pausing).then(() => 'posted', (e: unknown) => e);
    await atInsert;
    const recorded = record(2).then(() => 'recorded', (e: unknown) => e);
    await waitForLockWaiters(db, 1);
    release();
    expect([await posted, await recorded]).toEqual(['posted', 'recorded']);
  } finally {
    release();
    await db.$executeRaw`ALTER TABLE nodes ENABLE TRIGGER worker_reference_fence_1162`;
  }
  await expectNodeTotalsExact(db);
});
