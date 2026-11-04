/** #3238: the manager compile door vs the same principal's direct node read.
 * cor:dmo:050:13 permits compilation by an Agent manager. #1734 is the named,
 * temporary exception to direct-read parity for a platform admin on a user-owned Agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { compileBootPromptMutations } from './resolvers.mutation.compileBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const ctx = (userId: string, roles: Context['roles'] = []): Context => ({ db, userId, roles, clientId: `user:${userId}` });
const direct = (id: string, caller: Context) => resolvers.Query.node({}, { ref: id, raw: true }, caller);
// Isolate the returned node: pointer validation has its own read gate and is outside this row.
const compile = (id: string, caller: Context) => compileBootPromptMutations.compileAgentBootPrompt({}, { agentRef: id, setPointer: false }, caller);

async function fixture() {
  const user = (name: string, roles: Context['roles'] = []) => db.user.create({ data: { id: generateId(), name, roles } });
  const owner = await user('owner');
  const admin = await user('org-admin');
  const member = await user('non-manager');
  const outsider = await user('outsider');
  const platform = await user('platform-admin', ['ADMIN']);
  const org = await db.organization.create({ data: { id: generateId(), name: 'compile-parity', urn: `compile-${generateId()}` } });
  for (const [u, role] of [[owner, 'OWNER'], [admin, 'ADMIN'], [member, 'READER']] as const) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role } });
  }
  const agent = async (userOwned: boolean) => {
    const suffix = generateId();
    const memory = await db.memory.create({ data: { id: generateId(), name: 'system', urn: `compile-${suffix}:system`, class: 'system', organizationId: userOwned ? null : org.id, ownerUserId: userOwned ? owner.id : null } });
    const row = await db.agent.create({ data: { id: generateId(), name: 'compile-agent', urn: `compile-${suffix}:agent`, organizationId: userOwned ? null : org.id, ownerUserId: userOwned ? owner.id : null, systemMemoryId: memory.id } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'boot:source', name: 'source', content: 'Compile parity sentinel', role: 'boot-prompt' } });
    return row;
  };
  return { owner, admin, member, outsider, platform, orgAgent: await agent(false), userAgent: await agent(true) };
}

beforeEach(async () => { await cleanDb(db); });

describe('#3238 CompiledBootPrompt.node', () => {
  it('org ADMIN and OWNER and the user-owned Agent owner receive exactly the node they can read directly', async () => {
    const f = await fixture();
    for (const [agent, principal] of [[f.orgAgent, f.admin], [f.orgAgent, f.owner], [f.userAgent, f.owner]]) {
      const caller = ctx(principal.id);
      const nested = (await compile(agent.id, caller)).node;
      const read = await direct(nested.id, ctx(principal.id));
      expect(read).not.toBeNull();
      expect(read).toMatchObject({ id: nested.id, memoryId: nested.memoryId, content: 'Compile parity sentinel' });
      expect(nested.content).toBe(read!.content);
    }
  });

  it('a non-manager and an outsider receive neither a compiled node nor its direct read', async () => {
    const f = await fixture();
    for (const agent of [f.orgAgent, f.userAgent]) {
      const nested = (await compile(agent.id, ctx(f.owner.id))).node;
      for (const principal of [f.member, f.outsider]) {
        await expect(compile(agent.id, ctx(principal.id))).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_COMPILE_NOT_PERMITTED' } });
        expect(await direct(nested.id, ctx(principal.id))).toBeNull();
      }
    }
  });

  it('#1734 known gap: a platform admin receives the user-owned Agent compiled node while the direct read refuses', async () => {
    const f = await fixture();
    const nested = (await compile(f.userAgent.id, ctx(f.platform.id, ['ADMIN']))).node;
    expect(nested).toMatchObject({ content: 'Compile parity sentinel', memoryId: f.userAgent.systemMemoryId });
    // Deliberately red when #1734 widens the direct read: update this pin and reclassify the manifest then.
    expect(await direct(nested.id, ctx(f.platform.id, ['ADMIN']))).toBeNull();
  });
});
