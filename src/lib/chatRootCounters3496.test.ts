/** #3496 — operational counters do not participate in a root's revision state. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { appendChatMessage, updateChatRootData, type ChatRootRef } from './chatRoot.js';
import { computeRevisionStateHash, ensureCurrentNodeRevisionInTransaction } from './nodeRevisionSnapshot.js';
import { encryptNodeFields, decryptNodeFields } from './nodeCrypto.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
let chat: ChatRootRef;
let enc: {id:string;isEncrypted:boolean};
beforeEach(async()=>{
 await cleanDb(db); sessionKeyCache.clear();
 const org=await db.organization.create({data:{id:generateId(),name:'counter',urn:`counter-${generateId()}`}});
 const mem=await db.memory.create({data:{id:generateId(),organizationId:org.id,urn:`counter-${generateId()}`,name:'counter',class:'knowledge'}});
 enc={id:mem.id,isEncrypted:false};
 const root=await db.node.create({data:{id:generateId(),memoryId:mem.id,loc:'chats:counter',name:'counter',nodeType:'record',data:{messageCount:9,lastMessageAt:'2026-01-01T00:00:00.000Z',title:'keep'}}});
 chat={id:root.id,memoryId:mem.id,loc:root.loc};
 await db.node.create({data:{id:generateId(),memoryId:mem.id,loc:`${root.loc}:messages`,name:'messages',nodeType:'record'}});
});
async function post(){return appendChatMessage(db,chat,enc,async({tx,seq,msgNum})=>{
 await tx.node.create({data:{id:generateId(),memoryId:chat.memoryId,loc:`${chat.loc}:messages:${msgNum}`,name:msgNum,nodeType:'record',seq}});
});}
async function counter(){return (await db.$queryRaw<Array<{message_count:number;last_message_at:Date|null}>>`SELECT message_count,last_message_at FROM chat_root_counters WHERE chat_root_node_id=${chat.id}`)[0];}
async function fingerprint(){await db.node.update({where:{id:chat.id},data:{revisionContentHash:'refresh',authorshipKind:'TASK',authoredByTask:'tasks:author',authoredByRevision:1,authoredAt:new Date()}});}
async function reconcile(){return db.$transaction(tx=>ensureCurrentNodeRevisionInTransaction(tx,chat.id,{expectedMemoryId:chat.memoryId}));}
async function raw(){return db.node.findUniqueOrThrow({where:{id:chat.id}});}
describe('#3496 counters',()=>{
 it('a send preserves a synchronized fingerprint, revision and authorship, and strips the keys',async()=>{
  await fingerprint();const before=await raw();await post();await reconcile();const after=await raw();
  expect(after.revSeq).toBe(before.revSeq);expect(after.authoredByTask).toBe(before.authoredByTask);
  expect(after.revisionContentHash).toBe(await computeRevisionStateHash(db,chat.id));
  expect(after.data).toEqual({title:'keep'});expect((await counter()).message_count).toBe(10);
 });
 it('a row wins over restored or overlap keys and retains hard-deleted allocation history',async()=>{
  await post();await db.node.deleteMany({where:{memoryId:chat.memoryId,seq:10}});
  await db.node.update({where:{id:chat.id},data:{data:{messageCount:100,title:'restore'}}});
  expect((await post()).seq).toBe(11);expect((await raw()).data).toEqual({title:'restore'});
 });
 it('the MAX(seq) arm still includes soft-deleted messages but not summaries (control)',async()=>{
  await db.node.create({data:{id:generateId(),memoryId:chat.memoryId,loc:`${chat.loc}:messages:040-old`,name:'old',nodeType:'record',seq:40,deletedAt:new Date()}});
  await db.node.create({data:{id:generateId(),memoryId:chat.memoryId,loc:`${chat.loc}:messages:999-summary`,name:'summary',nodeType:'abstract',seq:999}});
  expect((await post()).seq).toBe(41);
 });
 it('does not launder drift when lazily stripping keys',async()=>{
  await fingerprint();const before=await raw();await db.node.update({where:{id:chat.id},data:{name:'outside'}});
  await post();await reconcile();const after=await raw();expect(after.revSeq).toBe(before.revSeq+1);expect(after.authoredByTask).toBeNull();
  await reconcile();expect((await raw()).revSeq).toBe(after.revSeq);
 });
 it('ordinary root-data edits still drift; counter-only timestamp updates do not',async()=>{
  await post();await fingerprint();const before=await raw();
  await updateChatRootData(db,chat,enc,f=>({...f,lastMessageAt:'2026-02-01T00:00:00.000Z'}));
  await reconcile();expect((await raw()).revSeq).toBe(before.revSeq);expect((await counter()).last_message_at?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  await updateChatRootData(db,chat,enc,f=>({...f,title:'real change'}));await reconcile();expect((await raw()).revSeq).toBe(before.revSeq+1);
 });
 it('lazy-seeds encrypted legacy data and keeps the ciphertext fingerprint synchronized',async()=>{
  enc.isEncrypted=true;await db.memory.update({where:{id:enc.id},data:{isEncrypted:true}});
  sessionKeyCache.set(generateId(),enc.id,generateDataKey());
  await db.node.update({where:{id:chat.id},data:encryptNodeFields({data:{messageCount:40,title:'secret'}},enc)});
  await fingerprint();const before=await raw();expect((await post()).seq).toBe(41);await reconcile();
  expect((await raw()).revSeq).toBe(before.revSeq);expect(decryptNodeFields(await raw(),enc).data).toEqual({title:'secret'});
 });
});
