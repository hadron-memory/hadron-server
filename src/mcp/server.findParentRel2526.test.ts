/** #2526: explicit parent browsing uses the same read gate as explicit root browsing. */
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
  const org = await db.organization.create({ data: { urn: 'parent2526.example', name: 'Parent test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const memory = await db.memory.create({ data: { urn: 'parent2526.example:tree', name: 'tree', class: kind, organizationId: org.id, ...(kind === 'private' ? { userId: user.id } : {}) } });
  for (const loc of ['qa-facts', ...children.map(name => `qa-facts:${name}`)]) await db.node.create({ data: { memoryId: memory.id, loc, name: loc } });
  const auth: AuthContext = { userId: user.id, roles: kind === 'knowledge' ? ['ADMIN'] : ['READER'], clientId: `user:${user.id}` };
  const srv = createTestableMcpServer(auth);
  return { user, org, memory, auth, srv };
}
function parentArgs(memory: { urn: string }, mode: 'qualified' | 'scoped') {
  return mode === 'qualified' ? { parentRel: `hrn:node:${memory.urn}:qa-facts` } : { memoryUrn: `hrn:mem:${memory.urn}`, parentRel: 'qa-facts' };
}

it.each(['qualified', 'scoped'] as const)('finds all children for a private owner via %s parent', async mode => {
  const {srv, memory} = await fixture();
  expect(await srv.callToolText('hadron_find_nodes', {query:'*', memoryUrn:`hrn:mem:${memory.urn}`})).toContain('alpha-note');
  const text = await srv.callToolText('hadron_find_nodes', {query:'*', ...parentArgs(memory,mode)});
  for (const name of children) expect(text).toContain(name);
});
it('keeps the knowledge ADMIN and unscoped private discovery controls', async () => {
  const {srv} = await fixture('knowledge');
  expect(await srv.callToolText('hadron_find_nodes', {query:'*', parentRel:'qa-facts'})).toContain('alpha-note');
});
it('makes unknown and foreign private qualified parents indistinguishable', async () => {
  const {memory} = await fixture();
  const other = await db.user.create({data:{handle:'foreign',roles:['ADMIN']}});
  const srv=createTestableMcpServer({userId:other.id,roles:['ADMIN'],clientId:`user:${other.id}`});
  for(const urn of [memory.urn,'parent2526.example:missing']) {
    expect(await srv.callToolText('hadron_find_nodes',{query:'*',parentRel:`hrn:node:${urn}:qa-facts`})).toBe('No nodes found matching "*".');
  }
});
it.each(['qualified', 'scoped'] as const)('rechecks revoked participation on the same connection for a %s parent', async mode => {
  const { user, org, memory, auth } = await fixture();
  const app = await db.app.create({ data: { organizationId: org.id, urn: 'parent2526.example:app', name: 'App' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, urn: 'parent2526.example:agent', name: 'Agent' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.agentSubscription.create({ data: { userId: user.id, agentId: agent.id, activatedAt: new Date() } });
  await db.memory.update({ where: { id: memory.id }, data: { appId: app.id, userMemoryOfAgentId: agent.id } });
  // App B is selected: explicitly addressing App A must recheck its live participation.
  const otherApp = await db.app.create({ data: { organizationId: org.id, urn: 'parent2526.example:other', name: 'Other' } });
  const srv = createTestableMcpServer({ ...auth, appId: otherApp.id });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const args = {query:'*', ...parentArgs(memory, mode)};
  expect(await srv.callToolText('hadron_find_nodes', args)).toContain('alpha-note');
  await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: user.id } } });
  const denied = await srv.callToolText('hadron_find_nodes', args);
  expect(denied).toBe(mode === 'qualified' ? 'No nodes found matching "*".' : `Memory not found or invalid: 'hrn:mem:${memory.urn}'. Use hadron_list_memories to see what is available.`);
  for (const name of children) expect(denied).not.toContain(name);
});

it.each(['hadron_find_nodes','hadron_list_nodes'])('keeps a colon loc scoped to the supplied memory on %s', async tool => {
 const {srv,memory,org,user}=await fixture('knowledge');
 const other=await db.memory.create({data:{urn:'parent2526.example:private',name:'private',class:'private',userId:user.id,organizationId:org.id}});
 for(const [memoryId,name] of [[memory.id,'discovery-only'],[other.id,'scoped-only']])
   await db.node.create({data:{memoryId,loc:`notes:ideas:${name}`,name}});
 const text=await srv.callToolText(tool,{query:'*',parentRel:'notes:ideas',memoryUrn:`hrn:mem:${other.urn}`});
 expect(text).toContain('scoped-only'); expect(text).not.toContain('discovery-only');
});
it.each(['hrn:node:foo', 'urn:node:foo:bar', 'hrn:node:parent2526.example:tree', 'hrn:memory:parent2526.example:tree'])('refuses malformed/wrong-kind parent %s', async parentRel => {
 const {srv}=await fixture();
 expect(await srv.callTool('hadron_find_nodes',{query:'*',parentRel})).toMatchObject({isError:true});
});
it('authorizes dual references before diagnosing a mismatch', async () => {
 const {srv,memory,org,user}=await fixture();
 const parentRel=`hrn:node:${memory.urn}:qa-facts`;
 expect(await srv.callToolText('hadron_find_nodes',{query:'*',parentRel,memoryUrn:`hrn:mem:${memory.urn}`})).toContain('alpha-note');
 const other=await db.memory.create({data:{urn:'parent2526.example:other',name:'other',class:'private',userId:user.id,organizationId:org.id}});
 expect(await srv.callTool('hadron_find_nodes',{query:'*',parentRel,memoryUrn:`hrn:mem:${other.urn}`})).toMatchObject({isError:true,content:[{type:'text',text:'parentRel and memoryUrn must name the same memory.'}]});
 const foreign=await db.user.create({data:{handle:'foreign-scope'}});
 await db.memory.update({where:{id:other.id},data:{userId:foreign.id}});
 const denied=await srv.callToolText('hadron_find_nodes',{query:'*',parentRel,memoryUrn:`hrn:mem:${other.urn}`});
 expect(denied).toBe(`Memory not found or invalid: 'hrn:mem:${other.urn}'. Use hadron_list_memories to see what is available.`);
});
