/** #2662, cor:agt:050:30 / ruling0013A: immutable findings, shape only; events count, never text. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { readFileSync } from 'node:fs';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const R = resolvers as any, M = R.Mutation;
let app: any, owner: any, assignee: any, task: any;
const ctx = (userId = assignee.id) => ({ db, userId, roles: ['READER'] });
const finish = (findings?: unknown, extra = {}) => M.finishAgentTask({}, { taskId: task.id, result: { outcome: 'succeeded', summary: 'S', evidence: 'E', ...(findings === undefined ? {} : { findings }), ...extra } }, ctx());
const stored = () => db.agentTask.findUniqueOrThrow({ where: { id: task.id } });
const events = () => db.agentTeamEvent.findMany({ where: { taskId: task.id, type: 'task.finished' } });
const read = async (args = {}) => R.AgentTaskResult.findings(R.AgentTask.result(await stored()), args, ctx());
beforeEach(async () => {
 await cleanDb(db);
 const org = await db.organization.create({ data: { name: 'Findings', urn: `findings-${generateId()}.test` } });
 [owner, assignee] = await Promise.all(['owner','assignee'].map(handle => db.user.create({data:{handle}})));
 app = await db.app.create({data:{organizationId:org.id,name:'Findings',urn:`${org.urn}:findings`}});
 for(const u of [owner,assignee]) await db.appMember.create({data:{appId:app.id,userId:u.id,role:'member'}});
 task = await M.createAgentTask({}, {input:{appRef:app.id,title:'T',source:'s',assignee:{user:assignee.id}}}, ctx(owner.id));
 await M.startAgentTask({}, {taskId:task.id}, ctx());
});
describe('#2662 findings on finish', () => {
 it('generates ids in order, preserves text, round-trips each severity and pages', async () => {
  const findings = ['P1','P2','P3','note'].map((severity,i)=>({severity,text:`private finding ${i}`}));
  await finish(findings);
  expect(await read({limit:2,offset:1})).toEqual({items:[{id:'F2',...findings[1]},{id:'F3',...findings[2]}],total:4,hasMore:true});
  expect(await read({limit:2,offset:3})).toEqual({items:[{id:'F4',...findings[3]}],total:4,hasMore:false});
  expect((await events()).map(e=>e.payload)).toEqual([{outcome:'succeeded',findingCounts:{P1:1,P2:1,P3:1,note:1}}]);
  expect(JSON.stringify(await events())).not.toContain('private finding');
 });
 it('preserves every supplied id and text verbatim', async () => {
  const f=[{id:'a_1-Z',severity:'note',text:'  untrimmed\ntext  '}]; await finish(f);
  expect((await read()).items).toEqual(f);
 });
 it('accepts the exact count, text and id bounds', async()=>{
  const f=Array.from({length:100},(_,i)=>({id:i===0?'x'.repeat(32):`n${i}`,severity:'P3',text:'💡'.repeat(2000)}));
  await finish(f);expect((await read({limit:100})).items).toEqual(f);
  expect((await read({limit:0}))).toEqual({items:[],total:100,hasMore:true});
 });
 it('finish without findings preserves the old result and event byte shapes',async()=>{
  await finish();expect(R.AgentTask.result(await stored())).toEqual({outcome:'succeeded',summary:'S',evidence:'E'});
  expect((await events()).map(e=>e.payload)).toEqual([{outcome:'succeeded'}]);expect((await read()).items).toEqual([]);
 });
 it('empty findings is allowed and counts zero',async()=>{await finish([]);expect(await read()).toEqual({items:[],total:0,hasMore:false});expect((await events())[0].payload).toEqual({outcome:'succeeded',findingCounts:{P1:0,P2:0,P3:0,note:0}});});
 it.each([
  ['mixed ids',[{id:'one',severity:'P1',text:'x'},{severity:'P2',text:'y'}]],
  ['duplicate id',[{id:'same',severity:'P1',text:'x'},{id:'same',severity:'P3',text:'y'}]],
  ['unknown severity',[{severity:'critical',text:'x'}]],
  ['wrong severity case',[{severity:'NOTE',text:'x'}]],
  ['too many',Array.from({length:101},()=>({severity:'note',text:'x'}))],
  ['text too long',[{severity:'P1',text:'a'.repeat(2001)}]],
  ['id too long',[{id:'x'.repeat(33),severity:'P1',text:'x'}]],
  ['blank id',[{id:'',severity:'P1',text:'x'}]],
  ['invalid id',[{id:'a.b',severity:'P1',text:'x'}]],
  ['missing text',[{severity:'P1'}]],['null row',[null]],['not list',{}],
 ])('refuses %s with no task or event change',async(_,f)=>{
  const before=await stored();await expect(finish(f)).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
  expect(await stored()).toEqual(before);expect(await events()).toHaveLength(0);
 });
 it('findings cannot be replaced by another finish',async()=>{
  await finish([{severity:'P1',text:'original'}]);const before=await stored();
  await expect(finish([{severity:'note',text:'replacement'}])).rejects.toMatchObject({extensions:{code:'TASK_ENDED'}});
  expect(await stored()).toEqual(before);expect(await events()).toHaveLength(1);
 });
 it('retains the existing assignee and read gates',async()=>{
  await expect(M.finishAgentTask({}, {taskId:task.id,result:{outcome:'done',findings:[{severity:'P1',text:'x'}]}},ctx(owner.id))).rejects.toMatchObject({extensions:{code:'TASK_NOT_ASSIGNEE'}});
  await finish([{severity:'note',text:'private'}]);
  const outsider=await db.user.create({data:{handle:'outsider'}});
  expect(await R.Query.agentTask({}, {id:task.id}, ctx(outsider.id))).toBeNull();
 });
 it('publishes only a paginated findings field on the result and a bounded input list',()=>{
  const schema=buildSchema(typeDefs);expect(schema.getType('AgentTaskFindingPage')).toBeDefined();
  expect((schema.getType('AgentTaskResult') as any).getFields().findings.args.map((a:any)=>a.name)).toEqual(['limit','offset']);
  expect((schema.getType('AgentTaskResultInput') as any).getFields().findings).toBeDefined();
 });
});

it('GraphQL finish and paged read expose the typed findings; invalid severity writes nothing', async()=>{
 const schema=buildSchema(typeDefs);
 const fieldResolver=(parent:any,args:any,c:any,info:any)=>{const fn=R[info.parentType.name]?.[info.fieldName];return typeof fn==='function'?fn(parent,args,c,info):defaultFieldResolver(parent,args,c,info);};
 const before=await stored();
 const bad=await graphql({schema,source:'mutation($id:ID!){finishAgentTask(taskId:$id,result:{outcome:"done",findings:[{severity:critical,text:"x"}]}){id}}',variableValues:{id:task.id},contextValue:ctx(),fieldResolver});
 expect(bad.errors).toBeDefined();expect(await stored()).toEqual(before);expect(await events()).toHaveLength(0);
 const good=await graphql({schema,source:'mutation($id:ID!){finishAgentTask(taskId:$id,result:{outcome:"done",findings:[{severity:P2,text:"wire text"}]}){result{outcome findings(limit:1){total hasMore items{id severity text}}}}}',variableValues:{id:task.id},contextValue:ctx(),fieldResolver});
 expect(good.errors).toBeUndefined();expect(good.data).toEqual({finishAgentTask:{result:{outcome:'done',findings:{total:1,hasMore:false,items:[{id:'F1',severity:'P2',text:'wire text'}]}}}});
});
it('database refuses findings on an open task and replacement after finish',async()=>{
 await expect(db.agentTask.update({where:{id:task.id},data:{resultFindings:[]}})).rejects.toThrow();
 await finish([{severity:'P1',text:'fixed result'}]);
 await expect(db.agentTask.update({where:{id:task.id},data:{resultFindings:[]}})).rejects.toThrow();
 expect((await read()).items[0].text).toBe('fixed result');
});

it('migration carries the exact post-push findings guards',()=>{
 const sql=readFileSync('prisma/agent-task-findings-invariants.sql','utf8');
 expect(readFileSync('prisma/migrations/20261102193000_agent_task_findings/migration.sql','utf8').endsWith(sql)).toBe(true);
});
