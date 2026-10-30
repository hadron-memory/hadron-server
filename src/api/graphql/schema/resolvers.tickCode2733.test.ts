import { ApolloServer } from '@apollo/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RegisterLookup } from '../../../lib/actionRegister/lookup.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { generateId } from '../../../lib/id.js';
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
afterEach(() => vi.restoreAllMocks());
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

it('ticker reads create no wake or delivery bookkeeping', async () => {
  await f.entry('tick.engineering');
  const t = await f.ticker('Engineering');
  const counts = () => Promise.all([db.appWakeReservation.count(), db.appWakeDay.count(), db.workerDeliveryTick.count(), db.workerDeliveryChannel.count()]);
  const before = await counts();
  const out = await wire('query($app: String!) { tickers(appRef: $app) { tickCode registerTaskLoc } }', { app: f.app.id });
  expect(out.errors).toBeUndefined();
  expect(out.data?.tickers).toEqual([{ tickCode: t.tickCode, registerTaskLoc: tickTaskLoc2733 }]);
  expect(await counts()).toEqual(before);
});

it('reads an entry loc without resolving a role task and returns null on lookup failure', async () => {
  await f.entry('tick.engineering');
  const t = await f.ticker('Engineering');
  const query = 'query($ref: String!) { ticker(ref: $ref) { tickCode registerTaskLoc } }';
  expect((await wire(query, { ref: t.id })).data?.ticker).toEqual({ tickCode: 'tick.engineering', registerTaskLoc: tickTaskLoc2733 });
  vi.spyOn(RegisterLookup.prototype, 'entry').mockRejectedValue(new Error('injected read failure'));
  const failed = await wire(query, { ref: t.id });
  expect(failed.errors).toBeUndefined();
  expect(failed.data?.ticker).toEqual({ tickCode: 'tick.engineering', registerTaskLoc: null });
});

it('does not warn for a readable entry, including a worker held by a plain App member (#2233)', async () => {
  await f.entry('tick.engineering');
  const w = await f.worker('Alpha');
  const c = f.context(f.member.id);
  await runAsActor({ workerId: w.id, agentId: f.roleA.id }, () => f.ticker('Engineering', {}, c));
  expect(c.taskWarnings ?? []).toEqual([]);
});

it.each(['zero', 'two'])('warns when there are %s Team Agents', async mode => {
  if (mode === 'zero') await db.node.deleteMany({ where: { memoryId: f.team.systemMemoryId, loc: 'roles' } });
  else await f.node(f.roleB.systemMemoryId, 'roles');
  const out = await wire('mutation($app: String!) { createTicker(appRef: $app, input: { name: "Unknown", cadenceSeconds: 600 }) { tickCode } }', { app: f.app.id });
  expect(out.errors).toBeUndefined();
  expect((out.extensions as any)?.warnings?.map((w: any) => w.code)).toEqual(['ticker.code.unmapped']);
});

it('files no warning on a refused create or any update', async () => {
  const t = await f.ticker('Engineering');
  const refused = await wire('mutation($app: String!) { createTicker(appRef: $app, input: { name: "Engineering", cadenceSeconds: 600 }) { id } }', { app: f.app.id });
  expect(refused.errors?.[0].extensions?.code).toBe('TICKER_NAME_TAKEN');
  expect((refused.extensions as any)?.warnings).toBeUndefined();
  const update = await wire('mutation($ref: String!) { updateTicker(ref: $ref, input: { name: "Next" }) { tickCode } }', { ref: t.id });
  expect(update.errors).toBeUndefined();
  expect((update.extensions as any)?.warnings).toBeUndefined();
});

it('fails open without an unmapped warning when the post-commit lookup throws', async () => {
  vi.spyOn(RegisterLookup.prototype, 'entry').mockRejectedValue(new Error('injected failure'));
  const out = await wire('mutation($app: String!) { createTicker(appRef: $app, input: { name: "Unknown", cadenceSeconds: 600 }) { tickCode } }', { app: f.app.id });
  expect(out.errors).toBeUndefined();
  expect(out.data?.createTicker).toEqual({ tickCode: 'tick.unknown' });
  expect((out.extensions as any)?.warnings).toBeUndefined();
  expect(await db.ticker.count({ where: { appId: f.app.id } })).toBe(1);
});

it('enriches the new warning through the caller Agent without recording a task event', async () => {
  await f.entry('ticker.code.unmapped');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const w = await f.worker('Alpha');
  const c = f.context(f.member.id);
  await runAsActor({ workerId: w.id, agentId: f.roleA.id }, () => f.ticker('Unknown', {}, c));
  expect(c.taskWarnings?.[0].warning).toMatchObject({ code: 'ticker.code.unmapped', register: { state: 'mapped', taskLoc: tickTaskLoc2733, taskUrn: 'hrn:node:' + f.roleA.memory.urn + ':' + tickTaskLoc2733 } });
  expect(c.taskWarningHistory ?? []).toEqual([]);
});

it('App-key routers see only readable guidance through the real schema', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const w = await f.worker('Alpha');
  const teamWorker = await f.worker('Beta', f.team.id);
  await f.node(f.team.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const t = await f.ticker('Shared');
  await db.ticker.update({ where: { id: t.id }, data: { anchorAt: new Date(Date.now() - 600_000) } });
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: teamWorker.id } });
  const key = await db.appKey.create({ data: { appId: f.app.id, label: 'Router', keyHash: 'synthetic2733', keyPreview: 'test' } });
  await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'attention:deliver', grantedByUserId: f.admin.id } });
  const c = { db, roles: [], appId: f.app.id, appKeyId: key.id } as Context;
  const query = 'query($app: String!) { dueWakes(appRef: $app) { wakes { worker { id } tickText reasons { kind action { code state taskLoc taskUrn } ticker { tickCode } } } } }';
  const readable = await wire(query, { app: f.app.id }, c);
  expect(readable.errors).toBeUndefined();
  const readableWakes = (readable.data?.dueWakes as any).wakes;
  expect(readableWakes.find((x: any) => x.worker.id === w.id).reasons[0].action.state).toBe('WITHHELD');
  expect(readableWakes.find((x: any) => x.worker.id === teamWorker.id).reasons[0].action.state).toBe('MAPPED');
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.team.id } } });
  const denied = await wire(query, { app: f.app.id }, { ...c });
  expect(denied.errors).toBeUndefined();
  for (const wake of (denied.data?.dueWakes as any).wakes) expect(wake.reasons[0].action).toEqual({ code: 'tick.shared', state: 'WITHHELD', taskLoc: null, taskUrn: null });
  expect(JSON.stringify(denied)).not.toContain(tickTaskLoc2733);
  expect(JSON.stringify(denied)).not.toContain(f.roleA.memory.urn);
});
