import { afterAll, beforeEach, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
afterAll(() => server.stop());
const times = ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'];
let memoryId: string;
let foreignId: string;
let principal: Context;
let eventIds: string[];

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { githubId: 278401, githubUsername: 'window2784' } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'Window', urn: 'window2784.example' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });
  memoryId = (await db.memory.create({ data: {
    id: generateId(), name: 'Readable', urn: 'window2784.example:readable', class: 'knowledge', organizationId: org.id,
  } })).id;
  const other = await db.user.create({ data: { githubId: 278402, githubUsername: 'foreign2784' } });
  foreignId = (await db.memory.create({ data: {
    id: generateId(), name: 'Foreign', urn: 'window2784.example:foreign', class: 'private', userId: other.id, ownerUserId: other.id,
  } })).id;
  principal = { db, userId: user.id, roles: ['READER'] };
  eventIds = times.map(() => generateId());
  await db.usageEvent.createMany({ data: times.map((createdAt, i) => ({
    id: eventIds[i], type: 'read', memoryId, userId: user.id, nodeLoc: 'same:loc', createdAt: new Date(createdAt),
  })) });
  await db.usageEvent.create({ data: {
    id: generateId(), type: 'read', memoryId: foreignId, nodeLoc: 'same:loc', createdAt: new Date(times[1]),
  } });
});

async function read(field: string, variables: Record<string, unknown> = {}, ctx = principal) {
  const selection = field === 'usageEvents' ? '{ id }' : '{ items { id } total hasMore }';
  const result = await server.executeOperation({
    query: `query($memoryId: ID, $nodeId: ID, $since: DateTime, $until: DateTime, $limit: Int, $offset: Int) {
      ${field}(memoryId: $memoryId, nodeId: $nodeId, since: $since, until: $until, limit: $limit, offset: $offset) ${selection}
    }`,
    variables,
  }, { contextValue: ctx });
  if (result.body.kind !== 'single') throw new Error('Expected a single response');
  return result.body.singleResult;
}

it.each(['usageEvents', 'usageEventsPage'])('%s implements the half-open window through the real schema', async field => {
  for (const [window, expected] of [
    [{ since: times[1], until: times[2] }, [eventIds[1]]],
    [{ since: '2026-10-02T02:00:00+02:00', until: times[2] }, [eventIds[1]]],
    [{ since: times[1] }, [eventIds[2], eventIds[1]]],
    [{ until: times[1] }, [eventIds[0]]],
    [{}, [...eventIds].reverse()],
    [{ since: null, until: null }, [...eventIds].reverse()],
  ] as const) {
    const result = await read(field, { memoryId, ...window });
    expect(result.errors).toBeUndefined();
    const value = result.data![field] as any;
    expect((field === 'usageEvents' ? value : value.items).map((row: any) => row.id)).toEqual(expected);
    if (field === 'usageEventsPage') expect(value.total).toBe(expected.length);
  }
});

it.each(['usageEvents', 'usageEventsPage'])('%s validates range order before memory access', async field => {
  for (const until of [times[1], times[0]]) {
    const errors = [];
    for (const resource of [{ memoryId }, { memoryId: foreignId }, { memoryId: generateId() }, { nodeId: generateId() }]) {
      const result = await read(field, { ...resource, since: times[1], until });
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(result.errors![0].message).toMatch(/since.*until/i);
      errors.push(result.errors![0].message);
    }
    expect(new Set(errors).size).toBe(1);
  }
});

it('page total is windowed before offset and keeps the existing cap', async () => {
  await db.usageEvent.createMany({ data: Array.from({ length: 210 }, () => ({
    id: generateId(), type: 'read', memoryId, createdAt: new Date(times[1]),
  })) });
  const result = await read('usageEventsPage', { memoryId, since: times[1], until: times[2], limit: 5000, offset: 1 });
  expect(result.errors).toBeUndefined();
  expect(result.data!.usageEventsPage).toMatchObject({ total: 211, hasMore: true });
  expect((result.data!.usageEventsPage as any).items).toHaveLength(200);
});

it.each(['usageEvents', 'usageEventsPage'])('%s never exposes unreadable-memory events in the unscoped feed', async field => {
  const result = await read(field, { since: times[1], until: times[2] });
  expect(result.errors).toBeUndefined();
  const value = result.data![field] as any;
  expect((field === 'usageEvents' ? value : value.items).map((row: any) => row.id)).toEqual([eventIds[1]]);
});


it.each(['usageEvents', 'usageEventsPage'])('%s preserves missing/unreadable-memory and App-key refusals with a window', async field => {
  const appKey: Context = { db, appId: generateId(), roles: [] };
  for (const [resource, ctx] of [
    [{ memoryId: foreignId }, principal],
    [{ memoryId: generateId() }, principal],
    [{}, appKey],
  ] as const) {
    const unwindowed = await read(field, resource, ctx);
    const windowed = await read(field, { ...resource, since: times[1], until: times[2] }, ctx);
    expect(unwindowed.errors).toHaveLength(1);
    expect(windowed.errors?.map(({ message, extensions }) => ({ message, code: extensions?.code }))).toEqual(
      unwindowed.errors!.map(({ message, extensions }) => ({ message, code: extensions?.code })),
    );
    expect(windowed.data).toEqual(unwindowed.data);
  }
});

it.each(['usageEvents', 'usageEventsPage'])('%s narrows the existing readable-memory feed, not to own activity', async field => {
  const otherEvent = await db.usageEvent.create({ data: {
    id: generateId(), type: 'read', memoryId, userId: null, createdAt: new Date(times[1]),
  } });
  const all = await read(field);
  const windowed = await read(field, { since: times[1], until: times[2] });
  expect(all.errors).toBeUndefined();
  expect(windowed.errors).toBeUndefined();
  const rows = (result: typeof all) => {
    const value = result.data![field] as any;
    return (field === 'usageEvents' ? value : value.items) as { id: string }[];
  };
  expect(rows(all)).toHaveLength(4);
  expect(rows(windowed).map(row => row.id).sort()).toEqual([eventIds[1], otherEvent.id].sort());
});

it.each(['usageEvents', 'usageEventsPage'])('%s keeps its own default and requested limit handling', async field => {
  await db.usageEvent.createMany({ data: Array.from({ length: 210 }, (_, i) => ({
    id: generateId(), type: 'read', memoryId, createdAt: new Date(new Date(times[1]).getTime() + i + 1),
  })) });
  for (const limit of [undefined, null, 0, 5000]) {
    // A window encompassing every fixture row must preserve exact row order,
    // count-only semantics and the legacy list/page difference (issue2817).
    const all = await read(field, { memoryId, limit });
    const windowed = await read(field, { memoryId, limit, since: times[0], until: '2026-10-04T00:00:00Z' });
    expect(all.errors).toBeUndefined();
    expect(windowed.errors).toBeUndefined();
    const value = windowed.data![field] as any;
    const expected = limit === 0 ? 0 : limit == null ? 20 : field === 'usageEvents' ? 213 : 200;
    expect(field === 'usageEvents' ? value : value.items).toHaveLength(expected);
    // Unique timestamps avoid claiming a new ordering guarantee for legacy ties.
    if (field === 'usageEvents') expect(value.map((row: any) => row.id).sort()).toEqual(
      (all.data![field] as any[]).map(row => row.id).sort(),
    );
    else expect(windowed.data).toEqual(all.data);
  }
});

it('direct delegates reject invalid timestamps without relying on Prisma validation', async () => {
  await expect(resolvers.Query.usageEvents(null, { since: 'invalid' }, principal)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  await expect(resolvers.Query.usageEventsPage(null, { until: 'invalid' }, principal)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
});


it.each(['usageEvents', 'usageEventsPage'])('%s requires explicit-offset ISO instants before resource resolution', async field => {
  for (const bound of ['since', 'until']) {
    for (const value of ['10/02/2026', '2026-10-02', '2026-10-02T00:00:00', '2026-02-30T00:00:00Z', 'not-a-date']) {
      const messages = [];
      for (const resource of [{ memoryId }, { memoryId: foreignId }, { memoryId: generateId() }, { nodeId: generateId() }]) {
        const result = await read(field, { ...resource, [bound]: value });
        expect(result.errors, `${field} ${bound}=${value}`).toHaveLength(1);
        expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
        messages.push(result.errors![0].message);
      }
      expect(new Set(messages).size).toBe(1);
    }
  }
});

it.each(['usageEvents', 'usageEventsPage'])('%s validates inline bounds as instants and accepts explicit offsets', async field => {
  const selection = field === 'usageEvents' ? '{ id }' : '{ items { id } total }';
  for (const bound of ['since', 'until']) {
    for (const value of ['10/02/2026', '2026-10-02', '2026-10-02T00:00:00', '2026-02-30T00:00:00Z']) {
      const result = await server.executeOperation({ query: `{ ${field}(memoryId: "${memoryId}", ${bound}: "${value}") ${selection} }` }, { contextValue: principal });
      if (result.body.kind !== 'single') throw new Error('Expected a single response');
      expect(result.body.singleResult.errors, `${bound}=${value}`).toHaveLength(1);
      expect(result.body.singleResult.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    }
  }
  const result = await server.executeOperation({ query: `{ ${field}(memoryId: "${memoryId}", since: "2026-10-02T02:00:00+02:00", until: "${times[2]}") ${selection} }` }, { contextValue: principal });
  if (result.body.kind !== 'single') throw new Error('Expected a single response');
  expect(result.body.singleResult.errors).toBeUndefined();
  const value = result.body.singleResult.data![field] as any;
  expect((field === 'usageEvents' ? value : value.items).map((row: any) => row.id)).toEqual([eventIds[1]]);
});
