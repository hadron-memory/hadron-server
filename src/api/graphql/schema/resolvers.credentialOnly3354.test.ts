/** #3354: credentialOnly override contract, authority-vs-candidate fence, userless startChat query skip. */
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
  const agent = await mutations.createAgent({}, { orgRef: org.id, name: 'Credential Agent' }, userContext);
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


describe('#3354 item 1: the trusted explicit credentialOnly override is documented and pinned', () => {
  it('explicit credentialOnly:false without a user keeps the uncapped internal fold (the documented shape)', async () => {
    const access = await getAppMemoryAccess(db, fixture.app.id, { credentialOnly: false });
    expect(access.get(fixture.knowledge.id)).toBe('READ_WRITE');
    expect(access.get(fixture.publicMemory.id)).toBe('READ_WRITE');
  });
  it('explicit credentialOnly:true with a user still drops item authority', async () => {
    const access = await getAppMemoryAccess(db, fixture.app.id, { callerUserId: fixture.user.id, credentialOnly: true });
    expect(access.has(fixture.knowledge.id)).toBe(false);
    expect(access.get(fixture.publicMemory.id)).toBe('READ_ONLY');
  });
  it.each(['key', 'run'] as const)('production principal path never reaches the override: userless %s stays credential-only', async shape => {
    const principal = shape === 'key' ? { appId: fixture.app.id, roles: [] } : fixture.run;
    expect((await getPrincipalAppMemoryAccess(db, principal)).has(fixture.knowledge.id)).toBe(false);
  });
});

describe('#3354 item 2: authority and candidate entry points share one lifecycle and role fence', () => {
  type Mutate = () => Promise<void>;
  const cases: Array<[string, () => Mutate, boolean]> = [
    ['live baseline', () => async () => {}, true],
    ['soft-deleted App', () => async () => { await db.app.update({ where: { id: fixture.app.id }, data: { deletedAt: new Date() } }); }, false],
    ['uninstalled App', () => async () => { await db.app.update({ where: { id: fixture.app.id }, data: { uninstalledAt: new Date() } }); }, false],
    ['soft-deleted Agent', () => async () => { await db.agent.update({ where: { id: fixture.agent.id }, data: { deletedAt: new Date() } }); }, false],
    ['soft-deleted organization', () => async () => { await db.organization.update({ where: { id: fixture.org.id }, data: { deletedAt: new Date() } }); }, false],
  ];
  it.each(cases)('%s: both entry points agree on whether the system memory is reachable', async (_name, mk, reachable) => {
    await mk()();
    const authority = await getAppMemoryAccess(db, fixture.app.id, { callerUserId: fixture.user.id });
    const candidates = await getAppMemoryCandidates(db, fixture.app.id, { callerUserId: fixture.user.id });
    expect(authority.has(fixture.agent.systemMemoryId)).toBe(reachable);
    expect(candidates.has(fixture.agent.systemMemoryId)).toBe(reachable);
    expect([...authority.keys()].sort()).toEqual([...candidates.keys()].sort().filter(id => authority.has(id)));
    if (!reachable) { expect(authority.has(fixture.knowledge.id)).toBe(false); expect(candidates.has(fixture.knowledge.id)).toBe(false); }
  });
  it('a malformed item role grants nothing at either entry point, and a valid sibling is unaffected', async () => {
    const bogus = await db.memory.create({ data: { name: 'bogus', urn: `${fixture.org.urn}:bogus`, organizationId: fixture.org.id, class: 'knowledge', visibility: 'ORGANIZATION' } });
    await db.agentMemoryItem.create({ data: { agentId: fixture.agent.id, memoryId: bogus.id, role: 'bogus' } });
    for (const map of [
      await getAppMemoryAccess(db, fixture.app.id, { callerUserId: fixture.user.id }),
      await getAppMemoryCandidates(db, fixture.app.id, { callerUserId: fixture.user.id }),
    ]) {
      expect(map.has(bogus.id)).toBe(false);
      expect(map.get(fixture.knowledge.id)).toBe('READ_WRITE');
    }
  });
  it('the authority entry point is never wider than the candidate inventory for the same user', async () => {
    const authority = await getAppMemoryAccess(db, fixture.app.id, { callerUserId: fixture.user.id });
    const candidates = await getAppMemoryCandidates(db, fixture.app.id, { callerUserId: fixture.user.id });
    for (const [id, level] of authority) {
      expect(candidates.has(id)).toBe(true);
      if (level === 'READ_WRITE') expect(candidates.get(id)).toBe('READ_WRITE');
    }
  });
});

describe('#3354 item 3: a userless startChat skips the writable-item lookup and still refuses', () => {
  it.each(['key', 'run'] as const)('userless %s: no agentMemoryItem lookup, same refusal, no write', async shape => {
    const principal = shape === 'key' ? { appId: fixture.app.id, roles: [] } : fixture.run;
    const ctx = { db, ...principal } as Context;
    const spy = vi.spyOn(db.agentMemoryItem, 'findMany');
    try {
      await expect(mutations.startChat({}, { agentRef: fixture.agent.id }, ctx)).rejects.toThrow('No target memory available for this chat');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(await db.agentSubscription.count({ where: { agentId: fixture.agent.id } })).toBe(0);
  });
  it('CONTROL: an ordinary user still starts a chat (the lookup is not removed for users)', async () => {
    const out = await mutations.startChat({}, { agentRef: fixture.agent.id }, fixture.userContext);
    expect(out.chatId).toMatch(/^chats:/);
  });
});
