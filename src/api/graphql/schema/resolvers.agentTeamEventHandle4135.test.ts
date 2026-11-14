/** #4135 — stored task handles on the existing event audience, with a bounded page read. #4153 — boundary, batching and wiring pins. */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const schema = buildSchema(typeDefs);
let app: { id: string };
let member: { id: string };
let outsider: { id: string };
const ctx = (): Context => ({ db, userId: member.id, roles: ['READER'] });
const run = (source: string, contextValue = ctx()) => graphql({ schema, source, contextValue,
  fieldResolver: (parent, args, context, info) => {
    const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
    const resolver = fields?.[info.fieldName];
    return typeof resolver === 'function' ? resolver(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
  },
});
const query = (fields = 'id taskId taskHandle') => `{ agentTeamEventsPage(appRef:"${app.id}",limit:50) { events { ${fields} } hasMore nextCursor } }`;
const task = (extra = {}) => db.agentTask.create({ data: { id: generateId(), appId: app.id, ownerUserId: member.id, title: 'handle fixture', ...extra } });
const event = (taskId: string | null, type = 'task.created') => db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, taskId, type } });
beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({ data: { id: generateId(), name: 'event handles', urn: `eh-${suffix}.com` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 413501, githubUsername: `eh-${suffix}` } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 413502, githubUsername: `eho-${suffix}` } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'handles', urn: `${org.urn}:handles` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
});
afterEach(() => vi.restoreAllMocks());

describe('AgentTeamEvent.taskHandle (#4135)', () => {
  it('returns the stored project and nested handle, including a cancelled task, on list and page', async () => {
    const project = await task();
    const child = await task({ parentTaskId: project.id, status: 'cancelled', cancelledAt: new Date() });
    await event(project.id); await event(child.id, 'task.cancelled');
    const response = await run(`{ agentTeamEvents(appRef:"${app.id}") { taskId taskHandle } agentTeamEventsPage(appRef:"${app.id}") { events { taskId taskHandle } } }`);
    expect(response.errors).toBeUndefined();
    const byTask = (a: { taskId: string }, b: { taskId: string }) => a.taskId.localeCompare(b.taskId);
    const expected = [{ taskId: project.id, taskHandle: project.handle }, { taskId: child.id, taskHandle: child.handle }].sort(byTask);
    expect(project.handle).toMatch(/^AT\d+$/); expect(child.handle).toBe(`${project.handle}.1`);
    expect((response.data?.agentTeamEvents as any[]).sort(byTask)).toEqual(expected);
    expect((response.data?.agentTeamEventsPage as any).events.sort(byTask)).toEqual(expected);
  });

  it('never invents a handle for taskless events or a retained event whose task was deleted', async () => {
    for (const type of ['alarm.dark-worker', 'alarm.coordinator-cadence', 'availability.changed', 'host.registered']) await event(null, type);
    const deleted = await task(); await event(deleted.id); await db.agentTask.delete({ where: { id: deleted.id } });
    const response = await run(query());
    expect(response.errors).toBeUndefined();
    const rows = (response.data?.agentTeamEventsPage as any).events;
    expect(rows).toHaveLength(5);
    expect(rows.map((row: any) => row.taskHandle)).toEqual(Array(5).fill(null));
    expect(rows.find((row: any) => row.taskId === deleted.id)).toBeDefined();
  });

  it('also returns the handle when acknowledging an existing task alarm', async () => {
    const t = await task();
    const alarm = await db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, taskId: t.id,
      type: 'stall.not-started', severity: 'alarm', chain: [{ userId: member.id }], episodeStart: new Date() } });
    const response = await run(`mutation { acknowledgeAlarm(eventId:"${alarm.id}") { id taskHandle } }`);
    expect(response.errors).toBeUndefined();
    expect(response.data?.acknowledgeAlarm).toEqual({ id: alarm.id, taskHandle: t.handle });
  });

  it('reads 50 distinct task handles in one batch, with no per-event task lookup', async () => {
    const tasks = [];
    for (let i = 0; i < 50; i++) { const t = await task(); tasks.push(t); await event(t.id); }
    const many = vi.spyOn(db.agentTask, 'findMany');
    const unique = vi.spyOn(db.agentTask, 'findUnique');
    const first = vi.spyOn(db.agentTask, 'findFirst');
    const response = await run(query());
    expect(response.errors).toBeUndefined();
    const rows = (response.data?.agentTeamEventsPage as any).events;
    expect(rows).toHaveLength(50);
    expect(rows.map((row: any) => row.taskHandle).sort()).toEqual(tasks.map(t => t.handle).sort());
    expect(many).toHaveBeenCalledTimes(1); expect(unique).not.toHaveBeenCalled(); expect(first).not.toHaveBeenCalled();
  });

  it('admits the App own key, and preserves the complete outsider refusal when requesting the new field', async () => {
    const t = await task(); await event(t.id);
    const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: generateId(), keyPreview: '4135' } });
    const response = await run(query(), { db, appId: app.id, appKeyId: key.id, roles: [] });
    expect(response.errors).toBeUndefined();
    expect((response.data?.agentTeamEventsPage as any).events[0].taskHandle).toBe(t.handle);
    const outsiderCtx: Context = { db, userId: outsider.id, roles: ['READER'] };
    const old = await run(query('id taskId'), outsiderCtx);
    const next = await run(query(), outsiderCtx);
    expect(old.errors?.[0]?.extensions.code).toBe('APP_NOT_FOUND');
    expect(JSON.parse(JSON.stringify(next))).toEqual(JSON.parse(JSON.stringify(old)));
  });
});

/** #4153: pins the existing #4135 behaviour only; no production change. */
describe('AgentTeamEvent.taskHandle boundary, batching and wiring (#4153)', () => {
  /** A task of ANOTHER App, whose id an event of `app` retains (event.task_id has no foreign key). */
  const foreignTask = async () => {
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: `eo-${generateId()}.com` } });
    const otherApp = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'other', urn: `${otherOrg.urn}:other` } });
    return db.agentTask.create({ data: { id: generateId(), appId: otherApp.id, ownerUserId: member.id, title: 'foreign' } });
  };

  it('returns a null handle for an event retaining a task of a different App, on the page read and the single-event fallback', async () => {
    const foreign = await foreignTask();
    expect(foreign.handle).toMatch(/^AT\d+$/);
    const own = await task();
    await event(foreign.id); await event(own.id);
    const alarm = await db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, taskId: foreign.id,
      type: 'stall.not-started', severity: 'alarm', chain: [{ userId: member.id }], episodeStart: new Date() } });
    const page = await run(query());
    expect(page.errors).toBeUndefined();
    const rows = (page.data?.agentTeamEventsPage as any).events as { taskId: string; taskHandle: string | null }[];
    expect(rows.find(r => r.taskId === foreign.id)).toBeDefined();
    expect(rows.filter(r => r.taskId === foreign.id).map(r => r.taskHandle)).toEqual([null, null]);
    expect(rows.find(r => r.taskId === own.id)?.taskHandle).toBe(own.handle);
    // The single raw event (acknowledgeAlarm) takes the field resolver's own lookup, which carries the App scope itself.
    const ack = await run(`mutation { acknowledgeAlarm(eventId:"${alarm.id}") { id taskId taskHandle } }`);
    expect(ack.errors).toBeUndefined();
    expect(ack.data?.acknowledgeAlarm).toEqual({ id: alarm.id, taskId: foreign.id, taskHandle: null });
  });

  it('reads one deduplicated id set when several events share a task', async () => {
    const a = await task(); const b = await task();
    for (let i = 0; i < 3; i++) await event(a.id);
    await event(b.id); await event(b.id); await event(null, 'host.registered');
    const many = vi.spyOn(db.agentTask, 'findMany');
    const response = await run(query());
    expect(response.errors).toBeUndefined();
    const rows = (response.data?.agentTeamEventsPage as any).events;
    expect(rows).toHaveLength(6);
    expect(many).toHaveBeenCalledTimes(1);
    const ids = (many.mock.calls[0]![0] as { where: { id: { in: string[] } } }).where.id.in;
    expect([...ids].sort()).toEqual([a.id, b.id].sort());
    expect(ids).toHaveLength(2);
  });

  it('the legacy list query also reads 50 distinct handles in one batch, with no per-event task lookup', async () => {
    const tasks = [];
    for (let i = 0; i < 50; i++) { const t = await task(); tasks.push(t); await event(t.id); }
    const many = vi.spyOn(db.agentTask, 'findMany');
    const unique = vi.spyOn(db.agentTask, 'findUnique');
    const first = vi.spyOn(db.agentTask, 'findFirst');
    const response = await run(`{ agentTeamEvents(appRef:"${app.id}", limit:50) { taskId taskHandle } }`);
    expect(response.errors).toBeUndefined();
    const rows = response.data?.agentTeamEvents as { taskId: string; taskHandle: string }[];
    expect(rows).toHaveLength(50);
    expect(rows.map(r => r.taskHandle).sort()).toEqual(tasks.map(t => t.handle).sort());
    expect(many).toHaveBeenCalledTimes(1); expect(unique).not.toHaveBeenCalled(); expect(first).not.toHaveBeenCalled();
  });

  describe('through the production ApolloServer construction (src/server.ts)', () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    beforeAll(() => server.start());
    afterAll(() => server.stop());
    const exec = async (q: string, contextValue: Context = ctx()) => {
      const r = await server.executeOperation({ query: q }, { contextValue });
      if (r.body.kind !== 'single') throw new Error('single result expected');
      return r.body.singleResult;
    };

    it('serves the handle on the page, the list and an acknowledged alarm, and a null for a foreign or deleted task', async () => {
      const t = await task(); await event(t.id);
      const foreign = await foreignTask(); await event(foreign.id);
      const gone = await task(); await event(gone.id); await db.agentTask.delete({ where: { id: gone.id } });
      const alarm = await db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, taskId: t.id,
        type: 'stall.not-started', severity: 'alarm', chain: [{ userId: member.id }], episodeStart: new Date() } });
      const page = await exec(query());
      expect(page.errors).toBeUndefined();
      const by = (rows: any[]) => Object.fromEntries(rows.map(r => [r.taskId, r.taskHandle]));
      const expected = { [t.id]: t.handle, [foreign.id]: null, [gone.id]: null };
      expect(by((page.data?.agentTeamEventsPage as any).events)).toEqual(expected);
      const list = await exec(`{ agentTeamEvents(appRef:"${app.id}") { taskId taskHandle } }`);
      expect(list.errors).toBeUndefined();
      expect(by(list.data?.agentTeamEvents as any[])).toEqual(expected);
      const ack = await exec(`mutation { acknowledgeAlarm(eventId:"${alarm.id}") { id taskHandle } }`);
      expect(ack.errors).toBeUndefined();
      expect(ack.data?.acknowledgeAlarm).toEqual({ id: alarm.id, taskHandle: t.handle });
    });

    it('keeps the outsider refusal byte-identical with and without the new field', async () => {
      await event((await task()).id);
      const outsiderCtx: Context = { db, userId: outsider.id, roles: ['READER'] };
      const old = await exec(query('id taskId'), outsiderCtx);
      const next = await exec(query(), outsiderCtx);
      expect(old.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
      expect(JSON.parse(JSON.stringify(next))).toEqual(JSON.parse(JSON.stringify(old)));
    });
  });
});
