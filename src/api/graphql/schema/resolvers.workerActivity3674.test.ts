/** #3674: a named worker read must not aggregate the other workers' session histories. */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
afterAll(() => server.stop());
let appId: string, agentId: string, userId: string, outsiderId: string;
let workers: Array<{id:string;name:string}>;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({data:{name:'Activity scope',urn:`scope-${generateId().toLowerCase()}.example`}});
  userId = (await db.user.create({data:{handle:`scope-${generateId()}`,roles:['READER']}})).id;
  outsiderId = (await db.user.create({data:{handle:`other-${generateId()}`,roles:['READER']}})).id;
  await db.orgMember.create({data:{organizationId:org.id,userId,role:'ADMIN'}});
  appId = (await db.app.create({data:{name:'Scope',urn:`${org.urn}:app`,organizationId:org.id}})).id;
  agentId = (await db.agent.create({data:{name:'Role',urn:`${org.urn}:role`,organizationId:org.id}})).id;
  await db.appAgent.create({data:{appId,agentId}});
  workers=[];
  for(let i=0;i<4;i++) {
    const w=await db.worker.create({data:{appId,agentId,name:`Worker${i}`,slug:`worker${i}`,role:'engineer',signature:'',trailer:''}});workers.push(w);
    await db.session.create({data:{id:generateId(),appId,agentId,workerId:w.id,userId,family:'claude',llmModel:'claude-sonnet-5-5'}});
  }
});
function observedContext(user=userId) {
  const folds:string[][]=[];
  const observed=new Proxy(db,{get(target,key){
    if(key==='$queryRaw') return async (...args:unknown[])=>{
      const rows=await (target.$queryRaw as (...args:unknown[])=>Promise<unknown>)(...args);
      const sql=args[0] as {strings?:string[]};
      if(sql.strings?.join('').includes('GROUP BY s.worker_id')) folds.push((rows as Array<{workerId:string}>).map(r=>r.workerId));
      return rows;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return {context:{db:observed,userId:user,roles:['READER']} as Context,folds};
}
async function wire(query:string,variables:Record<string,unknown>,context:Context) {
  const r=await server.executeOperation({query,variables},{contextValue:context});
  if(r.body.kind!=='single')throw new Error('incremental');
  expect(r.body.singleResult.errors).toBeUndefined();return r.body.singleResult.data as any;
}
for(const nameForm of [false,true])it(`one named worker, nameForm=${nameForm}: one fold of only that worker, three sibling fields`,async()=>{
  const {context,folds}=observedContext();
  const data=await wire('query($a:ID!,$r:ID!){worker(appRef:$a,ref:$r){id family model hasLiveSession}}',{a:appId,r:nameForm?workers[0].name:workers[0].id},context);
  expect(data.worker).toMatchObject({id:workers[0].id,family:'claude',model:'claude-sonnet-5-5',hasLiveSession:true});
  expect(folds).toEqual([[workers[0].id]]);
});
it('list keeps one App-wide fold rather than one fold per row',async()=>{
  const {context,folds}=observedContext();
  const data=await wire('query($a:ID!){workers(appRef:$a){items{id family model hasLiveSession}}}',{a:appId},context);
  expect(data.workers.items).toHaveLength(4);expect(folds).toHaveLength(1);expect(folds[0].sort()).toEqual(workers.map(w=>w.id).sort());
});
it('a profile reader cannot trigger the activity lookup or obtain internals',async()=>{
  const {context,folds}=observedContext(outsiderId);
  const data=await wire('query($r:ID!){worker(ref:$r){id family model hasLiveSession prompt}}',{r:workers[0].id},context);
  expect(data.worker).toMatchObject({id:workers[0].id,family:null,model:null,hasLiveSession:null,prompt:null});expect(folds).toEqual([]);
});
it('fresh reads see session model and ending changes, never cross-request cached',async()=>{
  const query='query($r:ID!){worker(ref:$r){family model hasLiveSession}}';
  expect((await wire(query,{r:workers[0].id},observedContext().context)).worker.family).toBe('claude');
  await db.session.updateMany({where:{workerId:workers[0].id},data:{family:'codex',llmModel:'gpt-6.1-sol'}});
  expect((await wire(query,{r:workers[0].id},observedContext().context)).worker).toMatchObject({family:'codex',model:'gpt-6.1-sol'});
  await db.session.updateMany({where:{workerId:workers[0].id},data:{endedAt:new Date()}});
  expect((await wire(query,{r:workers[0].id},observedContext().context)).worker).toMatchObject({family:null,model:null,hasLiveSession:false});
});
it('prompt text remains re-fetchable and byte-exact after a newly served compile',async()=>{
  const query='query($r:ID!){worker(ref:$r){prompt}}';
  await serveAgentBootPrompt(db,agentId,'First {{worker.name}}.');
  expect((await wire(query,{r:workers[0].id},observedContext().context)).worker.prompt).toBe('First Worker0.');
  await serveAgentBootPrompt(db,agentId,'Second {{worker.name}}.');
  expect((await wire(query,{r:workers[0].id},observedContext().context)).worker.prompt).toBe('Second Worker0.');
});
