/** Measurement-only: counts observations, never an approved ceiling or product optimization. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { PARALLEL_DBS, workerDbName } from '../../../test/dbWorkers.js';
import { QueryCount3638 } from '../../../test/diagnostics/queryCount3638.js';
import { personalOrgAgentLicenseHolds, personalOrgAgentTextAllowed } from '../../../lib/auth/personalOrgAgentInstall.js';
import { getAppMemoryCandidates, participantSystemMemoryFolds } from '../../../mcp/access-control.js';
import { readableInstallMemoryIds } from '../../../lib/auth/installMemory.js';
import { isAgentInstalledAndLicensed } from '../../../lib/appAgent.js';
import { previewServedBootPrompt } from '../../../lib/bootPrompt/serve.js';
import { chatCarrierApps } from './agentChatAccess.js';
import { serveChatPrompt } from './resolvers.mutation.chat.js';
import type { Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
const counter = new QueryCount3638();
let barrierSeen = false;
let postgresVersion = 'unrecorded';
logged.$on('query', event => {
  if (event.query.includes('licence-count-3638-barrier')) barrierSeen = true;
  else counter.record(event.query);
});
type Observation = { shape: string; path: string; repeat: string; sqlCount: number; tables: Record<string,number>; semantic: string };
const observations: Observation[] = [];
beforeAll(async () => {
  expect(PARALLEL_DBS, 'diagnostic requires run-owned parallel clone').toBe(true);
  const expected = workerDbName(process.env.VITEST_POOL_ID ?? '1');
  expect(new URL(process.env.DATABASE_URL!).pathname).toBe(`/${expected}`);
  for (const client of [db,logged]) {
    const rows = await client.$queryRaw<{name:string}[]>`SELECT current_database() AS name`;
    expect(rows[0]?.name).toBe(expected);
  }
  postgresVersion = (await logged.$queryRaw<{version:string}[]>`SELECT version() AS version`)[0].version;
  await measure('observer','positive-control','first', async () => { await logged.$queryRaw`SELECT 1`; return 'one statement'; });
});
afterAll(async () => { await logged.$disconnect(); });
async function measure(shape: string, path: string, repeat: string, run: () => Promise<string>) {
  counter.begin(); barrierSeen = false;
  let semantic: string;
  try {
    semantic = await run();
    await logged.$queryRaw`SELECT 'licence-count-3638-barrier'`;
    await vi.waitFor(() => expect(barrierSeen, 'later SQL event drains this dedicated client').toBe(true));
  } catch (error) { counter.end(); throw error; }
  const observed = counter.end();
  observations.push({shape,path,repeat,...observed,semantic});
  // These explicit fast refusals/qualifications need no database operation.
  const zeroQueryBranch = (shape.startsWith('userless/') && ['readable-install-memories','participant-system-folds'].includes(path))
    || (shape.startsWith('org-app/') && ['licence-helper','text-helper'].includes(path));
  if (zeroQueryBranch) expect(observed.sqlCount).toBe(0);
  else expect(observed.sqlCount, `${shape}/${path}: SQL observer is connected`).toBeGreaterThan(0);
}
const states = ['active','owner-revoked','outsider','userless','public','org-app'] as const;
it.each([1,3])('records the fixed %i-Agent roster, semantic outcomes and same-context repeat', async count => {
 const start = observations.length;
 for (const state of states) {
  await cleanDb(db);
  const owner = await db.user.create({data:{handle:'diagnostic3638-owner',roles:['READER']}});
  const viewer = await db.user.create({data:{handle:'diagnostic3638-viewer',roles:['READER']}});
  const org = await db.organization.create({data:{name:'Publisher',urn:'diagnostic3638.test'}});
  await db.orgMember.create({data:{organizationId:org.id,userId:owner.id,role:'READER',deletedAt:state==='owner-revoked'?new Date():null}});
  const app = await db.app.create({data:{name:'Measured',urn:state==='org-app'?'diagnostic3638.test:app':'@diagnostic3638-owner:app',...(state==='org-app'?{organizationId:org.id}:{ownerUserId:owner.id})}});
  await db.appMember.createMany({data:[{appId:app.id,userId:owner.id,role:'owner'},{appId:app.id,userId:viewer.id,role:'member'}]});
  const agents = [];
  for (let i=0;i<count;i++) {
   const memory=await db.memory.create({data:{class:'system',organizationId:org.id,name:`Definition ${i}`,urn:`diagnostic3638.test:definition-${i}`}});
   const agent=await db.agent.create({data:{name:`Agent ${i}`,urn:`diagnostic3638.test:agent-${i}`,organizationId:org.id,visibility:state==='public'?'PUBLIC':'ORGANIZATION',systemMemoryId:memory.id}});
   await db.agentSubscription.create({data:{userId:owner.id,agentId:agent.id,activatedAt:new Date('2020-01-01')}});
   await db.appAgent.create({data:{appId:app.id,agentId:agent.id}});
   await db.memory.create({data:{class:'system',appId:app.id,organizationId:app.organizationId,ownerUserId:app.ownerUserId,isInstallMemory:true,installOfAgentId:agent.id,name:`Install ${i}`,urn:state==='org-app'?`diagnostic3638.test:install-${i}`:`@diagnostic3638-owner:install-${i}`}});
   agents.push(agent);
  }
  await serveAgentBootPrompt(db,agents[0].id,'Synthetic measured prompt.');
  const userId=state==='userless'?undefined:state==='outsider'?viewer.id:owner.id;
  const ctx:Context={db:logged,userId,roles:['READER'],...(state==='userless'?{appId:app.id}:{} )};
  const licence=state!=='owner-revoked';
  const text=licence && state!=='outsider' && state!=='userless';
  const admitted=state==='org-app'||state==='public'||text;
  const shape=`${state}/${count}-agents`;
  const paths: Array<[string,()=>Promise<string>]> = [
   ['licence-helper',async()=>{const values=await Promise.all(agents.map(a=>personalOrgAgentLicenseHolds(logged,app,a.id))); expect(values).toEqual(agents.map(()=>licence)); return `${values.filter(Boolean).length}/${count}`;}],
   ['text-helper',async()=>{const values=await Promise.all(agents.map(a=>personalOrgAgentTextAllowed(logged,app,a.id,userId))); expect(values).toEqual(agents.map(()=>admitted)); return `${values.filter(Boolean).length}/${count}`;}],
   ['installed-licence',async()=>{const values=await Promise.all(agents.map(a=>isAgentInstalledAndLicensed(logged,app.id,a.id)));expect(values).toEqual(agents.map(()=>licence));return `${values.filter(Boolean).length}/${count}`;}],
   ['app-memory-candidates',async()=>{const map=await getAppMemoryCandidates(logged,app.id,{allAgents:true,callerUserId:userId}); const n=agents.filter(a=>map.has(a.systemMemoryId!)).length;expect(n).toBe(admitted?count:0);return `${n}/${count} definitions`;}],
   ['readable-install-memories',async()=>{const ids=await readableInstallMemoryIds(logged,ctx);expect(ids.length).toBe(userId&&admitted?count:0);return `${ids.length} installs`;}],
   ['participant-system-folds',async()=>{const folds=await participantSystemMemoryFolds(logged,ctx);const ids=new Set(folds.flatMap(f=>[...f.map.keys()]));const n=agents.filter(a=>ids.has(a.systemMemoryId!)).length;expect(n).toBe(userId&&admitted?count:0);return `${n}/${count} definitions`;}],
   ['chat-carrier-apps',async()=>{const apps=await chatCarrierApps(ctx,agents[0].id);expect(apps.length).toBe(admitted?1:0);return `${apps.length} apps`;}],
   ['serve-chat-prompt',async()=>{try {const result=await serveChatPrompt(logged,agents[0],app.id,null,ctx);expect(admitted).toBe(true);expect(result.text).toBe('Synthetic measured prompt.');return 'served';}catch(error){if(admitted)throw error;expect((error as any).extensions?.code??(error as any).code).toBe('AGENT_NOT_FOUND');return 'AGENT_NOT_FOUND';}}],
   ['boot-serve-preview',async()=>{const out=await previewServedBootPrompt(logged,{surface:'bind',appId:app.id,agent:{id:agents[0].id,name:agents[0].name}});expect(out.refusal).toBe(licence?null:'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE');return out.refusal??'served';}],
  ];
  for (const [path,run] of paths) for (const repeat of ['first','same-context-repeat']) await measure(shape,path,repeat,run);
 }
 expect(observations.length-start, 'complete six-state fixed roster for this Agent count').toBe(108);
 // Output is diagnostic evidence: no approved numeric baseline/ceiling assertions.
 if(process.env.HADRON_3638_ARTIFACT) writeFileSync(process.env.HADRON_3638_ARTIFACT,JSON.stringify({
  productionSource:execFileSync('git',['merge-base','HEAD','origin/main'],{encoding:'utf8'}).trim(),harnessRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),postgresVersion,prismaVersion:'6.19.2',harnessSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL('../../../test/diagnostics/queryCount3638.ts',import.meta.url))).digest('hex'),complete:observations.length===217,expectedObservationCount:217,fixedWorkload:'6 states x 1/3 Agents x 9 paths x first/repeat; synthetic physical installs, one App',
  definitions:{sqlCount:'dedicated Prisma query events inside span; setup and named drain barrier excluded; includes transaction statements',tables:'statements mentioning each FROM/JOIN/UPDATE/INTO quoted table; overlaps not additive',repeat:'same explicit Context/client, not HTTP request or pooled-session/cache benchmark'},observations,
 },null,2));
});
