/** #2168: an import witness is not authority to read a foreign parent's import edges. */
import {afterAll,beforeEach,expect,it,vi} from 'vitest';
import {ApolloServer} from '@apollo/server';
import {db} from '../../../integrations/db/client.js';
import {cleanDb} from '../../../test/helpers.js';
import {generateId} from '../../../lib/id.js';
import {resolveAppInstallation} from '../../../lib/appInstallations.js';
import {resolvers,type Context} from './resolvers.js';
import {typeDefs} from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
const server=new ApolloServer<Context>({typeDefs,resolvers});
let appId:string,holderOrgId:string,vendorOrgId:string,installedId:string,privateId:string,publicId:string;
const createdAt=new Date('2026-01-07T00:00:00Z');
const context=():Context=>({db,appId,organizationId:holderOrgId,roles:[]});
beforeEach(async()=>{
 await cleanDb(db);
 const holder=await db.organization.create({data:{name:'Holder',urn:`holder-${generateId().toLowerCase()}.example`}});holderOrgId=holder.id;
 const vendor=await db.organization.create({data:{name:'Vendor',urn:`vendor-${generateId().toLowerCase()}.example`}});vendorOrgId=vendor.id;
 const app=await db.app.create({data:{name:'Consumer',urn:`${holder.urn}:consumer`,organizationId:holder.id}});appId=app.id;
 const make=(name:string,visibility:string)=>db.agent.create({data:{name,urn:`${vendor.urn}:${name.toLowerCase()}`,organizationId:vendor.id,visibility}});
 installedId=(await make('Installed','ORGANIZATION')).id;
 privateId=(await make('Private','ORGANIZATION')).id;
 publicId=(await make('Public','PUBLIC')).id;
 await db.appAgent.create({data:{appId,agentId:installedId}});
 // The vendor's composition grant is not the consuming App holder's license.
 await db.agentOrgGrant.create({data:{orgId:vendorOrgId,agentId:privateId,activatedAt:new Date()}});
 await db.agentImport.create({data:{parentAgentId:installedId,importedAgentId:privateId,position:100,required:true,agentOrgGrantOrgId:vendorOrgId,agentOrgGrantAgentId:privateId}});
 await db.agentOrgGrant.create({data:{orgId:vendorOrgId,agentId:publicId,activatedAt:new Date()}});
 await db.agentImport.create({data:{parentAgentId:privateId,importedAgentId:publicId,position:7,required:false,createdAt,agentOrgGrantOrgId:vendorOrgId,agentOrgGrantAgentId:publicId}});
});
afterAll(async()=>{await server.stop();});
async function rows(ctx=context()){
 const response=await server.executeOperation({query:'query($ref:ID!){agent(ref:$ref){importedBy{parentAgentId position required createdAt parentAgent{id name}}}}',variables:{ref:publicId}},{contextValue:ctx});
 if(response.body.kind!=='single')throw new Error('incremental response');
 expect(response.body.singleResult.errors).toBeUndefined();
 return (response.body.singleResult.data as any).agent.importedBy;
}
async function license(state:'active'|'inactive'|'revoked'|'expired'){
 await db.agentOrgGrant.upsert({where:{orgId_agentId:{orgId:holderOrgId,agentId:privateId}},
  create:{orgId:holderOrgId,agentId:privateId,activatedAt:state==='inactive'?null:new Date(),revokedAt:state==='revoked'?new Date():null,expiresAt:state==='expired'?new Date(0):null},
  update:{activatedAt:state==='inactive'?null:new Date(),revokedAt:state==='revoked'?new Date():null,expiresAt:state==='expired'?new Date(0):null}});
}
it.each(['none','inactive','revoked','expired'] as const)('App keys cannot read a private derived parent import edge with a %s holder license',async(state)=>{
 if(state!=='none')await license(state);
 expect(await resolveAppInstallation(db,appId,privateId)).toBeNull();
 expect(await rows()).toEqual([]);
});
it('a live holder license admits the parent; revocation and removal close the derived edge audience',async()=>{
 await license('active');
 expect(await rows()).toEqual([{parentAgentId:privateId,position:7,required:false,createdAt:createdAt.toISOString(),parentAgent:{id:privateId,name:'Private'}}]);
 await license('revoked');
 expect(await rows()).toEqual([]);
 await license('active');
 expect(await rows()).toHaveLength(1);
 await db.agentImport.deleteMany({where:{parentAgentId:installedId,importedAgentId:privateId}});
 expect(await rows()).toEqual([]);
});
it('a physical parent retains its established App-key edge audience without borrowing a new license',async()=>{
 await db.appAgent.create({data:{appId,agentId:privateId}});
 await db.agentImport.deleteMany({where:{parentAgentId:installedId,importedAgentId:privateId}});
 expect(await rows()).toEqual([{parentAgentId:privateId,position:7,required:false,createdAt:createdAt.toISOString(),parentAgent:null}]);
});
it('an outside App cannot borrow another App import witness',async()=>{
 appId=(await db.app.create({data:{name:'Outside',urn:`outside-${generateId().toLowerCase()}.example:app`,organizationId:holderOrgId}})).id;
 expect(await rows()).toEqual([]);
});
it('a public parent remains readable independently of App installation',async()=>{
 await db.agent.update({where:{id:privateId},data:{visibility:'PUBLIC'}});
 const result=await rows({db,roles:[]});
 expect(result).toHaveLength(1);
 expect(result[0]).toMatchObject({parentAgentId:privateId,parentAgent:{id:privateId,name:'Private'}});
});
it('the parent-owning org member retains the independent org audience',async()=>{
 const user=await db.user.create({data:{handle:`vendor-${generateId()}`,roles:['READER']}});
 await db.orgMember.create({data:{organizationId:vendorOrgId,userId:user.id,role:'READER'}});
 expect(await rows({db,userId:user.id,roles:['READER']})).toHaveLength(1);
});
