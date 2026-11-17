/** #4098: the public event-id continuation must not pass a transaction that can still publish an event. */
import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { settleTeamEventHorizon } from '../../../test/teamEventHorizon.js';

let appId:string,userId:string;
const T=Date.UTC(2026,10,1);
const context=():Context=>({db,userId,roles:['READER']});
const event=(at:number)=>db.agentTeamEvent.create({data:{appId,type:'task.created',createdAt:new Date(at)}});
const settle=()=>settleTeamEventHorizon(db);
beforeEach(async()=>{
 await cleanDb(db);
 userId=(await db.user.create({data:{email:`${generateId()}@cursor.test`}})).id;
 appId=(await db.app.create({data:{ownerUserId:userId,name:'Cursor',urn:`${generateId().toLowerCase()}:cursor`}})).id;
});
const surfaces=['legacy','page'] as const;
async function read(surface:typeof surfaces[number],after:string|undefined,limit=1):Promise<Array<{id:string}>>{
 if(surface==='legacy')return resolvers.Query.agentTeamEvents({}, {appRef:appId,after,limit},context());
 return (await resolvers.Query.agentTeamEventsPage({}, {appRef:appId,after,limit},context())).events;
}
describe('#4098 committed-event completeness',()=>{
 it.each(surfaces.flatMap(surface=>[{surface,anchored:true},{surface,anchored:false}]))('$surface: an older open writer is delivered after commit (existing cursor=$anchored)',async({surface,anchored})=>{
  const anchor=anchored?await event(T):null;await settle();
  const pg=new Client({connectionString:process.env.DATABASE_URL});await pg.connect();let open=false;
  const olderId=generateId();let cursor=anchor?.id;const seen:string[]=[];
  const poll=async()=>{const rows=await read(surface,cursor);seen.push(...rows.map(r=>r.id));if(rows.length)cursor=rows[rows.length-1].id;};
  try{
   await pg.query('BEGIN');open=true;
   await pg.query(`INSERT INTO agent_team_events(id,app_id,type,created_at) VALUES($1,$2,'task.created',$3::timestamp)`,[olderId,appId,new Date(T+1000).toISOString()]);
   const newer=await event(T+2000);
   await poll(); // The newer committed row may not move the reader past the older transaction's reserved slot.
   await pg.query('COMMIT');open=false;await settle();
   for(let i=0;i<3;i++)await poll();
   expect(seen,'every committed event must be delivered exactly once').toEqual([olderId,newer.id]);
   expect(await read(surface,cursor)).toEqual([]);
  }finally{if(open)await pg.query('ROLLBACK');await pg.end();}
 },30000);
 it.each(surfaces)('%s: a later transaction with an older caller stamp cannot land behind a served cursor',async(surface)=>{
  const anchor=await event(T);await settle();expect(await read(surface,anchor.id)).toEqual([]);
  const later=await event(T-3600000);await settle();
  expect((await read(surface,anchor.id)).map(r=>r.id)).toEqual([later.id]);
 },30000);
});

describe('#4098 row and filter parity',()=>{
 it('returns the same row fields as the ORM, plus the existing task handle',async()=>{
  const e=await event(T);await settle();
  const rows=await resolvers.Query.agentTeamEvents({}, {appRef:appId},context());
  expect(rows).toEqual([{...await db.agentTeamEvent.findUniqueOrThrow({where:{id:e.id}}),taskHandle:null}]);
 });
 it('filters before paging and keeps the public page cursor an event id',async()=>{
  const anchor=await event(T);
  await db.agentTeamEvent.createMany({data:[
   {appId,type:'task.progress',createdAt:new Date(T+1000)},
   {appId,type:'task.edited',createdAt:new Date(T+1000)},
   {appId,type:'task.edited',createdAt:new Date(T+1000)},
  ]});await settle();
  const first=await resolvers.Query.agentTeamEventsPage({}, {appRef:appId,after:anchor.id,types:['task.edited'],codePrefix:'task.',limit:1},context());
  expect(first.events).toHaveLength(1);expect(first.hasMore).toBe(true);expect(first.nextCursor).toBe(first.events[0].id);
  const next=await resolvers.Query.agentTeamEventsPage({}, {appRef:appId,after:first.nextCursor,types:['task.edited'],codePrefix:'task.',limit:1},context());
  expect(next.events).toHaveLength(1);expect(next.events[0].id).not.toBe(first.events[0].id);expect(next.hasMore).toBe(false);expect(next.nextCursor).toBeNull();
  expect(await resolvers.Query.agentTeamEvents({}, {appRef:appId,after:anchor.id,codePrefix:'task_%'},context())).toEqual([]);
 });
});


/**
 * BLIND review P2 (Cedric, at ddf1aa38): the forward read states its filters in SQL and the newest-first read states
 * them through the ORM. Both must select the same events for every filter, alone and combined, so a filter changed on
 * one path and not the other fails here.
 */
describe('#4098 every filter selects the same events on the forward (SQL) and the newest-first (ORM) read',()=>{
 const ids=(rows:Array<{id:string}>)=>rows.map(r=>r.id).sort();
 const both=async(filter:Record<string,unknown>)=>({
  forward:ids(await resolvers.Query.agentTeamEvents({}, {appRef:appId,limit:200,...filter},context())),
  newest:ids(await resolvers.Query.agentTeamEvents({}, {appRef:appId,limit:200,newestFirst:true,...filter},context())),
 });
 it('since, types, codePrefix, alarmsOnly, alarmsInEffect and taskId, alone and combined',async()=>{
  const taskId=generateId();
  const mk=(type:string,at:number,extra:Record<string,unknown>={})=>db.agentTeamEvent.create({data:{appId,type,createdAt:new Date(at),...extra} as never});
  const plain=await mk('task.created',T);
  const onTask=await mk('task.progress',T+1000,{taskId});
  const underscore=await mk('task.edited',T+2000);
  const other=await mk('host.lost',T+3000);
  const open=await mk('stall.not-started',T+4000,{severity:'alarm',taskId});
  const acked=await mk('stall.no-progress',T+5000,{severity:'alarm'});
  await db.agentTeamEvent.update({where:{id:acked.id},data:{acknowledgedAt:new Date(T+6000),acknowledgedByUserId:userId}});
  const ended=await mk('stall.not-started',T+7000,{severity:'alarm'});
  await db.alarmEscalationEnd.create({data:{eventId:ended.id,endedAt:new Date(T+8000)}});
  await settle();
  const all=[plain,onTask,underscore,other,open,acked,ended].map(e=>e.id).sort();
  const cases:Array<[Record<string,unknown>,string[]]>=[
   [{},all],
   [{since:new Date(T+2000).toISOString()},[other,open,acked,ended].map(e=>e.id)],
   [{since:new Date(T+2000)},[other,open,acked,ended].map(e=>e.id)],
   [{types:['task.created','host.lost']},[plain,other].map(e=>e.id)],
   [{codePrefix:'task.'},[plain,onTask,underscore].map(e=>e.id)],
   [{codePrefix:'task_'},[]], // a LIKE wildcard in the prefix is a literal on both paths
   [{codePrefix:'stall.%'},[]],
   [{types:['task.edited','host.lost'],codePrefix:'task.'},[underscore.id]],
   [{alarmsOnly:true},[open,acked,ended].map(e=>e.id)],
   [{alarmsInEffect:true},[open.id]],
   [{alarmsOnly:true,alarmsInEffect:true},[open.id]],
   [{taskId},[onTask,open].map(e=>e.id)],
   [{taskId,alarmsInEffect:true},[open.id]],
   [{since:new Date(T+4000).toISOString(),alarmsOnly:true,codePrefix:'stall.'},[acked,ended].map(e=>e.id)],
  ];
  for(const [filter,expected] of cases){
   const got=await both(filter);
   expect(got.forward,`forward ${JSON.stringify(filter)}`).toEqual([...expected].sort());
   expect(got.newest,`newest-first ${JSON.stringify(filter)}`).toEqual([...expected].sort());
  }
 },30000);
});

describe('#4098 first forward page and continuation agree',()=>{
 it.each(surfaces)('%s: one-row pages keep every event when a later transaction has an older stamp',async(surface)=>{
  const first=await event(T+1000),second=await event(T);await settle();
  const page=await read(surface,undefined);expect(page.map(r=>r.id)).toEqual([first.id]);
  expect((await read(surface,page[0].id)).map(r=>r.id)).toEqual([second.id]);
  expect(await read(surface,second.id)).toEqual([]);
 },30000);
});
