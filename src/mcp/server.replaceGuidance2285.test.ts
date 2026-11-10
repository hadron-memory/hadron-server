import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import type { AuthContext } from '../middleware/auth.js';
vi.mock('../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
let memoryId:string, userId:string;
beforeEach(async()=>{
 await cleanDb(db);
 const org=await db.organization.create({data:{id:generateId(),name:'guidance2285',urn:'guidance2285'}});
 const user=await db.user.create({data:{githubId:2285,githubUsername:'guidance2285',roles:['ADMIN']}});userId=user.id;
 await db.orgMember.create({data:{organizationId:org.id,userId,role:'ADMIN'}});
 const memory=await db.memory.create({data:{id:generateId(),organizationId:org.id,name:'memory',urn:'guidance2285:memory',class:'knowledge'}});memoryId=memory.id;
});
function server(){return createTestableMcpServer({userId,roles:['ADMIN'],clientId:`user:${userId}`} as AuthContext);}
for(const selector of ['id','urn','prefix'])for(const dryRun of [true,false]){
 it(`names owning doors for a selected runnable node, ${selector}, dryRun=${dryRun} #2285`,async()=>{
  const node=await db.node.create({data:{id:generateId(),memoryId,loc:'task',name:'task',content:'cat stays',isRunnable:true,role:'role-task'}});
  const selection=selector==='prefix'?{memoryUrns:['hrn:mem:guidance2285:memory'],prefix:'task'}:{nodeUrns:[selector==='id'?node.id:'hrn:node:guidance2285:memory:task']};
  const text=await server().callToolText('hadron_replace_text',{...selection,oldText:'cat',newText:'dog',fields:['content'],dryRun});
  expect(text).toMatch(/^Coverage:/m);
  expect(text).toContain('Coverage: 1 selected; 0 scanned; 1 skipped/protected (1 governed, 0 protected address).');
  expect(text).toContain('Selected nodes were skipped before text scanning');
  expect(text).toContain('not found');
  expect(text).toContain('hadron_update_task');expect(text).toContain('hadron_update_review');expect(text).toContain('CLI hadron spec');
  expect(text).not.toContain('--content-file');
  expect(text).not.toContain('updateSpecNode');
  expect((await db.node.findUniqueOrThrow({where:{id:node.id}})).content).toBe('cat stays');
  expect(await db.nodeRevision.count({where:{nodeId:node.id}})).toBe(0);
 });
}
it('does not describe an ordinary no-match scan as a governed skip #2285',async()=>{
 const node=await db.node.create({data:{id:generateId(),memoryId,loc:'ordinary',name:'ordinary',content:'no match'}});
 const text=await server().callToolText('hadron_replace_text',{nodeUrns:[node.id],oldText:'cat',newText:'dog',fields:['content']});
 expect(text).toContain('1 scanned; 0 skipped/protected');
 expect(text).not.toContain('hadron_update_task');expect(text).not.toContain('Selected nodes were skipped');
});
it('does not describe an empty prefix selection as a governed skip #2285',async()=>{
 const text=await server().callToolText('hadron_replace_text',{memoryUrns:['hrn:mem:guidance2285:memory'],prefix:'absent',oldText:'cat',newText:'dog',fields:['content']});
 expect(text).toContain('0 selected; 0 scanned; 0 skipped/protected');
 expect(text).not.toContain('hadron_update_task');expect(text).not.toContain('Selected nodes were skipped');
});
for(const dryRun of [true,false]){
 it(`mixed scanned + governed selection names the door but not the zero-scanned note, dryRun=${dryRun} #2285`,async()=>{
  const ordinary=await db.node.create({data:{id:generateId(),memoryId,loc:'ordinary',name:'ordinary',content:'cat here'}});
  const task=await db.node.create({data:{id:generateId(),memoryId,loc:'task',name:'task',content:'cat stays',isRunnable:true,role:'role-task'}});
  const text=await server().callToolText('hadron_replace_text',{nodeUrns:[ordinary.id,task.id],oldText:'cat',newText:'dog',fields:['content'],dryRun});
  expect(text).toContain('Coverage: 2 selected; 1 scanned; 1 skipped/protected (1 governed, 0 protected address).');
  expect(text).toContain('hadron_update_task');
  expect(text).not.toContain('Selected nodes were skipped');
  expect((await db.node.findUniqueOrThrow({where:{id:task.id}})).content).toBe('cat stays');
 });
}
it('a protected-address-only skip does not name the governed door #2285',async()=>{
 const {rootId}=await ensureChannelWithRoot(db,{memoryId,loc:'protected',name:'protected',createdBy:userId});
 await db.node.update({where:{id:rootId},data:{content:'cat stays'}});
 const text=await server().callToolText('hadron_replace_text',{nodeUrns:[rootId],oldText:'cat',newText:'dog',fields:['content']});
 expect(text).toContain('Coverage: 1 selected; 0 scanned; 1 skipped/protected (0 governed, 1 protected address).');
 expect(text).toContain('Selected nodes were skipped before text scanning');
 expect(text).not.toContain('Governed nodes require');
 expect(text).not.toContain('hadron_update_task');
 expect((await db.node.findUniqueOrThrow({where:{id:rootId}})).content).toBe('cat stays');
});
