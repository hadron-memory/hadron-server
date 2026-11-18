/** #3292: authority defaults fail closed without a user; candidate inventory remains explicit. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { canReadMemory, canWriteToMemory, getAppMemoryAccess, getAppMemoryCandidates, getPrincipalAppMemoryAccess } from '../../../mcp/access-control.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const mutations = resolvers.Mutation as any;
let fixture: Awaited<ReturnType<typeof seed>>;

async function seed() {
  const root = `credential-${generateId().toLowerCase()}.example`;
  const org = await db.organization.create({ data: { name: 'Credential default', urn: root } });
  const user = await db.user.create({ data: { handle: `owner-${generateId().toLowerCase()}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const userContext = { db, userId: user.id, roles: ['READER'] } as Context;
  const agent = await mutations.createAgent({}, { orgId: org.id, name: 'Credential Agent' }, userContext);
  const { app } = await createDbAppWithKey(db, 'credential-default', org.id);
  await createDbAppAgent(db, app.id, agent.id);
  const memory = async (name: string, visibility: 'ORGANIZATION' | 'PUBLIC') => db.memory.create({
    data: { name, urn: `${root}:${name}`, organizationId: org.id, class: 'knowledge', visibility },
  });
  const knowledge = await memory('knowledge', 'ORGANIZATION');
  const publicMemory = await memory('public', 'PUBLIC');
  const unlinkedPublic = await memory('unlinked-public', 'PUBLIC');
  for (const target of [knowledge, publicMemory]) await db.agentMemoryItem.create({
    data: { agentId: agent.id, memoryId: target.id, role: 'read-write' },
  });
  const team = await db.memory.create({ data: { name: 'team', urn: `${root}:team`, organizationId: org.id, appId: app.id, class: 'app' } });
  const nodes = [
    { loc: 'conversations', name: 'conversations' },
    { loc: 'conversations:research', name: 'research', data: { stageOrder: ['scope'], isSetup: false } },
    { loc: 'conversations:research:scope', name: 'scope', data: { promptRef: 'prompts:research:scope' } },
    { loc: 'prompts', name: 'prompts' },
    { loc: 'prompts:research', name: 'research' },
    { loc: 'prompts:research:scope', name: 'scope', content: 'Scope the research.' },
  ];
  for (const node of nodes) await db.node.create({ data: {
    memoryId: agent.systemMemoryId, loc: node.loc, name: node.name, nodeType: 'system',
    data: ((node as { data?: object }).data ?? null) as never, content: (node as { content?: string }).content ?? null,
  } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const run = runAuthContext({ id: generateId(), appId: app.id, userId: null, organizationId: org.id });
  return { org, user, agent, app, knowledge, publicMemory, unlinkedPublic, team, userContext, run };
}
beforeEach(async () => { await cleanDb(db); fixture = await seed(); });

describe('#3292 direct authority API defaults', () => {
  it.each(['omitted', 'empty options', 'null user'] as const)('%s cannot gain org knowledge from an item', async shape => {
    const opts = shape === 'omitted' ? undefined : shape === 'null user' ? { callerUserId: null } : {};
    expect((await getAppMemoryAccess(db, fixture.app.id, opts)).has(fixture.knowledge.id)).toBe(false);
  });
  it('keeps item-linked PUBLIC read-only when the userless caller omits credentialOnly', async () => {
    expect((await getAppMemoryAccess(db, fixture.app.id)).get(fixture.publicMemory.id)).toBe('READ_ONLY');
  });
  it('keeps independent installed-system and own App-class paths', async () => {
    const access = await getAppMemoryAccess(db, fixture.app.id);
    expect(access.get(fixture.agent.systemMemoryId)).toBe('READ_ONLY');
    expect(access.get(fixture.team.id)).toBe('READ_ONLY');
  });
  it('candidate inventory remains explicit and does not pretend to be caller authority', async () => {
    const candidates = await getAppMemoryCandidates(db, fixture.app.id);
    expect(candidates.get(fixture.knowledge.id)).toBe('READ_WRITE');
    expect(candidates.get(fixture.publicMemory.id)).toBe('READ_WRITE');
    expect(candidates.get(fixture.agent.systemMemoryId)).toBe('READ_ONLY');
  });
  it('keeps known-user independent writes', async () => {
    const access = await getAppMemoryAccess(db, fixture.app.id, { callerUserId: fixture.user.id });
    expect(access.get(fixture.knowledge.id)).toBe('READ_WRITE');
    expect(access.get(fixture.publicMemory.id)).toBe('READ_WRITE');
  });
  it.each(['key', 'run'] as const)('CONTROL: existing %s principal keeps PUBLIC point reads and refuses item-only knowledge/write', async shape => {
    const principal = shape === 'key' ? { appId: fixture.app.id, roles: [] } : fixture.run;
    expect((await getPrincipalAppMemoryAccess(db, principal)).has(fixture.knowledge.id)).toBe(false);
    expect(await canReadMemory(db, principal, fixture.knowledge.id)).toBe(false);
    expect(await canReadMemory(db, principal, fixture.unlinkedPublic.id)).toBe(true);
    expect(await canWriteToMemory(db, principal, fixture.publicMemory.id)).toBe(false);
  });
});

describe('#3292 legacy chat item target (direct hypothetical context, not run transport)', () => {
  it.each(['key', 'run'] as const)('a userless %s cannot select a chat write target through an item', async shape => {
    const principal = shape === 'key' ? { appId: fixture.app.id, roles: [] } : fixture.run;
    const ctx = { db, ...principal } as Context;
    const before = await db.node.count({ where: { memoryId: fixture.knowledge.id } });
    await expect(mutations.startChat({}, { agentId: fixture.agent.id }, ctx)).rejects.toThrow('No target memory available for this chat');
    expect(await db.node.count({ where: { memoryId: fixture.knowledge.id } })).toBe(before);
    expect(await db.agentSubscription.count({ where: { agentId: fixture.agent.id } })).toBe(0);
  });
  it('CONTROL: an ordinary user still starts a private chat outside item-only knowledge', async () => {
    const out = await mutations.startChat({}, { agentId: fixture.agent.id }, fixture.userContext);
    expect(out.chatId).toMatch(/^chats:/);
    const chat = await db.node.findFirstOrThrow({ where: { loc: out.chatId, memoryId: out.memoryId } });
    expect(chat.memoryId).not.toBe(fixture.knowledge.id);
    expect(await db.agentSubscription.count({ where: { agentId: fixture.agent.id, userId: fixture.user.id } })).toBe(1);
  });
});
