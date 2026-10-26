import {beforeEach, expect, it, vi} from 'vitest';
import {db} from '../integrations/db/client.js';
import {cleanDb} from '../test/helpers.js';
import {createTestableMcpServer} from './server.js';
vi.mock('../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../integrations/github/syncGraphFromGithub.js',()=>({syncGraphFromGithub:vi.fn().mockResolvedValue({error:null})}));
beforeEach(async()=>{await cleanDb(db);});
it.each(['knowledge','private'] as const)('#2512 lists three immediate children under bare parentRel in %s',async(kind)=>{
 const user=await db.user.create({data:{handle:'parent-reader',roles:kind==='knowledge'?['ADMIN']:['READER']}});
 const org=await db.organization.create({data:{urn:'parent2512.example',name:'Parent test'}});
 await db.orgMember.create({data:{organizationId:org.id,userId:user.id,role:'ADMIN'}});
 const memory=await db.memory.create({data:{urn:'parent2512.example:tree',name:'tree',class:kind,organizationId:org.id,...(kind==='private'?{userId:user.id}:{})}});
 for(const loc of ['qa-facts','qa-facts:alpha-note','qa-facts:office-facts','qa-facts:zeta-note'])await db.node.create({data:{memoryId:memory.id,loc,name:loc}});
 const srv=createTestableMcpServer({userId:user.id,roles:kind==='knowledge'?['ADMIN']:['READER'],clientId:`user:${user.id}`});
 const root=await srv.callToolText('hadron_list_nodes',{memoryUrn:`hrn:mem:${memory.urn}`,depth:2});
 for(const name of ['alpha-note','office-facts','zeta-note'])expect(root).toContain(name);
 const children=await srv.callToolText('hadron_list_nodes',{parentRel:'qa-facts'});
 for(const name of ['alpha-note','office-facts','zeta-note'])expect(children).toContain(name);
});
