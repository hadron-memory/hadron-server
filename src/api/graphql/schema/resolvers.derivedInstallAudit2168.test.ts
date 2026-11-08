/** Xan audit-shape ruling6636734542: whole-App gate, not a per-entry discriminator. */
import {beforeEach,expect,it,vi} from 'vitest';
import {ApolloServer} from '@apollo/server';
import {db} from '../../../integrations/db/client.js';
import {cleanDb} from '../../../test/helpers.js';
import {generateId} from '../../../lib/id.js';
import {resolvers,type Context} from './resolvers.js';
import {typeDefs} from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
const server=new ApolloServer<Context>({typeDefs,resolvers});
let foreignOrgId:string;
let app:{id:string},admin:{id:string},stranger:{id:string},physical:{id:string},derived:{id:string},hidden:{id:string};
const ctx=():Context=>({db,userId:admin.id,roles:['READER']});
beforeEach(async()=>{
 await cleanDb(db);
 const org=await db.organization.create({data:{name:'Audit',urn:`audit-${generateId().toLowerCase()}.example`}});
 const foreign=await db.organization.create({data:{name:'Other',urn:`other-${generateId().toLowerCase()}.example`}});foreignOrgId=foreign.id;
 admin=await db.user.create({data:{handle:`audit-${generateId()}`,roles:['READER']}});
 stranger=await db.user.create({data:{handle:`audit-${generateId()}`,roles:['READER']}});
 await db.orgMember.create({data:{organizationId:org.id,userId:admin.id,role:'ADMIN'}});
 app=await db.app.create({data:{organizationId:org.id,name:'Audit',urn:`${org.urn}:team`}});
 await db.appMember.create({data:{appId:app.id,userId:stranger.id,role:'member'}});
 const make=(organizationId:string,name:string)=>db.agent.create({data:{id:generateId(),organizationId,name,urn:`${org.urn}:${name}`,visibility:'ORGANIZATION'}});
 physical=await make(org.id,'Physical');derived=await make(org.id,'Derived');hidden=await make(foreign.id,'Hidden');
 await db.appAgent.create({data:{appId:app.id,agentId:physical.id,createdBy:admin.id,updatedBy:admin.id}});
 await db.appAgent.create({data:{appId:app.id,agentId:hidden.id,createdBy:admin.id,updatedBy:admin.id}});
 await db.agentOrgGrant.create({data:{orgId:org.id,agentId:derived.id,activatedAt:new Date()}});
 await db.agentImport.create({data:{parentAgentId:physical.id,importedAgentId:derived.id,position:100,required:true,agentOrgGrantOrgId:org.id,agentOrgGrantAgentId:derived.id}});
});
async function wire(as:Context){
 const response=await server.executeOperation({query:'query($ref:ID!){app(ref:$ref){appAgents{agent{id} createdAt createdBy updatedAt updatedBy}}}',variables:{ref:app.id}},{contextValue:as});
 if(response.body.kind!=='single')throw new Error('incremental response');
 expect(response.body.singleResult.errors).toBeUndefined();return (response.body.singleResult.data as any).app.appAgents as any[];
}
it('partial readers see null audits on physical, derived and withheld entries alike',async()=>{
 const rows=await wire(ctx());expect(rows).toHaveLength(3);expect(rows.some(row=>row.agent===null)).toBe(true);
 for(const row of rows){expect(row.createdAt).toBeTruthy();expect(row).toMatchObject({createdBy:null,updatedAt:null,updatedBy:null});}
});
it('whole-App readers see physical row audits but never a borrowed importer identity on derived entries',async()=>{
 const rows=await wire({...ctx(),roles:['ADMIN']});expect(rows.every(row=>row.agent!==null)).toBe(true);
 expect(rows.find(row=>row.agent.id===physical.id)).toMatchObject({createdBy:admin.id,updatedBy:admin.id});
 expect(rows.find(row=>row.agent.id===physical.id).updatedAt).toBeTruthy();
 expect(rows.find(row=>row.agent.id===derived.id)).toMatchObject({createdBy:null,updatedAt:null,updatedBy:null});
});
it('an App reader who cannot read any installed Agent gets the same null audit projection',async()=>{
 await db.agent.updateMany({where:{id:{in:[physical.id,derived.id]}},data:{organizationId:foreignOrgId}});
 const rows=await wire(ctx());expect(rows).toHaveLength(3);
 expect(rows.every(row=>row.agent===null)).toBe(true);
 for(const row of rows)expect(row).toMatchObject({createdBy:null,updatedAt:null,updatedBy:null});
});
