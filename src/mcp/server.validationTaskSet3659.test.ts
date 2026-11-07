/**
 * #3659 (cor:dmo:160:01, ruling 0199): hadron_get_node and hadron_get_nodes print
 * Node.validationTasks as one line, from the same computation as the GraphQL field and with the
 * recorder's context. The rules themselves are pinned in resolvers.validationTaskSet3659.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let orgId: string;
let leo: string;
let ann: string;
let memoryId: string;
let configId: string;
let v: string;
const NODE = 'hrn:node:vtm-org:mem:doc';
const V_URN = 'hrn:node:vtm-org:mem:validate-v';

const as = (userId: string, extra: Partial<AuthContext> = {}) => createTestableMcpServer(
  { roles: ['READER'], organizationId: orgId, userId, clientId: `user:${userId}`, ...extra } as AuthContext,
  { sessionId: `vt-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } },
);
const lineOf = (text: string) => text.split('\n').find((l) => l.startsWith('Validation tasks:')) ?? null;
const both = async (server: ReturnType<typeof as>, ref = NODE) => ({
  single: lineOf(await server.callToolText('hadron_get_node', { urn: ref })),
  batch: lineOf(await server.callToolText('hadron_get_nodes', { refs: [ref] })),
});
const onBoth = (line: string | null) => ({ single: line, batch: line });

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'vtm-org', urn: 'vtm-org' } })).id;
  const mk = async (handle: string, role: 'CONTRIBUTOR' | 'READER') => {
    const u = await db.user.create({ data: { handle } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
    return u.id;
  };
  leo = await mk('vtm-leo', 'CONTRIBUTOR');
  ann = await mk('vtm-ann', 'READER');
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'vtm-org:mem', name: 'mem', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  v = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'validate-v', name: 'V', isRunnable: true, content: 'check', revSeq: 5 } })).id;
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', validationTaskId: v, validationTaskRequired: true } });
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'doc', name: 'Doc', content: 'body', role: 'guide' } });
});

describe('#3659 k. the read line, the same on both tools', () => {
  it('a writer reads the task and its revision', async () => {
    expect(await both(as(leo))).toEqual(onBoth(`Validation tasks: ${V_URN} @ revision 5`));
  });

  it('no rule, a broken rule, and a reader who is not a writer', async () => {
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'plain', name: 'P', content: 'x' } });
    expect(await both(as(leo), 'hrn:node:vtm-org:mem:plain')).toEqual(onBoth('Validation tasks: none configured'));
    expect(await both(as(ann))).toEqual(onBoth('Validation tasks: unavailable'));
    await db.node.update({ where: { id: v }, data: { isRunnable: false } });
    expect(await both(as(leo))).toEqual(onBoth('Validation tasks: broken'));
  });

  it('ruling 0199: a task in a memory the writer cannot read reads unavailable and is not named', async () => {
    const hiddenOrg = (await db.organization.create({ data: { id: generateId(), name: 'vtm-hidden', urn: 'vtm-hidden' } })).id;
    const hidden = (await db.memory.create({ data: { id: generateId(), organizationId: hiddenOrg, urn: 'vtm-hidden:tasks', name: 't', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
    const task = (await db.node.create({ data: { id: generateId(), memoryId: hidden, loc: 'hidden-validate', name: 'H', isRunnable: true, content: 'x' } })).id;
    await db.nodeRoleRule.updateMany({ where: { configId }, data: { validationTaskId: task } });
    const text = await as(leo).callToolText('hadron_get_node', { urn: NODE });
    expect(lineOf(text)).toBe('Validation tasks: unavailable');
    expect(text).not.toContain('hidden-validate');
    expect(text).not.toContain(task);
  });

  it('impersonation never records, so it reads unavailable: the line uses the recorder\'s context', async () => {
    expect(await both(as(leo, { impersonation: { orgId } } as Partial<AuthContext>))).toEqual(onBoth('Validation tasks: unavailable'));
  });

  it('h. a session-bound App key lists a task in named PUBLIC knowledge, as the recorder accepts it', async () => {
    const { app, appKey } = await createDbAppWithKey(db, 'vtm-app', orgId);
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'vtm-agent', urn: 'vtm-org:vtm-agent' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const scratch = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'vtm-org:scratch', name: 's', class: 'app', appId: app.id, userMemoryOfAgentId: agent.id, visibility: null } })).id;
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, memoryId: scratch } });
    const pub = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'vtm-org:pub', name: 'p', class: 'knowledge', visibility: 'PUBLIC' } })).id;
    const task = (await db.node.create({ data: { id: generateId(), memoryId: pub, loc: 'pub-validate', name: 'P', isRunnable: true, content: 'x' } })).id;
    const config = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: scratch } })).id;
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config, role: 'guide', validationTaskId: task, validationTaskRequired: true } });
    await db.node.create({ data: { id: generateId(), memoryId: scratch, loc: 'doc', name: 'Doc', content: 'body', role: 'guide' } });
    const server = createTestableMcpServer(
      { roles: [], appId: app.id, appKeyId: appKey.id, sessionId: session.id, clientId: `app:${app.id}` } as unknown as AuthContext,
      { sessionId: `vt-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } },
    );
    expect(lineOf(await server.callToolText('hadron_get_node', { urn: 'hrn:node:vtm-org:scratch:doc' })))
      .toBe('Validation tasks: hrn:node:vtm-org:pub:pub-validate @ revision 1');
  });

  it('an inherited read prints no line, for a caller who could read the base too', async () => {
    const memory = async (slug: string) => (await db.memory.create({ data: { class: 'system', organizationId: orgId, name: slug, urn: `vtm-org:${slug}` } })).id;
    const baseMem = await memory('base-system');
    const childMem = await memory('child-system');
    const base = await db.agent.create({ data: { organizationId: orgId, name: 'base', urn: 'vtm-org:base', visibility: 'ORGANIZATION', systemMemoryId: baseMem } });
    await db.agent.create({ data: { organizationId: orgId, name: 'child', urn: 'vtm-org:child', visibility: 'ORGANIZATION', systemMemoryId: childMem, extendsAgentId: base.id } });
    await db.node.create({ data: { memoryId: baseMem, loc: 'guide-node', name: 'G', content: 'x' } });
    const admin = (await db.user.create({ data: { handle: 'vtm-admin', roles: ['ADMIN'] } })).id;
    const server = createTestableMcpServer({ userId: admin, roles: ['ADMIN'], clientId: `user:${admin}` } as AuthContext);
    const ref = 'hrn:node:vtm-org:child-system:guide-node';
    const text = await server.callToolText('hadron_get_node', { urn: ref });
    expect(text).toContain('Inherited from:');
    expect(lineOf(text)).toBeNull();
    expect(lineOf(await server.callToolText('hadron_get_nodes', { refs: [ref] }))).toBeNull();
    // Control: the same node read directly does get a line.
    expect(lineOf(await server.callToolText('hadron_get_node', { urn: 'hrn:node:vtm-org:base-system:guide-node' }))).not.toBeNull();
  });
});
