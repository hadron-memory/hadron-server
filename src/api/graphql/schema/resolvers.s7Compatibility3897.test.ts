/** #3897: structural cleanup oracle. The executed get/clear compatibility selections were retired with the fields (#3696). */
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
