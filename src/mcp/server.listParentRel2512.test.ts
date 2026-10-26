/** #2512: explicit parent browsing uses the same read gate as explicit root browsing. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const children = ['alpha-note', 'office-facts', 'zeta-note'];
beforeEach(async () => { await cleanDb(db); });
async function fixture(kind: 'knowledge' | 'private' = 'private') {
  const user = await db.user.create({ data: { handle: 'parent-reader', roles: kind === 'knowledge' ? ['ADMIN'] : ['READER'] } });
  const org = await db.organization.create({ data: { urn: 'parent2512.example', name: 'Parent test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const memory = await db.memory.create({ data: { urn: 'parent2512.example:tree', name: 'tree', class: kind, organizationId: org.id, ...(kind === 'private' ? { userId: user.id } : {}) } });
  for (const loc of ['qa-facts', ...children.map(name => `qa-facts:${name}`)]) await db.node.create({ data: { memoryId: memory.id, loc, name: loc } });
  const auth: AuthContext = { userId: user.id, roles: kind === 'knowledge' ? ['ADMIN'] : ['READER'], clientId: `user:${user.id}` };
  const srv = createTestableMcpServer(auth);
  return { user, org, memory, auth, srv };
}
function parentArgs(memory: { urn: string }, mode: 'qualified' | 'scoped') {
  return mode === 'qualified' ? { parentRel: `hrn:node:${memory.urn}:qa-facts` } : { memoryUrn: `hrn:mem:${memory.urn}`, parentRel: 'qa-facts' };
}
it('keeps the org-knowledge bare-parent control', async () => {
  const { srv } = await fixture('knowledge');
  const text = await srv.callToolText('hadron_list_nodes', { parentRel: 'qa-facts' });
  for (const name of children) expect(text).toContain(name);
});
it.each(['qualified', 'scoped'] as const)('lists all three children for a private owner with a %s parent reference', async mode => {
  const { srv, memory } = await fixture();
  const root = await srv.callToolText('hadron_list_nodes', { memoryUrn: `hrn:mem:${memory.urn}`, depth: 2 });
  for (const name of children) expect(root).toContain(name);
  const text = await srv.callToolText('hadron_list_nodes', parentArgs(memory, mode));
  for (const name of children) expect(text).toContain(name);
});
it('keeps unscoped bare-parent discovery narrower than explicit private reads', async () => {
  const { srv } = await fixture();
  const text = await srv.callToolText('hadron_list_nodes', { parentRel: 'qa-facts' });
  expect(text).toContain('No child nodes found');
  for (const name of children) expect(text).not.toContain(name);
});
it.each(['qualified', 'scoped'] as const)('refuses a foreign private owner even for a platform admin via %s parent', async mode => {
  const { memory } = await fixture();
  const other = await db.user.create({ data: { handle: 'foreign-reader', roles: ['ADMIN'] } });
  const srv = createTestableMcpServer({ userId: other.id, roles: ['ADMIN'], clientId: `user:${other.id}` });
  const text = await srv.callToolText('hadron_list_nodes', parentArgs(memory, mode));
  expect(text).toContain('not found');
  for (const name of children) expect(text).not.toContain(name);
});
it.each(['qualified', 'scoped'] as const)('rechecks revoked participation on the same connection for a %s parent', async mode => {
  const { user, org, memory, auth } = await fixture();
  const app = await db.app.create({ data: { organizationId: org.id, urn: 'parent2512.example:app', name: 'App' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, urn: 'parent2512.example:agent', name: 'Agent' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.agentSubscription.create({ data: { userId: user.id, agentId: agent.id, activatedAt: new Date() } });
  await db.memory.update({ where: { id: memory.id }, data: { appId: app.id, userMemoryOfAgentId: agent.id } });
  // App B is selected: explicitly addressing App A must recheck its live participation.
  const otherApp = await db.app.create({ data: { organizationId: org.id, urn: 'parent2512.example:other', name: 'Other' } });
  const srv = createTestableMcpServer({ ...auth, appId: otherApp.id });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const args = parentArgs(memory, mode);
  expect(await srv.callToolText('hadron_list_nodes', args)).toContain('alpha-note');
  await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: user.id } } });
  const denied = await srv.callToolText('hadron_list_nodes', args);
  expect(denied).toContain('not found');
  for (const name of children) expect(denied).not.toContain(name);
});
it.each(['qualified', 'scoped'] as const)('uses the same explicit not-found envelope for an unknown memory via %s parent', async mode => {
  const { srv } = await fixture();
  const args = parentArgs({ urn: 'parent2512.example:absent' }, mode);
  const result = await srv.callTool('hadron_list_nodes', args) as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe(`Node "${args.parentRel}" not found.`);
});
it.each(['hrn:node:foo', 'urn:node:foo:bar', 'hrn:node:parent2512.example:tree'])('returns a typed refusal for malformed node parent %s', async parentRel => {
  const { srv } = await fixture();
  const result = await srv.callTool('hadron_list_nodes', { parentRel }) as { isError?: boolean };
  expect(result.isError).toBe(true);
});
it.each([undefined, 'hrn:mem:parent2512.example:tree'])('refuses a non-node scheme as parent with memory scope %s', async memoryUrn => {
  const { srv } = await fixture();
  const result = await srv.callTool('hadron_list_nodes', { parentRel: 'hrn:memory:parent2512.example:tree', memoryUrn }) as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('parentRel must be');
});
it('pins the existing root requirement and root browsing', async () => {
  const { srv, memory } = await fixture();
  expect(await srv.callToolText('hadron_list_nodes', {})).toBe('Please provide a memoryUrn or parentRel.');
  expect(await srv.callToolText('hadron_list_nodes', { memoryUrn: `hrn:mem:${memory.urn}` })).toContain('qa-facts');
});
it('refuses an unqualified memory scope with isError', async () => {
  const { srv } = await fixture();
  const result = await srv.callTool('hadron_list_nodes', { memoryUrn: 'tree', parentRel: 'qa-facts' }) as { isError?: boolean };
  expect(result.isError).toBe(true);
});
it('keeps empty-subtree success for an absent loc in a readable memory', async () => {
  const { srv, memory } = await fixture();
  expect(await srv.callToolText('hadron_list_nodes', { parentRel: `hrn:node:${memory.urn}:absent-loc` })).toBe('No child nodes found under "absent-loc".');
});
it('accepts matching dual references and refuses conflicting readable memories', async () => {
  const { srv, memory, user, org } = await fixture();
  const parentRel = `hrn:node:${memory.urn}:qa-facts`;
  expect(await srv.callToolText('hadron_list_nodes', { parentRel, memoryUrn: `hrn:mem:${memory.urn}` })).toContain('alpha-note');
  const other = await db.memory.create({ data: { urn: 'parent2512.example:other-memory', name: 'other', class: 'private', userId: user.id, organizationId: org.id } });
  const result = await srv.callTool('hadron_list_nodes', { parentRel, memoryUrn: `hrn:mem:${other.urn}` }) as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('must name the same memory');
});
it('does not reveal an unreadable dual-reference memory through conflict diagnostics', async () => {
  const { srv, memory, org } = await fixture();
  const other = await db.user.create({ data: { handle: 'scope-owner' } });
  const foreign = await db.memory.create({ data: { urn: 'parent2512.example:foreign', name: 'foreign', class: 'private', userId: other.id, organizationId: org.id } });
  const parentRel = `hrn:node:${memory.urn}:qa-facts`;
  for (const memoryUrn of [`hrn:mem:${foreign.urn}`, 'hrn:mem:parent2512.example:missing']) {
    const result = await srv.callTool('hadron_list_nodes', { parentRel, memoryUrn }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`Node "${parentRel}" not found.`);
  }
});
