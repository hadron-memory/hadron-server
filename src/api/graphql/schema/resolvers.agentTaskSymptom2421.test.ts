import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { taskSymptoms2421 } from './fixtures/agentTaskSymptoms2421.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { upsertAbstractVector, upsertChunkVectors } from '../../../services/embedding/vectors.js';
import { canReadMemory } from '../../../mcp/access-control.js';
afterEach(() => { vi.unstubAllEnvs(); resetEmbeddingClientForTests(); });
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
  vi.stubEnv('EMBEDDING_API_URL', '');
  vi.stubEnv('EMBEDDING_BACKEND', 'http');
  resetEmbeddingClientForTests();
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
  expect(await canReadMemory(db, ctx, base.memoryId)).toBe(false);
  const inherited = await task(base.memoryId, 'tasks:inherited', 'unicorn recovery');
  await task(base.memoryId, 'tasks:override', 'unicorn recovery');
  const nearest = await task(child.memoryId, 'tasks:override', 'unicorn recovery');
  await task(foreign, 'tasks:foreign', 'unicorn recovery');
  await task(child.memoryId, 'tasks:body-only', null, { content: 'unicorn recovery' });
  await task(child.memoryId, 'tasks:wrong-abstract', 'unrelated spinach', { content: 'unicorn recovery' });
  const nonRunnable = await task(child.memoryId, 'notes:non-runnable', 'unicorn recovery', { isRunnable: false });
  const index = await db.node.create({data:{memoryId:child.memoryId,loc:'tasks',name:'index'}});
  await db.agent.update({where:{id:child.id},data:{tasksIndexRef:index.id}});
  await db.edge.create({data:{memoryId:child.memoryId,sourceId:nonRunnable.id,targetId:index.id,loc:'non-runnable-index',name:'unicorn recovery'}});
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
  const locs = taskSymptoms2421.map(row=>row.loc).sort();
  expect(before.map((entry:any)=>[entry.node.loc,entry.trigger])).toEqual(locs.map(loc=>[loc,null]));
  const srv = createTestableMcpServer({ ...ctx, clientId: `user:${ctx.userId}` });
  expect(await srv.callToolText('hadron_agent_tasks', { agentRef: child.id, limit: 1 })).toBe(await srv.callToolText('hadron_agent_tasks', { agentRef: child.id }));
  const legacyText = [`10 task(s) for Agent ${child.id}:`, ...locs.map(loc=>`- ${loc} — hrn:node:symptom2421.example:child:${loc}`)].join('\n');
  expect(await srv.callToolText('hadron_agent_tasks',{agentRef:child.id})).toBe(legacyText);
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
it('keeps unreadable Agent refusal identical to the unfiltered list', async () => {
  const stranger = await db.user.create({data:{handle:'unreadable2421',roles:['READER']}});
  const untrusted = {db,userId:stranger.id,roles:['READER']};
  for(const args of [{ref:child.id},{ref:child.id,symptom:'migration failure'}])
    await expect(Q.agentTaskList({},args,untrusted)).rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
});

it('uses abstract vectors only and labels BOTH versus VECTOR from ranking inputs', async () => {
  vi.stubEnv('EMBEDDING_API_URL', 'http://stub.invalid');
  vi.stubEnv('EMBEDDING_BACKEND', 'http');
  const embedding = Array.from({length:768}, (_,i) => i===0 ? 1 : 0);
  setEmbeddingClientForTests({provider:'test', model:'2421', dim:768, embed:async texts=>texts.map(()=>embedding)});
  const both = await task(child.memoryId, 'tasks:both', 'nebula recovery');
  const vector = await task(base.memoryId, 'tasks:vector-only', 'galactic repair');
  const chunk = await task(child.memoryId, 'tasks:chunk-only', 'unrelated cabbage');
  const noAbstract = await task(child.memoryId, 'tasks:stale-abstract', null);
  for(const node of [both,vector,noAbstract]) await upsertAbstractVector(db,{nodeId:node.id,memoryId:node.memoryId,provider:'test',model:'2421',dim:768,embedding});
  await upsertChunkVectors(db,chunk.id,[{nodeId:chunk.id,memoryId:chunk.memoryId,provider:'test',model:'2421',dim:768,embedding,chunkIndex:0,charStart:0,charEnd:6,chunkText:'nebula'}]);
  const hits = await list({symptom:'nebula recovery'});
  expect(hits.map((h:any)=>[h.node.id,h.matchedBy])).toEqual([[both.id,'BOTH'],[vector.id,'VECTOR']]);
});
it('defaults to three, clamps a larger limit and honors a smaller limit', async () => {
  for (let i=0;i<5;i++) await task(child.memoryId, `tasks:common-${i}`, 'common unique symptom');
  expect(await list({symptom:'common unique symptom'})).toHaveLength(3);
  expect(await list({symptom:'common unique symptom',limit:100})).toHaveLength(3);
  expect(await list({symptom:'common unique symptom',limit:1})).toHaveLength(1);
});

it('abstract-only lexical ranking preserves stemming and relevance order', async () => {
  const strong = await task(child.memoryId, 'tasks:strong-abstract', 'migrations failing migrations failing');
  const weak = await task(child.memoryId, 'tasks:weak-abstract', 'unrelated words '.repeat(100) + 'migration failure');
  const hits = await list({symptom:'migration'});
  expect(hits.findIndex((h:any)=>h.node.id===strong.id)).toBeLessThan(hits.findIndex((h:any)=>h.node.id===weak.id));
  expect(hits.some((h:any)=>h.node.id===strong.id)).toBe(true);
  expect(hits.some((h:any)=>h.node.id===weak.id)).toBe(true);
});
it('MCP omits task abstracts when membership is revoked during embedding retrieval', async () => {
  await task(child.memoryId, 'tasks:secret', 'zebra outage secretabstract');
  vi.stubEnv('EMBEDDING_API_URL', 'http://stub.invalid');
  const embedding = Array.from({length:768}, (_,i) => i===0 ? 1 : 0);
  setEmbeddingClientForTests({provider:'test',model:'revocation',dim:768,embed:async texts=>{
    await db.appMember.deleteMany({where:{userId:ctx.userId}});
    await db.orgMember.deleteMany({where:{userId:ctx.userId}});
    return texts.map(()=>embedding);
  }});
  const srv = createTestableMcpServer({...ctx,clientId:`user:${ctx.userId}`});
  const text = await srv.callToolText('hadron_agent_tasks',{agentRef:child.id,symptom:'zebra outage'});
  expect(text).not.toContain('secretabstract');
});
it.each([0, -1])('refuses a non-positive ranked limit %s', async limit => {
  await expect(list({symptom:'migration failure',limit})).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
});
it('does not relax the keyword half of a true-hybrid task search', async () => {
  vi.stubEnv('EMBEDDING_API_URL','http://stub.invalid');
  const embedding = Array.from({length:768},(_,i)=>i===0?1:0);
  setEmbeddingClientForTests({provider:'test',model:'no-relax',dim:768,embed:async texts=>texts.map(()=>embedding)});
  await task(child.memoryId,'tasks:keyword-partial','alpha partial');
  const vector = await task(child.memoryId,'tasks:vector-recall','galactic repair');
  await upsertAbstractVector(db,{nodeId:vector.id,memoryId:vector.memoryId,provider:'test',model:'no-relax',dim:768,embedding});
  const hits = await list({symptom:'alpha zzmissing'});
  expect(hits.map((h:any)=>[h.node.id,h.matchedBy])).toEqual([[vector.id,'VECTOR']]);
});
it('filters vector candidates before their ANN window rather than losing the eligible task', async () => {
  const {getRetrievalProvider} = await import('../../../lib/retrieval/postgres.js');
  const queryEmbedding = Array.from({length:768},(_,i)=>i===0?1:0);
  const weaker = Array.from({length:768},(_,i)=>i===0?0.8:i===1?0.6:0);
  const eligible = await task(child.memoryId,'tasks:eligible-vector','eligible abstract');
  await upsertAbstractVector(db,{nodeId:eligible.id,memoryId:eligible.memoryId,provider:'test',model:'window',dim:768,embedding:weaker});
  for(let i=0;i<12;i++) {
    const distractor = await task(child.memoryId,`notes:closer-${i}`,'closer abstract',{isRunnable:false});
    await upsertAbstractVector(db,{nodeId:distractor.id,memoryId:distractor.memoryId,provider:'test',model:'window',dim:768,embedding:queryEmbedding});
  }
  const hits = await getRetrievalProvider().vectorSearch({db,memoryIds:[child.memoryId],candidateNodeIds:[eligible.id],abstractOnly:true,queryEmbedding,limit:1,contentScope:'CONTENT'});
  expect(hits.map(h=>h.nodeId)).toEqual([eligible.id]);
});
