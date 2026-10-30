import { ApolloServer } from '@apollo/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { taskWarningsPlugin } from '../taskWarningsPlugin.js';
import { tickFixture2733, tickTaskLoc2733 } from '../../../test/tickRegister2733.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
afterAll(() => server.stop());
let f: Awaited<ReturnType<typeof tickFixture2733>>;
beforeEach(async () => { f = await tickFixture2733(); });
async function wire(query: string, variables: Record<string, unknown> = {}, ctx = f.context()) {
  const out = await server.executeOperation({ query, variables }, { contextValue: ctx });
  if (out.body.kind !== 'single') throw new Error('Expected one response');
  return out.body.singleResult;
}

it('stores the permanent code and never reuses a deleted ticker slug', async () => {
  const first = await f.ticker('Engineering');
  expect((await db.ticker.findUniqueOrThrow({ where: { id: first.id } })) as any).toMatchObject({ tickCode: 'tick.engineering' });
  await M.updateTicker({}, { ref: first.id, input: { name: 'Renamed' } }, f.context());
  expect((await db.ticker.findUniqueOrThrow({ where: { id: first.id } })) as any).toMatchObject({ slug: 'engineering', tickCode: 'tick.engineering' });
  await M.deleteTicker({}, { ref: first.id }, f.context());
  const again = await f.ticker('Engineering');
  expect(again).toMatchObject({ slug: 'engineering-2', tickCode: 'tick.engineering-2' });
});

it('exposes code and a readable register loc through the real schema', async () => {
  await f.entry('tick.engineering');
  const t = await f.ticker('Engineering');
  const out = await wire('query($ref: String!) { ticker(ref: $ref) { tickCode registerTaskLoc } }', { ref: t.id });
  expect(out.errors).toBeUndefined();
  expect(out.data?.ticker).toEqual({ tickCode: 'tick.engineering', registerTaskLoc: tickTaskLoc2733 });
});

it('files one fixed unmapped warning under the mutation alias after successful create', async () => {
  const out = await wire('mutation($app: String!) { a: createTicker(appRef: $app, input: { name: "Unknown", cadenceSeconds: 600 }) { id } }', { app: f.app.id });
  expect(out.errors).toBeUndefined();
  expect((out.data?.a as any)?.id).toBeTruthy();
  expect((out.extensions as any)?.warnings).toEqual([{
    path: 'a', code: 'ticker.code.unmapped',
    text: "No register entry you can read maps this ticker's code to a task, so its wakes will say no task is mapped.",
  }]);
});

it('keeps template codes on generated copies across rename and deletion', async () => {
  const template = await M.createAgentTickerTemplate({}, { agentRef: f.roleA.id, input: { name: 'Shared tick', cadenceSeconds: 600 } }, f.context());
  await M.castWorker({}, { appRef: f.app.id, agentRef: f.roleA.id, name: 'One' }, f.context());
  await M.castWorker({}, { appRef: f.app.id, agentRef: f.roleA.id, name: 'Two' }, f.context());
  const copies = await db.ticker.findMany({ where: { sourceTemplateId: template.id }, orderBy: { name: 'asc' } });
  expect(copies).toHaveLength(2);
  expect(new Set(copies.map(t => t.slug)).size).toBe(2);
  expect(copies.map(t => (t as any).tickCode)).toEqual(['tick.shared-tick', 'tick.shared-tick']);
  const changed = await M.updateAgentTickerTemplate({}, { id: template.id, expectedRevision: 1, input: { name: 'Next tick' } }, f.context());
  const out = await wire('query($agent: String!) { agentTickerTemplates(agentRef: $agent) { id tickCode } }', { agent: f.roleA.id });
  expect(out.errors).toBeUndefined();
  expect((out.data?.agentTickerTemplates as any[])[0].tickCode).toBe('tick.next-tick');
  await M.deleteAgentTickerTemplate({}, { id: template.id, expectedRevision: changed.revision }, f.context());
  expect((await db.ticker.findMany({ where: { sourceTemplateId: template.id } })).map(t => (t as any).tickCode)).toEqual(['tick.shared-tick', 'tick.shared-tick']);
});
