import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { taskSymptoms2421 } from './fixtures/agentTaskSymptoms2421.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const Q = resolvers.Query as any;
let ctx: Context;
let child: { id: string; memoryId: string };
let base: { id: string; memoryId: string };
let foreign: string;
async function task(memoryId: string, loc: string, abstract: string | null, extra = {}) {
  return db.node.create({ data: { memoryId, loc, name: loc, isRunnable: true, abstract, ...extra } });
}
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { urn: 'symptom2421.example', name: 'symptom' } });
  const user = await db.user.create({ data: { handle: 'reader2421', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });
  ctx = { db, userId: user.id, roles: ['READER'] };
  async function agent(slug: string, extendsAgentId?: string) {
    const memory = await db.memory.create({ data: { urn: `symptom2421.example:${slug}`, name: slug, class: 'system', organizationId: org.id } });
    const a = await db.agent.create({ data: { urn: `symptom2421.example:${slug}`, name: slug, visibility: 'ORGANIZATION', organizationId: org.id, systemMemoryId: memory.id, extendsAgentId } });
    return { id: a.id, memoryId: memory.id };
  }
  base = await agent('base');
  child = await agent('child', base.id);
  const app = await db.app.create({ data: { urn: 'symptom2421.example:app', name: 'app', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: child.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  const otherOrg = await db.organization.create({ data: { urn: 'foreign2421.example', name: 'foreign' } });
  foreign = (await db.memory.create({ data: { urn: 'foreign2421.example:system', name: 'foreign', class: 'system', organizationId: otherOrg.id } })).id;
  for (const row of taskSymptoms2421) await task(child.memoryId, row.loc, row.abstract);
});
const list = (args: Record<string, unknown> = {}) => Q.agentTaskList({}, { ref: child.id, ...args }, ctx);
it('meets the fixed provisional 8/10 top-three symptom threshold', async () => {
  let correct = 0;
  for (const row of taskSymptoms2421) {
    const hits = await list({ symptom: row.symptom, limit: 99 });
    expect(hits.length).toBeLessThanOrEqual(3);
    if (hits.some((h: any) => h.node.loc === row.loc)) correct++;
  }
  expect(correct).toBeGreaterThanOrEqual(8);
});
it('ranks only abstract-bearing runnable nodes in the effective chain, nearest once', async () => {
  const inherited = await task(base.memoryId, 'tasks:inherited', 'unicorn recovery');
  await task(base.memoryId, 'tasks:override', 'unicorn recovery');
  const nearest = await task(child.memoryId, 'tasks:override', 'unicorn recovery');
  await task(foreign, 'tasks:foreign', 'unicorn recovery');
  await task(child.memoryId, 'tasks:body-only', null, { content: 'unicorn recovery' });
  await task(child.memoryId, 'tasks:wrong-abstract', 'unrelated spinach', { content: 'unicorn recovery' });
  await task(child.memoryId, 'notes:non-runnable', 'unicorn recovery', { isRunnable: false });
  const hits = await list({ symptom: 'unicorn recovery' });
  expect(hits.map((h: any) => h.node.id).sort()).toEqual([inherited.id, nearest.id].sort());
  expect(hits.find((h: any) => h.node.id === inherited.id).node.inheritedFrom.agentId).toBe(base.id);
  expect(hits.every((h: any) => h.matchedBy === 'KEYWORD')).toBe(true);
});
it.each(['', '   '])('refuses empty symptom %j as BAD_USER_INPUT', async symptom => {
  await expect(list({ symptom })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
});
it('keeps unfiltered GraphQL and MCP lists byte-identical when symptom is absent', async () => {
  const before = await list();
  expect(await list({ limit: 1 })).toEqual(before);
  const srv = createTestableMcpServer({ ...ctx, clientId: `user:${ctx.userId}` });
  expect(await srv.callToolText('hadron_agent_tasks', { agentRef: child.id, limit: 1 })).toBe(await srv.callToolText('hadron_agent_tasks', { agentRef: child.id }));
});
it('keeps the missing-system-memory refusal rather than an empty ranked list', async () => {
  await db.agent.update({ where: { id: child.id }, data: { systemMemoryId: null } });
  await expect(list({ symptom: 'migration failure' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
});
it('MCP renders at most three candidates with abstract and match reason', async () => {
  const srv = createTestableMcpServer({ ...ctx, clientId: `user:${ctx.userId}` });
  const text = await srv.callToolText('hadron_agent_tasks', { agentRef: child.id, symptom: 'migration failure', limit: 99 });
  expect(text).toContain('1 task(s)');
  expect(text).toContain('Matched by: KEYWORD');
  expect(text).toContain('Abstract: Symptoms: migration failure');
});

it('excludes readable outside-chain index tasks and install memory', async () => {
  const a = await db.agent.findUniqueOrThrow({where:{id:child.id}});
  const outside=await db.memory.create({data:{urn:'symptom2421.example:install',name:'install',class:'knowledge',visibility:'ORGANIZATION',organizationId:a.organizationId}});
  const source=await task(outside.id,'tasks:install-secret','migration failure');
  const index=await db.node.create({data:{memoryId:child.memoryId,loc:'tasks',name:'index'}});
  await db.agent.update({where:{id:child.id},data:{tasksIndexRef:index.id}});
  await db.edge.create({data:{memoryId:outside.id,sourceId:source.id,targetId:index.id,loc:'outside-index',name:'migration failure'}});
  expect((await list()).some((h:any)=>h.node.id===source.id)).toBe(true);
  expect((await list({symptom:'migration failure'})).some((h:any)=>h.node.id===source.id)).toBe(false);
});
