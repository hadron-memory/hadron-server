/**
 * #3651 (cor:dmo:150:07): `createNode(install:)` and `hadron_create_node` with `install` owe the writer the
 * `include.pin.unkept` warning on the OUTER request, like the memoryId write path and install update.
 * The install-create writer runs in a held transaction whose context is a copy of the request's; response-only
 * warnings are keyed by the exact request Context, so the create door must hand the outer one through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { taskWarningsPlugin } from '../taskWarningsPlugin.js';
import { includePinWarningsFor } from '../../../lib/includes/plainPinWarnings.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
beforeEach(async () => { await cleanDb(db); });

const PIN = '{{> target rev=1}}';

async function fixture(customised: boolean) {
  const key = generateId().toLowerCase();
  const org = (name: string) => db.organization.create({ data: { name, urn: `${name}-${key}.example` } });
  const [holder, owner] = await Promise.all([org('holder'), org('owner')]);
  const manager = await db.user.create({ data: { handle: `manager-${key}`, roles: ['READER'] } });
  const member = await db.user.create({ data: { handle: `member-${key}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: holder.id, userId: manager.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { organizationId: holder.id, name: 'Create', urn: `${holder.urn}:app` } });
  await createDbAppMember(db, app.id, member.id, 'member');
  await createDbAppMember(db, app.id, manager.id, 'member');
  const target = await db.agent.create({ data: { organizationId: owner.id, name: 'Target', urn: `${owner.urn}:target` } });
  await createDbAgentOrgGrant(db, holder.id, target.id);
  await db.appAgent.create({ data: { appId: app.id, agentId: target.id } });
  let memoryId: string | undefined;
  if (customised) {
    const memory = await db.memory.create({ data: { organizationId: holder.id, appId: app.id, installOfAgentId: target.id,
      isInstallMemory: true, class: 'system', name: 'Install', urn: `${holder.urn}:install` } });
    memoryId = memory.id;
    // The pin's target and the control's target live in the install memory; 'source' is what the update control rewrites.
    await db.node.create({ data: { memoryId, loc: 'target', name: 'Target', content: 'target' } });
    await db.node.create({ data: { memoryId, loc: 'source', name: 'Source', content: 'before' } });
    await db.node.create({ data: { memoryId, loc: 'control-target', name: 'Control', content: 'control' } });
  }
  const context = (who = manager.id): Context => ({ db, userId: who, roles: ['READER'] });
  const install = { appRef: app.id, agentRef: target.id };
  return { holder, manager, member, app, target, memoryId, context, install };
}
const nodeCount = () => db.node.count();
async function gql(ctx: Context, query: string, variables: Record<string, unknown>) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
  try {
    const result = await server.executeOperation({ query, variables }, { contextValue: ctx });
    if (result.body.kind !== 'single') throw new Error('unexpected response');
    return result.body.singleResult;
  } finally { await server.stop(); }
}
const CREATE = 'mutation($i:CreateNodeInput!){createNode(input:$i){id}}';
const UPDATE = 'mutation($i:UpdateNodeInput!){updateNode(input:$i){id}}';
const unkept = (path: string) => [expect.objectContaining({ path, code: 'include.pin.unkept' })];

describe('#3651 createNode(install:) delivers include.pin.unkept on the outer request', () => {
  for (const customised of [true, false]) {
    it(`customised=${customised}: the MCP-facing lookup under the outer context finds the warning`, async () => {
      const f = await fixture(customised);
      const ctx = f.context();
      // First customisation creates the install memory; the pinned target must exist in it first, so create it plainly.
      if (!customised) await M.createNode(null, { input: { install: f.install, loc: 'target', name: 'Target', content: 'target' } }, f.context());
      const result = await M.createNode(null, { input: { install: f.install, loc: 'made', name: 'Made', content: PIN } }, ctx);
      expect(await includePinWarningsFor(ctx, result)).toEqual([expect.objectContaining({ code: 'include.pin.unkept' })]);
    });
  }

  it('Apollo emits the warning at createNode for the install target, with memoryId-create and install-update controls', async () => {
    const f = await fixture(true);
    const created = await gql(f.context(), CREATE, { i: { install: f.install, loc: 'made', name: 'Made', content: PIN } });
    expect(created.errors).toBeUndefined();
    expect(created.extensions?.warnings).toEqual(unkept('createNode'));
    // Controls keep working: ordinary memoryId create, and install update.
    const control = await gql(f.context(), CREATE, { i: { memoryId: f.memoryId, loc: 'control', name: 'C', content: '{{> control-target rev=1}}' } });
    expect(control.errors).toBeUndefined();
    expect(control.extensions?.warnings).toEqual(unkept('createNode'));
    const updated = await gql(f.context(), UPDATE, { i: { install: f.install, loc: 'source', content: 'again ' + PIN } });
    expect(updated.errors).toBeUndefined();
    expect(updated.extensions?.warnings).toEqual(unkept('updateNode'));
  });

  it('a create with no pin carries no warning, and the write is committed either way', async () => {
    const f = await fixture(true);
    const before = await nodeCount();
    const plain = await gql(f.context(), CREATE, { i: { install: f.install, loc: 'plain', name: 'P', content: 'no pin' } });
    expect(plain.errors).toBeUndefined();
    expect(plain.extensions?.warnings ?? []).toEqual([]);
    const pinned = await gql(f.context(), CREATE, { i: { install: f.install, loc: 'pinned', name: 'Q', content: PIN } });
    expect(pinned.errors).toBeUndefined();
    expect(await nodeCount()).toBe(before + 2);
    expect((await db.node.findFirstOrThrow({ where: { memoryId: f.memoryId, loc: 'pinned' } })).content).toBe(PIN);
  });

  it('a refused create (non-manager) carries no warning and writes nothing', async () => {
    const f = await fixture(true);
    const before = await nodeCount();
    const refused = await gql(f.context(f.member.id), CREATE, { i: { install: f.install, loc: 'nope', name: 'N', content: PIN } });
    expect(refused.errors?.length).toBe(1);
    expect(refused.extensions?.warnings ?? []).toEqual([]);
    expect(await nodeCount()).toBe(before);
  });
});

describe('#3651 hadron_create_node with install renders the warning', () => {
  const mcpAuth = (userId: string, organizationId: string) => ({ userId, organizationId, roles: [], clientId: `user:${userId}` }) as AuthContext;
  it('install create text carries Warning [include.pin.unkept]; the plain-memory create and a no-pin create do not regress', async () => {
    const f = await fixture(true);
    const install = { app: f.app.id, agent: f.target.id };
    const s = createTestableMcpServer(mcpAuth(f.manager.id, f.holder.id));
    const pinned = await s.callToolText('hadron_create_node', { urn: 'made', name: 'Made', content: PIN, install });
    expect(pinned).toContain('Node created in the App\'s install memory');
    expect(pinned).toContain('Warning [include.pin.unkept]');
    const plain = await createTestableMcpServer(mcpAuth(f.manager.id, f.holder.id))
      .callToolText('hadron_create_node', { urn: 'plain', name: 'Plain', content: 'no pin', install });
    expect(plain).toContain('Node created in the App\'s install memory');
    expect(plain).not.toContain('Warning [');
    const update = await createTestableMcpServer(mcpAuth(f.manager.id, f.holder.id))
      .callToolText('hadron_update_node', { urn: 'source', content: 'again ' + PIN, install });
    expect(update).toContain('Warning [include.pin.unkept]');
  });
});
