/**
 * #2701 — the two generic MERGE doors, `updateNodeData` and `updateNodeProperties`, on an App's install memory
 * (#2044). Their pre-gate ran on the pooled client, where an install memory's write answer is "no" unless the door
 * says it rechecks in its own fenced transaction; the manager of a live App was refused. The audience itself is
 * unchanged: only a manager of a live, attached App merges.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'md-org', urn: 'md-org' } })).id;
});

const ctxOf = (userId: string) => ({ db, userId, roles: [], clientId: `user:${userId}` }) as unknown as Context;

async function fixture() {
  const user = async (name: string) => db.user.create({ data: { id: generateId(), name } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Team Agent', urn: `${orgId}:team-agent`, organizationId: orgId } });
  const { app } = await createDbAppWithKey(db, 'md-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  const admin = await user('admin'); await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const member = await user('member'); await createDbAppMember(db, app.id, member.id, 'member');
  const stranger = await user('stranger');
  const node = await M.createNode({}, { input: { install: { appRef: app.id, agentRef: agent.id }, loc: 'prompts:lane', name: 'Lane', content: 'x', data: { a: 1 }, properties: { p: 1 } } }, ctxOf(admin.id));
  const row = () => db.node.findUniqueOrThrow({ where: { id: node.id } });
  return { agent, app, admin, member, stranger, node, row };
}

const DOORS: Array<[string, (f: Awaited<ReturnType<typeof fixture>>, userId: string) => Promise<unknown>, (r: any) => unknown]> = [
  ['updateNodeData', (f, u) => M.updateNodeData({}, { nodeRef: f.node.id, data: { b: 2 } }, ctxOf(u)), (r) => r.data],
  ['updateNodeProperties', (f, u) => M.updateNodeProperties({}, { nodeRef: f.node.id, properties: { q: 2 } }, ctxOf(u)), (r) => r.properties],
];

describe.each(DOORS)('#2701 %s on an install memory', (_name, call, field) => {
  it('merges for the manager of a live App', async () => {
    const f = await fixture();
    await call(f, f.admin.id);
    expect(field(await f.row())).toMatchObject(_name === 'updateNodeData' ? { a: 1, b: 2 } : { p: 1, q: 2 });
  });

  it('refuses a participant who is not a manager, and changes nothing', async () => {
    const f = await fixture();
    await expect(call(f, f.member.id)).rejects.toThrow(/Forbidden/);
    expect(field(await f.row())).toMatchObject(_name === 'updateNodeData' ? { a: 1 } : { p: 1 });
    expect(field(await f.row())).not.toHaveProperty(_name === 'updateNodeData' ? 'b' : 'q');
  });

  it('answers an outsider as a missing node, byte-identical to a node that does not exist', async () => {
    const f = await fixture();
    await expect(call(f, f.stranger.id)).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    expect(field(await f.row())).not.toHaveProperty(_name === 'updateNodeData' ? 'b' : 'q');
  });

  it('refuses the manager of a DETACHED install memory (Agent erased)', async () => {
    const f = await fixture();
    await db.memory.updateMany({ where: { appId: f.app.id, installOfAgentId: f.agent.id }, data: { installOfAgentId: null } });
    await expect(call(f, f.admin.id)).rejects.toThrow();
    expect(field(await f.row())).not.toHaveProperty(_name === 'updateNodeData' ? 'b' : 'q');
  });

  it('refuses the manager once the App is DELETED', async () => {
    const f = await fixture();
    await M.deleteApp({}, { ref: f.app.id }, ctxOf(f.admin.id));
    await expect(call(f, f.admin.id)).rejects.toThrow();
    expect(field(await f.row())).not.toHaveProperty(_name === 'updateNodeData' ? 'b' : 'q');
  });
});
