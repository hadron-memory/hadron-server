/** #3897: structural cleanup oracle and actual GraphQL compatibility, not a behavior-changing guard. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(async () => { await server.stop(); await cleanDb(db); });
let holderId: string, targetId: string, appId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Compatibility', urn: 'compat3897.test' } });
  holderId = (await db.user.create({ data: { id: generateId(), handle: 'compat-holder' } })).id;
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Engineer', urn: 'compat3897.test:engineer' } });
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'compat3897.test:team' } })).id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.appMember.create({ data: { appId, userId: holderId, role: 'member' } });
  targetId = (await db.worker.create({ data: { appId, agentId: agent.id, name: 'Target', slug: 'target', signature: '', trailer: '', heldByUserId: holderId } })).id;
});

it('structurally removes the shadowed isolation keys from wakeSettingsOut', () => {
  const source = ts.createSourceFile('resolvers.ticker.ts', readFileSync(new URL('./resolvers.ticker.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'wakeSettingsOut');
  expect(fn?.body).toBeDefined();
  const returned = fn!.body!.statements.find(ts.isReturnStatement)?.expression;
  expect(returned && ts.isObjectLiteralExpression(returned)).toBe(true);
  if (!returned || !ts.isObjectLiteralExpression(returned)) throw new Error('wakeSettingsOut must return an object');
  const keys = returned.properties.map(property => property.name?.getText(source));
  expect(keys).toEqual(['workerId', 'mentions', 'pausedUntil']);
});

it.each([false, true])('executes get and clear selections without changing settings or events (stored row: %s)', async stored => {
  const until = new Date('2099-01-01T00:00:00.000Z');
  if (stored) await db.workerWakeSettings.create({ data: { workerId: targetId, mentions: 'OFF', pausedUntil: until } });
  const snapshot = async () => ({
    settings: await db.workerWakeSettings.findUnique({ where: { workerId: targetId } }),
    events: await db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
  });
  const before = await snapshot();
  for (const [operation, field] of [['query', 'workerWakeSettings'], ['mutation', 'clearWorkerIsolation']]) {
    const result = await server.executeOperation({
      query: `${operation}($ref: String!) { ${field}(workerRef: $ref) {
        worker { id } mentions pausedUntil effectiveCadenceSeconds
        isolated isolatedUntil isolatedAt isolatedByHandle canManageIsolation
      } }`,
      variables: { ref: targetId },
    }, { contextValue: { db, userId: holderId, roles: ['READER'] } });
    expect(result.body.kind).toBe('single');
    if (result.body.kind !== 'single') throw new Error('Expected a single GraphQL result');
    expect(result.body.singleResult.errors).toBeUndefined();
    expect(result.body.singleResult.data?.[field]).toEqual({
      worker: { id: targetId }, mentions: stored ? 'OFF' : 'IMMEDIATE', pausedUntil: stored ? until.toISOString() : null,
      effectiveCadenceSeconds: null, isolated: false, isolatedUntil: null, isolatedAt: null,
      isolatedByHandle: null, canManageIsolation: false,
    });
    expect(await snapshot()).toEqual(before);
  }
});
