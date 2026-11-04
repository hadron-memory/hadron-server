/** Xan A3 (6640310106): a withheld install date is one App date, not a discriminator. */
import {afterAll,beforeEach,expect,it,vi} from 'vitest';
import {ApolloServer} from '@apollo/server';
import {db} from '../../../integrations/db/client.js';
import {cleanDb,createDbAgentOrgGrant} from '../../../test/helpers.js';
import {generateId} from '../../../lib/id.js';
import {resolvers,type Context} from './resolvers.js';
import {typeDefs} from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
const server=new ApolloServer<Context>({typeDefs,resolvers});
const T=(day:number)=>new Date(Date.UTC(2026,0,day));
const BETA='00000000000000000000000000000001';
const GAMMA='00000000000000000000000000000002';
const HIDDEN='00000000000000000000000000000003';
const DELTA='00000000000000000000000000000004';
let appId:string,orgId:string,userId:string;
const context=(full=false):Context=>({db,userId,roles:full?['ADMIN']:['READER']});
beforeEach(async()=>{
 await cleanDb(db);
 const org=await db.organization.create({data:{name:'Dates',urn:`dates-${generateId().toLowerCase()}.example`}});
 const foreign=await db.organization.create({data:{name:'Other',urn:`other-${generateId().toLowerCase()}.example`}});
 orgId=org.id;
 const user=await db.user.create({data:{handle:`dates-${generateId()}`,roles:['READER']}});userId=user.id;
 await db.orgMember.create({data:{organizationId:orgId,userId,role:'ADMIN'}});
 const app=await db.app.create({data:{name:'Dates',urn:`${org.urn}:app`,organizationId:orgId,createdAt:T(2)}});appId=app.id;
 for(const [id,name,organizationId] of [[BETA,'Beta',orgId],[GAMMA,'Gamma',orgId],[HIDDEN,'Hidden',foreign.id]])
  await db.agent.create({data:{id,name,urn:`${org.urn}:${name.toLowerCase()}`,organizationId,visibility:'ORGANIZATION'}});
 await db.appAgent.create({data:{appId,agentId:HIDDEN,createdAt:T(5),createdBy:userId}});
 await db.appAgent.create({data:{appId,agentId:GAMMA,createdAt:T(9),createdBy:userId,updatedBy:userId}});
 await createDbAgentOrgGrant(db,orgId,BETA);
 await createDbAgentOrgGrant(db,foreign.id,BETA);
 await db.agentImport.create({data:{parentAgentId:HIDDEN,importedAgentId:BETA,position:100,required:true,
  agentOrgGrantOrgId:foreign.id,agentOrgGrantAgentId:BETA,createdAt:T(7)}});
});
afterAll(async()=>{await server.stop();});
async function wire(query:string,variables:Record<string,unknown>,full=false){
 const response=await server.executeOperation({query,variables},{contextValue:context(full)});
 if(response.body.kind!=='single')throw new Error('incremental response');
 expect(response.body.singleResult.errors).toBeUndefined();
 return response.body.singleResult.data as any;
}
const rosterQuery='query($ref:ID!){app(ref:$ref){appAgents{agent{id} createdAt createdBy updatedAt updatedBy}}}';
const agentsQuery='query($ref:ID!){app(ref:$ref){agents{id} appAgents{agent{id}}}}';
for(const importDay of [1,7]){
 it(`withheld t5/t9/t${importDay} entries share the App date and sort only by Agent id`,async()=>{
  await db.agentImport.updateMany({data:{createdAt:T(importDay)}});
  const rows=(await wire(rosterQuery,{ref:appId})).app.appAgents;
  expect(rows).toHaveLength(3);
  expect(rows.map((row:any)=>row.createdAt)).toEqual([T(2).toISOString(),T(2).toISOString(),T(2).toISOString()]);
  expect(rows.map((row:any)=>row.agent?.id??HIDDEN)).toEqual([BETA,GAMMA,HIDDEN]);
  for(const row of rows)expect(row).toMatchObject({createdBy:null,updatedAt:null,updatedBy:null});
 });
 for(const full of [false,true]) {
  it(`App.agents t5/t9/t${importDay} follows the served installation order (full=${full})`,async()=>{
   await db.agentImport.updateMany({data:{createdAt:T(importDay)}});
   const app=(await wire(agentsQuery,{ref:appId},full)).app;
   const expected=[{id:HIDDEN,date:T(5)},{id:GAMMA,date:T(9)},{id:BETA,date:T(Math.max(5,importDay))}]
    .sort((a,b)=>(full?a.date.getTime()-b.date.getTime():0)||a.id.localeCompare(b.id))
    .filter(row=>full||row.id!==HIDDEN).map(row=>row.id);
   expect(app.agents.map((agent:any)=>agent.id)).toEqual(expected);
   expect(app.agents.map((agent:any)=>agent.id)).toEqual(app.appAgents.filter((row:any)=>row.agent!==null).map((row:any)=>row.agent.id));
  });
 }
 it(`full t5/t9/t${importDay} entries retain per-entry dates and sort across kinds`,async()=>{
  await db.agentImport.updateMany({data:{createdAt:T(importDay)}});
  const rows=(await wire(rosterQuery,{ref:appId},true)).app.appAgents;
  const expected=[{id:HIDDEN,date:T(5)},{id:GAMMA,date:T(9)},{id:BETA,date:T(Math.max(5,importDay))}]
   .sort((a,b)=>a.date.getTime()-b.date.getTime()||a.id.localeCompare(b.id));
  expect(rows.map((row:any)=>({id:row.agent.id,date:row.createdAt})))
   .toEqual(expected.map(row=>({id:row.id,date:row.date.toISOString()})));
 });
}
it.each([false,true])('the reverse Agent.appAgents route applies the same date gate (full=%s)',async(full)=>{
 const data=await wire('query($ref:ID!){agent(ref:$ref){appAgents{createdAt createdBy updatedAt updatedBy}}}',{ref:GAMMA},full);
 const row=await db.appAgent.findUniqueOrThrow({where:{appId_agentId:{appId,agentId:GAMMA}}});
 expect(data.agent.appAgents).toEqual([{createdAt:T(full?9:2).toISOString(),
  createdBy:full?row.createdBy:null,updatedAt:full?row.updatedAt?.toISOString()??null:null,updatedBy:full?row.updatedBy:null}]);
});
it.each([false,true])('a newly created install returns its real date but a later read applies the gate (full=%s)',async(full)=>{
 await db.agent.create({data:{id:DELTA,name:'Delta',urn:`dates-${generateId().toLowerCase()}.example:delta`,organizationId:orgId,visibility:'ORGANIZATION'}});
 const data=await wire('mutation($app:ID!,$agent:ID!){installAgentIntoApp(appRef:$app,agentRef:$agent){appAgent{createdAt app{appAgents{agent{id} createdAt}}}}}',{app:appId,agent:DELTA},full);
 const row=await db.appAgent.findUniqueOrThrow({where:{appId_agentId:{appId,agentId:DELTA}}});
 expect(data.installAgentIntoApp.appAgent.createdAt).toBe(row.createdAt.toISOString());
 const nested=data.installAgentIntoApp.appAgent.app.appAgents.find((entry:any)=>entry.agent?.id===DELTA);
 expect(nested.createdAt).toBe((full?row.createdAt:T(2)).toISOString());
 const listed=(await wire(rosterQuery,{ref:appId},full)).app.appAgents;
 const delta=listed.find((entry:any)=>entry.agent?.id===DELTA);
 expect(delta.createdAt).toBe((full?row.createdAt:T(2)).toISOString());
});

it.each([false,true])('a fresh physical install does not sort ahead of a derived entry by kind (full=%s)',async(full)=>{
 await db.agent.create({data:{id:DELTA,name:'Delta',urn:`dates-${generateId().toLowerCase()}.example:delta`,organizationId:orgId,visibility:'ORGANIZATION'}});
 await db.appAgent.create({data:{appId,agentId:DELTA,createdAt:T(11)}});
 const app=(await wire(agentsQuery,{ref:appId},full)).app;
 expect(app.agents.map((agent:any)=>agent.id)).toEqual(full?[HIDDEN,BETA,GAMMA,DELTA]:[BETA,GAMMA,DELTA]);
 expect(app.agents.map((agent:any)=>agent.id)).toEqual(app.appAgents.filter((row:any)=>row.agent!==null).map((row:any)=>row.agent.id));
});

it.each([false,true])('App.agents uses the served key when visible date order opposes id order (full=%s)',async(full)=>{
 await db.appAgent.update({where:{appId_agentId:{appId,agentId:GAMMA}},data:{createdAt:T(3)}});
 const app=(await wire(agentsQuery,{ref:appId},full)).app;
 expect(app.agents.map((agent:any)=>agent.id)).toEqual(full?[GAMMA,HIDDEN,BETA]:[BETA,GAMMA]);
});

it.each([BETA,GAMMA])('setAppAgentBootPrompt returns a complete readable Agent for %s',async(agentId)=>{
 const agent=await db.agent.findUniqueOrThrow({where:{id:agentId}});
 const data=await wire('mutation($app:String!,$agent:String!){setAppAgentBootPrompt(appRef:$app,agentRef:$agent,nodeRef:null){agent{id createdAt} bootPromptRef}}',{app:appId,agent:agentId});
 expect(data.setAppAgentBootPrompt).toEqual({agent:{id:agentId,createdAt:agent.createdAt.toISOString()},bootPromptRef:null});
});
