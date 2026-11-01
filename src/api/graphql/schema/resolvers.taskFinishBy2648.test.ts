/** #2648 (cor:agt:050:14, Refused values): setting and editing a task's finish-by time. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let app: any, owner: any, assignee: any;
const ctx = () => ({ db, userId: owner.id, roles: ['READER'] });
const HOUR = 3_600_000;
const iso = (offsetHours: number) => new Date(Date.now() + offsetHours * HOUR).toISOString();
const create = (input: Record<string, unknown>) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'T', assignee: { user: assignee.id }, ...input } }, ctx());
const edit = (taskId: string, input: Record<string, unknown>) => M.updateAgentTask({}, { taskId, input }, ctx());
const row = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } });
const edits = (taskId: string) => db.agentTeamEvent.findMany({ where: { taskId, type: 'task.edited' } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'FB', urn: `fb-${generateId()}.test` } });
  [owner, assignee] = await Promise.all(['owner', 'assignee'].map((handle) => db.user.create({ data: { handle } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'FB', urn: `${org.urn}:fb` } });
  for (const u of [owner, assignee]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
});

describe('#2648 — create', () => {
  it('stores a finish-by time and returns it', async () => {
    const t = await create({ finishBy: iso(2), startBy: iso(1) });
    expect((await row(t.id)).finishBy).toEqual(new Date(t.finishBy));
    expect(t.finishBy).toBeInstanceOf(Date);
  });
  it('allows equal start-by and finish-by times', async () => {
    const same = iso(2);
    const t = await create({ finishBy: same, startBy: same });
    expect((await row(t.id)).finishBy).toEqual(new Date(same));
  });
  it.each([
    ['in the past', { finishBy: iso(-1) }],
    ['earlier than startBy', { finishBy: iso(1), startBy: iso(2) }],
    ['not a date', { finishBy: 'soon' }],
  ])('refuses a finish-by time %s, creating nothing', async (_, input) => {
    await expect(create(input)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.agentTask.count()).toBe(0);
  });
});

describe('#2648 — edit', () => {
  it('sets, changes and clears it, naming finishBy in task.edited', async () => {
    const t = await create({});
    await edit(t.id, { finishBy: iso(3) });
    expect((await row(t.id)).finishBy).not.toBeNull();
    await edit(t.id, { finishBy: null });
    expect((await row(t.id)).finishBy).toBeNull();
    expect((await edits(t.id)).map((e) => e.payload)).toEqual([{ fields: ['finishBy'] }, { fields: ['finishBy'] }]);
  });

  it.each([
    ['a past finish-by', () => ({ finishBy: iso(-1) })],
    ['a finish-by before the task\'s start-by', () => ({ finishBy: iso(1) })],
    ['a start-by later than the task\'s finish-by', () => ({ startBy: iso(5) })],
    ['a finish-by before a start-by set in the same call', () => ({ startBy: iso(4), finishBy: iso(3) })],
  ])('refuses %s, changing nothing', async (_, input) => {
    const t = await create({ startBy: iso(2), finishBy: iso(4) });
    const before = await row(t.id);
    await expect(edit(t.id, input())).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await row(t.id)).toEqual(before);
    expect(await edits(t.id)).toHaveLength(0);
  });

  it('refuses a later start-by even when the finish-by time has already passed', async () => {
    const t = await create({ startBy: iso(1), finishBy: iso(2) });
    await db.agentTask.update({ where: { id: t.id }, data: { finishBy: new Date(Date.now() - HOUR), startBy: null } });
    await expect(edit(t.id, { startBy: iso(1) })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('checks nothing when the call sets neither time, or clears one', async () => {
    const t = await create({ startBy: iso(1), finishBy: iso(2) });
    await db.agentTask.update({ where: { id: t.id }, data: { finishBy: new Date(Date.now() - HOUR) } }); // past, start-by after it
    expect((await edit(t.id, { title: 'Renamed' })).title).toBe('Renamed');
    await edit(t.id, { startBy: null });
    expect((await row(t.id)).startBy).toBeNull();
  });
});

describe('#2648 — BLIND P2: a create judges finish-by after its lock waits, on the database clock', () => {
  it('a deadline that passes while the create waits on a lock is refused and nothing is inserted', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${app.id} AND user_id = ${owner.id} FOR UPDATE`;
      locked();
      await held;
    }, { timeout: 20_000 });
    await isLocked;
    const deadline = new Date(Date.now() + 1_500);
    const creating = create({ finishBy: deadline.toISOString() });
    await new Promise((r) => setTimeout(r, 2_500)); // the deadline passes while the create waits
    release();
    await holder;
    await expect(creating).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.agentTask.count()).toBe(0);
  }, 20_000);
});

