/** Session metadata reads must not materialize unselected usage history (#2758). */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const logged = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
  log: [{ emit: 'event', level: 'query' }],
});
const queries: string[] = [];
logged.$on('query', (event) => queries.push(event.query));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
let ids: string[];
const eventQueries = () => queries.filter((sql) => /FROM "public"\."usage_events"/.test(sql));
async function execute(query: string) {
  queries.length = 0;
  const result = await server.executeOperation({ query }, {
    contextValue: { db: logged, roles: ['ADMIN'] } as Context,
  });
  if (result.body.kind !== 'single') throw new Error('Unexpected incremental response');
  expect(result.body.singleResult.errors).toBeUndefined();
  return result.body.singleResult.data as any;
}

beforeEach(async () => {
  await cleanDb(db);
  ids = [generateId(), generateId(), generateId()];
  await db.session.createMany({ data: ids.map((id) => ({ id, repo: 'session-projection' })) });
  await db.usageEvent.createMany({ data: ids.flatMap((sessionId) =>
    Array.from({ length: 60 }, (_, index) => ({
      id: `${sessionId}-event-${index}`, sessionId, type: 'read',
      createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000),
      actionArgs: { synthetic: 'not selected' },
    })),
  ) });
});
afterAll(async () => { await server.stop(); await logged.$disconnect(); });

describe('session metadata projections', () => {
  it.each(['list', 'page', 'point'] as const)('%s emits no usage-event fetch for id-only output', async (kind) => {
    const query = kind === 'list'
      ? '{ sessions(repo:"session-projection",limit:3) { id } }'
      : kind === 'page'
        ? '{ sessionsPage(repo:"session-projection",limit:3) { items { id } total } }'
        : `{ session(id:"${ids[0]}") { id } }`;
    const data = await execute(query);
    const returned = kind === 'list' ? data.sessions : kind === 'page' ? data.sessionsPage.items : [data.session];
    expect(returned.map((s: { id: string }) => s.id).sort()).toEqual((kind === 'point' ? [ids[0]] : ids).slice().sort());
    if (kind === 'page') expect(data.sessionsPage.total).toBe(3);
    expect(eventQueries()).toEqual([]);
  });

  it('explicit events keep the guarded lazy resolver and SQL limit of 50 per session', async () => {
    const data = await execute('{ sessions(repo:"session-projection",limit:3) { id events { id } } }');
    expect(data.sessions).toHaveLength(3);
    for (const session of data.sessions) {
      expect(session.events.map((event: { id: string }) => event.id)).toEqual(
        Array.from({ length: 50 }, (_, i) => `${session.id}-event-${59 - i}`),
      );
    }
    // No extra eager relation query: only each selected, independently gated field fetch.
    expect(eventQueries()).toHaveLength(3);
    expect(eventQueries().every((sql) => /LIMIT/.test(sql))).toBe(true);
  });
});
