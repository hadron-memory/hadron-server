/**
 * #4153 — App-boundary and batching pins on `AgentTeamEvent.taskHandle`, the surface #4146 added.
 * Tests only: production is already correct at the reviewed head; the red for each pin is the mutant
 * the gate names (delete the appId scope on either lookup, un-dedup the batch, cap the legacy list,
 * unregister the field). Law: cor:agt:050:01 ("Concealed" — a handle naming no task the caller may
 * read answers as an unknown id), cor:agt:050:21/:23 (a reader reaches only its own App's tasks).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { deploymentSchema } from './deploymentSchema.js';

const schema = buildSchema(typeDefs);
let app: { id: string };
let other: { id: string };
let member: { id: string };
let stranger: { id: string };
const ctx = (): Context => ({ db, userId: member.id, roles: ['READER'] });
const run = (source: string, contextValue = ctx()) => graphql({ schema, source, contextValue,
  fieldResolver: (parent, args, context, info) => {
    const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
    const resolver = fields?.[info.fieldName];
    return typeof resolver === 'function' ? resolver(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
  },
});
const pageQuery = () => `{ agentTeamEventsPage(appRef:"${app.id}",limit:50) { events { id taskId taskHandle } hasMore nextCursor } }`;
const task = (inApp: { id: string } = app, ownerUserId: string = member.id) =>
  db.agentTask.create({ data: { id: generateId(), appId: inApp.id, ownerUserId, title: 'boundary fixture' } });
const event = (taskId: string | null, type = 'task.created') =>
  db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, taskId, type } });
const alarm = (taskId: string | null) => db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, taskId,
  type: 'stall.not-started', severity: 'alarm', chain: [{ userId: member.id }], episodeStart: new Date() } });
beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({ data: { id: generateId(), name: 'event boundary', urn: `eb-${suffix}.com` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 415301, githubUsername: `eb-${suffix}` } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 415302, githubUsername: `ebo-${suffix}` } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'inside', urn: `${org.urn}:inside` } });
  other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'outside', urn: `${org.urn}:outside` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: other.id, userId: stranger.id, role: 'member' } });
});
afterEach(() => vi.restoreAllMocks());

describe('AgentTeamEvent.taskHandle boundary and batching (#4153)', () => {
  it('hydrates a foreign-App taskId to null on the page read (the batch is App-scoped)', async () => {
    const mine = await task();
    // A real task row in the other App, owned there: present in the table, unreadable here.
    const foreign = await task(other, stranger.id);
    expect(foreign.handle).toMatch(/^AT\d+$/);
    await event(mine.id);
    await event(foreign.id);
    const response = await run(pageQuery());
    expect(response.errors).toBeUndefined();
    const rows = (response.data?.agentTeamEventsPage as any).events;
    expect(rows).toHaveLength(2);
    expect(rows.find((row: any) => row.taskId === mine.id).taskHandle).toBe(mine.handle);
    // cor:agt:050:01 "Concealed": exactly the null of an unknown id, never the other App's handle.
    expect(rows.find((row: any) => row.taskId === foreign.id).taskHandle).toBe(null);
  });

  it('answers a foreign-App taskId null through the acknowledgeAlarm single-event fallback', async () => {
    const foreign = await task(other, stranger.id);
    const raised = await alarm(foreign.id);
    const response = await run(`mutation { acknowledgeAlarm(eventId:"${raised.id}") { id taskId taskHandle } }`);
    expect(response.errors).toBeUndefined();
    expect(response.data?.acknowledgeAlarm).toEqual({ id: raised.id, taskId: foreign.id, taskHandle: null });
  });

  it('deduplicates the handle batch: several events on one task read it once', async () => {
    const t = await task();
    await event(t.id); await event(t.id, 'task.assigned'); await event(t.id, 'task.completed');
    const many = vi.spyOn(db.agentTask, 'findMany');
    const response = await run(pageQuery());
    expect(response.errors).toBeUndefined();
    const rows = (response.data?.agentTeamEventsPage as any).events;
    expect(rows).toHaveLength(3);
    expect(rows.every((row: any) => row.taskHandle === t.handle)).toBe(true);
    // The batch's id set, not just its call count: SQL IN dedups observably either way (gate note),
    // so the pin must see the one id the resolver asked for.
    expect(many).toHaveBeenCalledTimes(1);
    expect(many.mock.calls[0]![0]!.where).toEqual({ appId: app.id, id: { in: [t.id] } });
  });

  it('reads 50 distinct handles through the legacy list at limit:50, with no per-event task read', async () => {
    const tasks = [];
    for (let i = 0; i < 50; i++) { const t = await task(); tasks.push(t); await event(t.id); }
    const many = vi.spyOn(db.agentTask, 'findMany');
    const unique = vi.spyOn(db.agentTask, 'findUnique');
    const first = vi.spyOn(db.agentTask, 'findFirst');
    // limit is explicit: the legacy default page is 20 (cor:api:120:04), so the pin must not lean on it (FIT note).
    const response = await run(`{ agentTeamEvents(appRef:"${app.id}",limit:50) { taskId taskHandle } }`);
    expect(response.errors).toBeUndefined();
    const rows = response.data?.agentTeamEvents as any[];
    expect(rows).toHaveLength(50);
    expect(rows.map((row: any) => row.taskHandle).sort()).toEqual(tasks.map(t => t.handle).sort());
    expect(new Set(rows.map((row: any) => row.taskHandle)).size).toBe(50);
    expect(many).toHaveBeenCalledTimes(1); expect(unique).not.toHaveBeenCalled(); expect(first).not.toHaveBeenCalled();
  });

  it('resolves the field through the production ApolloServer wiring, page and single-event fallback', async () => {
    const t = await task();
    await event(t.id);
    const raised = await alarm(t.id);
    // The construction src/server.ts uses (deploymentSchema's typeDefs + resolvers on one ApolloServer),
    // not this file's buildSchema + resolver-map helper: a field registered under the wrong type, or
    // dropped by a deployment filter, resolves null here while the helper still finds it.
    const wired = deploymentSchema();
    const server = new ApolloServer<Context>({ typeDefs: wired.typeDefs, resolvers: wired.resolvers });
    await server.start();
    try {
      const op = async (query: string) => {
        const r = await server.executeOperation({ query }, { contextValue: ctx() });
        if (r.body.kind !== 'single') throw new Error('single result expected');
        return r.body.singleResult;
      };
      const page = await op(pageQuery());
      expect(page.errors).toBeUndefined();
      expect((page.data?.agentTeamEventsPage as any).events[0].taskHandle).toBe(t.handle);
      // The fallback leg carries the mutant kill: acknowledgeAlarm returns a raw row, so only the
      // registered field resolver can produce a handle here.
      const ack = await op(`mutation { acknowledgeAlarm(eventId:"${raised.id}") { id taskHandle } }`);
      expect(ack.errors).toBeUndefined();
      expect((ack.data?.acknowledgeAlarm as any).taskHandle).toBe(t.handle);
    } finally {
      await server.stop();
    }
  });
});
