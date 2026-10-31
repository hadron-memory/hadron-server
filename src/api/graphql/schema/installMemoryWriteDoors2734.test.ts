/** #2734: every remaining node-write door uses the live App manager audience. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any;
const context = (userId: string): Context => ({ db, userId, roles: [], clientId: `user:${userId}` });
beforeEach(async () => { await cleanDb(db); });
async function fixture() {
 const org = await db.organization.create({ data: { name: 'Door org', urn: `doors-${generateId().toLowerCase()}` } });
 const agent = await db.agent.create({ data: { name: 'Door Agent', urn: `${org.urn}:agent`, organizationId: org.id } });
 const { app } = await createDbAppWithKey(db, 'doors-app', org.id);
 await createDbAppAgent(db, app.id, agent.id);
 const admin = await db.user.create({ data: { name: 'manager' } });
 await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
 await createDbAppMember(db, app.id, admin.id, 'member');
 const member = await db.user.create({ data: { name: 'participant' } });
 await createDbAppMember(db, app.id, member.id, 'member');
 const outsider = await db.user.create({ data: { name: 'outsider' } });
 const node = await M.createNode({}, { input: { install: { appRef: app.id, agentRef: agent.id }, loc: 'source', name: 'Source', content: 'before' } }, context(admin.id));
 const target = await M.createNode({}, { input: { memoryId: node.memoryId, loc: 'target', name: 'Target', content: 'target' } }, context(admin.id));
 const edge = await db.edge.create({ data: { memoryId: node.memoryId, sourceId: node.id, targetId: target.id, loc: 'link', name: 'link' } });
 const revision = await db.nodeRevision.create({ data: { nodeId: node.id, memoryId: node.memoryId, loc: 'source', name: 'Earlier', content: 'earlier', tags: [], changes: [], revNo: 0 } });
 const memory = await db.memory.findUniqueOrThrow({ where: { id: node.memoryId } });
 return { org, agent, app, admin, member, outsider, node, target, edge, revision, memory };
}
type F = Awaited<ReturnType<typeof fixture>>;
const doors: Array<[string, (f: F, ctx: Context) => Promise<unknown>]> = [
 ['moveNode', (f,c) => M.moveNode({}, { sourceRef: f.node.id, targetUrn: `${f.memory.urn.replace('hrn:mem:','hrn:node:')}:moved` }, c)],
 ['searchReplaceInNodes', (f,c) => M.searchReplaceInNodes({}, { input: { nodeIds: [f.node.id], oldText: 'before', newText: 'after', fields: ['CONTENT'] } }, c)],
 ['deleteNode', (f,c) => M.deleteNode({}, { nodeRef: f.node.id }, c)],
 ['createEdge', (f,c) => M.createEdge({}, { sourceRef: f.node.id, targetRef: f.target.id, loc: 'newlink', name: 'new' }, c)],
 ['updateEdge', (f,c) => M.updateEdge({}, { edgeRef: f.edge.id, name: 'after' }, c)],
 ['deleteEdge', (f,c) => M.deleteEdge({}, { edgeRef: f.edge.id }, c)],
 ['mergeNodes', (f,c) => M.mergeNodes({}, { input: { source: f.node.id, target: f.target.id, include: ['CONTENT'] } }, c)],
 ['restoreNodeRevision', (f,c) => M.restoreNodeRevision({}, { revisionId: f.revision.id }, c)],
 ['deleteNodeRevision', (f,c) => M.deleteNodeRevision({}, { revisionId: f.revision.id }, c)],
 ['updateNodeRevision', (f,c) => M.updateNodeRevision({}, { revisionId: f.revision.id, revLabel: 'after' }, c)],
 ['clearNodeHistory', (f,c) => M.clearNodeHistory({}, { nodeRef: f.node.id }, c)],
];
async function snapshot(f: F) {
 return { nodes: await db.node.findMany({ where: { memoryId: f.node.memoryId }, orderBy: { id: 'asc' } }), edges: await db.edge.findMany({ where: { memoryId: f.node.memoryId }, orderBy: { id: 'asc' } }), revisions: await db.nodeRevision.findMany({ where: { nodeId: f.node.id }, orderBy: { id: 'asc' } }) };
}
describe.each(doors)('#2734 %s', (name, call) => {
 it('opens to the live App manager and changes the persisted state', async () => {
  const f=await fixture();const before=await snapshot(f);await call(f,context(f.admin.id));expect(await snapshot(f)).not.toEqual(before);
 });
 it.each(['member','outsider','detached','uninstalled','deleted'] as const)('refuses %s without changing content, edges or history', async mode => {
  const f=await fixture();
  if(mode==='detached') await db.memory.update({where:{id:f.node.memoryId},data:{installOfAgentId:null}});
  if(mode==='uninstalled') await db.appAgent.delete({where:{appId_agentId:{appId:f.app.id,agentId:f.agent.id}}});
  if(mode==='deleted') await db.app.update({where:{id:f.app.id},data:{deletedAt:new Date()}});
  const before=await snapshot(f);const user=mode==='member'?f.member:mode==='outsider'?f.outsider:f.admin;
  await expect(call(f,context(user.id))).rejects.toThrow();expect(await snapshot(f)).toEqual(before);
 });
});
