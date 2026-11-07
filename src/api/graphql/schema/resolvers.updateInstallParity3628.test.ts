/** #3628 item4, ruling0234: update install-door refusals after participant/manager gates. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { withInstallMemory } from './installMemory.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { taskWarningsPlugin } from '../taskWarningsPlugin.js';
import { includePinWarningsFor } from '../../../lib/includes/plainPinWarnings.js';
import { publishNodeWritten } from '../../../lib/events/nodeWritten.js';
vi.mock('../../../lib/events/nodeWritten.js', () => ({ publishNodeWritten: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
beforeEach(async () => { await cleanDb(db); vi.mocked(publishNodeWritten).mockClear(); });

async function fixture(kind: 'ROW' | 'DERIVED' | 'absent', licensed = true, customised = true) {
  const key = generateId().toLowerCase();
  const org = (name: string) => db.organization.create({ data: { name, urn: `${name}-${key}.example` } });
  const [holder, owner, importer] = await Promise.all([org('holder'), org('owner'), org('importer')]);
  const manager = await db.user.create({ data: { handle: `manager-${key}`, roles: ['READER'] } });
  const member = await db.user.create({ data: { handle: `member-${key}`, roles: ['READER'] } });
  const stranger = await db.user.create({ data: { handle: `stranger-${key}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: holder.id, userId: manager.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { organizationId: holder.id, name: 'Parity', urn: `${holder.urn}:app` } });
  await createDbAppMember(db, app.id, member.id, 'member');
  await createDbAppMember(db, app.id, manager.id, 'member');
  const target = await db.agent.create({ data: { organizationId: owner.id, name: 'Target', urn: `${owner.urn}:target` } });
  const parent = await db.agent.create({ data: { organizationId: importer.id, name: 'Parent', urn: `${importer.urn}:parent` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: parent.id } });
  await createDbAgentOrgGrant(db, importer.id, target.id);
  if (licensed) await createDbAgentOrgGrant(db, holder.id, target.id);
  if (kind === 'ROW') await db.appAgent.create({ data: { appId: app.id, agentId: target.id } });
  if (kind === 'DERIVED') await createDbAgentImport(db, parent.id, target.id);
  let memoryId: string | undefined;
  if (customised) {
    const memory = await db.memory.create({ data: { organizationId: holder.id, appId: app.id, installOfAgentId: target.id,
      isInstallMemory: true, class: 'system', name: 'Install', urn: `${holder.urn}:install` } });
    memoryId = memory.id;
    await db.node.create({ data: { memoryId, loc: 'source', name: 'Source', content: 'before' } });
  }
  const context = (who = manager.id): Context => ({ db, userId: who, roles: ['READER'] });
  const input = { install: { appRef: app.id, agentRef: target.id }, loc: 'source', content: 'after' };
  return { holder, owner, importer, manager, member, stranger, app, target, parent, memoryId, context, input };
}
async function snapshot() {
  return { memories: await db.memory.findMany({ orderBy: { id: 'asc' } }), nodes: await db.node.findMany({ orderBy: { id: 'asc' } }), revisions: await db.nodeRevision.findMany({ orderBy: { id: 'asc' } }) };
}
async function refuses(f: Awaited<ReturnType<typeof fixture>>, code: string, ctx = f.context()) {
  const before = await snapshot();
  const result = await M.updateNode(null, { input: f.input }, ctx).then(
    (value: unknown) => ({ value, code: null }),
    (error: any) => ({ code: error.extensions?.code ?? error.code }),
  );
  expect(result).toEqual({ code });
  expect(await snapshot()).toEqual(before);
}

it.each([false, true])('unlicensed derived refusal is AGENT_ORG_GRANT_REQUIRED, customised=%s', async customised => {
  await refuses(await fixture('DERIVED', false, customised), 'AGENT_ORG_GRANT_REQUIRED');
});
it.each([false, true])('absent installation refuses before retained memory lookup, customised=%s', async customised => {
  await refuses(await fixture('absent', true, customised), 'AGENT_NOT_INSTALLED');
});
it.each(['ROW', 'DERIVED'] as const)('%s licensed with no install memory keeps INSTALL_MEMORY_NOT_FOUND and creates nothing', async kind => {
  await refuses(await fixture(kind, true, false), 'INSTALL_MEMORY_NOT_FOUND');
});
it.each(['ROW', 'DERIVED'] as const)('%s licensed manager updates the existing node without creating another memory', async kind => {
  const f = await fixture(kind); const before = await db.memory.count();
  const answer = await M.updateNode(null, { input: f.input }, f.context());
  expect(answer.content).toBe('after');
  expect((await db.node.findFirstOrThrow({ where: { memoryId: f.memoryId, loc: 'source' } })).content).toBe('after');
  expect(await db.memory.count()).toBe(before);
});
for (const kind of ['DERIVED', 'absent'] as const) for (const customised of [false, true]) {
  it(`${kind} customised=${customised}: participant non-manager learns no install refusal`, async () => {
    const f = await fixture(kind, false, customised); await refuses(f, 'FORBIDDEN', f.context(f.member.id));
  });
  it(`${kind} customised=${customised}: stranger cannot distinguish target state`, async () => {
    const f = await fixture(kind, false, customised); await refuses(f, 'APP_NOT_FOUND', f.context(f.stranger.id));
  });
}
it('create:false is update-only: a missing loc creates no node, memory or revision', async () => {
  const f = await fixture('DERIVED'); f.input.loc = 'absent';
  await refuses(f, 'NODE_NOT_FOUND');
});
it('rechecks manager authority under the shared transaction before touching content', async () => {
  const f = await fixture('DERIVED');
  let crossed = false;
  const wrapped = new Proxy(db, { get(target, key) {
    if (key === '$transaction') return async (work: any, options: any) => {
      crossed = true;
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.holder.id, userId: f.manager.id } }, data: { role: 'READER' } });
      return target.$transaction(work, options);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await refuses(f, 'FORBIDDEN', { ...f.context(), db: wrapped });
  expect(crossed).toBe(true);
});

it('withInstallMemory create:false holds the owner-org anchor before any work callback', async () => {
  const f = await fixture('DERIVED');
  let entered = false;
  await withInstallMemory(f.context(), f.input.install, async (_tx, _ctx, memory) => {
    const rows = await db.$queryRaw<{ got: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('authorization:org'), hashtext(${f.holder.id})) AS got`;
    expect(rows[0]?.got).toBe(false);
    expect(memory.id).toBe(f.memoryId);
    entered = true;
  }, { create: false });
  expect(entered).toBe(true);
});
it.each(['app-key', 'run'] as const)('%s cannot reach typed install refusals or write through an update', async kind => {
  const f = await fixture('DERIVED', false, false);
  const ctx = kind === 'run' ? { ...f.context(), clientId: `run:${generateId()}`, appId: f.app.id }
    : { db, roles: [], appId: f.app.id, appKeyId: generateId() } as Context;
  await refuses(f, 'FORBIDDEN', ctx);
});
it('physical-row licence behavior remains unchanged on an already customised install', async () => {
  const f = await fixture('ROW', false);
  const answer = await M.updateNode(null, { input: f.input }, f.context());
  expect(answer.content).toBe('after');
});

it.each(['ROW', 'DERIVED'] as const)('%s install update publishes once after commit and refuses without publishing', async kind => {
  const f = await fixture(kind);
  let checked = false;
  const wrapped = new Proxy(db, { get(target, key) {
    if (key === '$transaction') return async (work: any, options: any) => target.$transaction(async tx => {
      const result = await work(tx);
      expect(publishNodeWritten).not.toHaveBeenCalled();
      checked = true;
      return result;
    }, options);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await M.updateNode(null, { input: f.input }, { ...f.context(), db: wrapped });
  expect(checked).toBe(true);
  expect(publishNodeWritten).toHaveBeenCalledTimes(1);
  expect(publishNodeWritten).toHaveBeenCalledWith(expect.objectContaining({ nodeId: result.id, memoryId: f.memoryId }));
  expect((await db.node.findUniqueOrThrow({ where: { id: result.id } })).content).toBe('after');
  vi.mocked(publishNodeWritten).mockClear();
  await refuses(f, 'FORBIDDEN', f.context(f.member.id));
  expect(publishNodeWritten).not.toHaveBeenCalled();
});

for (const kind of ['ROW', 'DERIVED'] as const) {
  it(`${kind} install update keeps warnings on the outer request for the MCP-facing lookup`, async () => {
    const f = await fixture(kind);
    await db.node.create({ data: { memoryId: f.memoryId!, loc: 'target', name: 'Target', content: 'target' } });
    const ctx = f.context();
    const result = await M.updateNode(null, { input: { ...f.input, content: '{{> target rev=1}}' } }, ctx);
    expect(await includePinWarningsFor(ctx, result)).toEqual([expect.objectContaining({ code: 'include.pin.unkept' })]);
  });
  it(`${kind} install update emits the Apollo warning at updateNode, with memoryId control`, async () => {
    const f = await fixture(kind);
    await db.node.create({ data: { memoryId: f.memoryId!, loc: 'target', name: 'Target', content: 'target' } });
    await db.node.create({ data: { memoryId: f.memoryId!, loc: 'control', name: 'Control', content: 'before' } });
    const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
    try {
      const execute = async (input: Record<string, unknown>) => {
        const result = await server.executeOperation({ query: 'mutation($i:UpdateNodeInput!){updateNode(input:$i){id}}', variables: { i: input } }, { contextValue: f.context() });
        if (result.body.kind !== 'single') throw new Error('unexpected response');
        expect(result.body.singleResult.errors).toBeUndefined();
        return result.body.singleResult.extensions?.warnings;
      };
      const text = '{{> target rev=1}}';
      expect(await execute({ memoryId: f.memoryId, loc: 'control', content: text })).toEqual([expect.objectContaining({ path: 'updateNode', code: 'include.pin.unkept' })]);
      // The control writes another node so it cannot pre-acknowledge this pin.
      expect(await execute({ ...f.input, content: 'install ' + text })).toEqual([expect.objectContaining({ path: 'updateNode', code: 'include.pin.unkept' })]);
    } finally { await server.stop(); }
  });
}
