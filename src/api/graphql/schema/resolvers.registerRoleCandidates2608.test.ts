import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2198 — typed WARNINGS on task create / assign / reassign / finish, resolved through the App's register.
 *
 * Every shipped code is pinned both ways (fires / does not), the call still succeeds, the register resolves through
 * the right chains, and the carrier keeps aliases apart, caps deterministically and never decorates a failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { taskWarningsPlugin } from '../taskWarningsPlugin.js';
import {
  boundedRead, emitTaskWarnings, renderTaskWarnings, resolveRegisters, shapeResponseWarnings,
  MAX_WARNINGS_PER_OPERATION, MAX_WARNINGS_PER_RESPONSE, type TaskWarning, type TaskWarningCode,
} from './resolvers.taskWarnings.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const hooks: { afterCommit: (() => Promise<void>) | null } = { afterCommit: null };
vi.mock('../../../lib/hostOperations/launch.js', async (orig) => ({
  ...(await orig<typeof import('../../../lib/hostOperations/launch.js')>()),
  launchForAssignment: async (...a: unknown[]) => {
    await hooks.afterCommit?.();
    return (await orig<typeof import('../../../lib/hostOperations/launch.js')>()).launchForAssignment(...(a as [never, never]));
  },
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const pick = (userId = admin.id, code = 'task.finish.open-children', extra = {}) => (resolvers.Query as any).registerRoleCandidates({}, { appRef: app.id, code, ...extra }, ctx(userId));

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string };
let teamAgentId: string;
let teamMemoryId: string;
let teamMemoryUrn: string;
let anne: { id: string };
let liam: { id: string };
let rook: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const asWorker = (w: { id: string }, agentId: string | null, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId }, fn);
const create = (c: Context, input: Record<string, unknown>) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix the widget', source: 'https://example.test/1', ...input } }, c);
const codes = (c: Context) => (c.taskWarnings ?? []).map((w) => w.warning.code);
const worker = (name: string, agentId = teamAgentId) =>
  db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase() }, select: { id: true } });

async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
}
const registerEntry = (memoryId: string, code: string, taskLoc: unknown, entryCode: string = code) =>
  node(memoryId, `register:${code}`, { data: { registerEntry: { code: entryCode, taskLoc } } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw-org', urn: `tw-${suffix}.example` } });
  admin = await db.user.create({ data: { githubId: 218001, githubUsername: 'tw-admin', handle: 'tw-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 218002, githubUsername: 'tw-member', handle: 'tw-member', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 218003, githubUsername: 'tw-out', handle: 'tw-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgentId = agent.id;
  const row = await db.agent.findUniqueOrThrow({ where: { id: teamAgentId } });
  teamMemoryId = row.systemMemoryId as string;
  teamMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: teamMemoryId } })).urn;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgentId } });
  await node(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)
  anne = await worker('Anne');
  liam = await worker('Liam');
  rook = await worker('Rook');
});


async function roleAgent(name:string, parent?:string) {
 const a=await M.createAgent({}, {orgId:org.id,name},ctx(admin.id));
 if(parent)await db.agent.update({where:{id:a.id},data:{extendsAgentId:parent}});
 const row=await db.agent.findUniqueOrThrow({where:{id:a.id}});
 return {id:a.id,memoryId:row.systemMemoryId as string};
}
const mapTask=()=>registerEntry(teamMemoryId,'task.finish.open-children','tasks:finish');
describe('#2608 register role candidates',()=>{
 it('returns every tied nearest candidate, never chooses among ties; child override has depth zero',async()=>{
  await mapTask();const base=await roleAgent('Base');await node(base.memoryId,'tasks:finish',{isRunnable:true});
  const child=await roleAgent('Child',base.id);const own=await roleAgent('Own',base.id);
  await node(own.memoryId,'tasks:finish',{isRunnable:true});
  const inherited=await worker('Inherited',child.id),direct=await worker('Direct',own.id),tie=await worker('Tie',own.id);
  await db.worker.updateMany({where:{id:{in:[direct.id,tie.id]}},data:{role:'qa-engineer'}});
  const r=await pick();expect(r.depth).toBe(0);expect(r.total).toBe(2);
  expect(r.candidates.map((x:any)=>x.worker.id)).toEqual([direct.id,tie.id]);
  expect(r.candidates.map((x:any)=>x.role)).toEqual(['qa-engineer','qa-engineer']);
  expect(r.candidates.every((x:any)=>x.worker.urn&&x.depth===0)).toBe(true);
  await db.worker.updateMany({where:{id:{in:[direct.id,tie.id]}},data:{retired:true}});
  const farther=await pick();expect(farther.depth).toBe(1);expect(farther.candidates[0].worker.id).toBe(inherited.id);
 });
 it('returns empty for unmapped code, missing task and an install-memory-only task',async()=>{
  expect((await pick()).candidates).toEqual([]);await mapTask();
  expect((await pick()).total).toBe(0);
  const install=await db.memory.create({data:{id:generateId(),name:'Install',urn:`${org.urn}:install`,class:'app',appId:app.id,organizationId:org.id}});
  await node(install.id,'tasks:finish',{isRunnable:true});expect((await pick()).candidates).toEqual([]);
 });
 it('omits a second-tenant unreadable agent even when it holds the exact task loc',async()=>{
  await mapTask();const foreignOrg=await db.organization.create({data:{id:generateId(),name:'Foreign',urn:`foreign-${generateId().toLowerCase()}.example`}});
  const owner=await db.user.create({data:{handle:`owner-${generateId()}`}});
  await db.orgMember.create({data:{organizationId:foreignOrg.id,userId:owner.id,role:'ADMIN'}});
  const a=await M.createAgent({}, {orgId:foreignOrg.id,name:'Foreign role'},ctx(owner.id));
  const row=await db.agent.findUniqueOrThrow({where:{id:a.id}});await node(row.systemMemoryId as string,'tasks:finish',{isRunnable:true});
  await worker('Foreign',a.id);expect((await pick()).candidates).toEqual([]);
 });
 it('refuses an App outsider through the roster gate and pages all ties without changing their minimum depth',async()=>{
  await mapTask();await node(teamMemoryId,'tasks:finish',{isRunnable:true});
  await expect(pick(outsider.id)).rejects.toBeTruthy();
  const all=await pick();expect(all.total).toBe(3);const one=await pick(admin.id,undefined,{limit:1});
  expect(one.candidates).toHaveLength(1);expect(one.total).toBe(3);expect(one.depth).toBe(0);
  const rest=await pick(admin.id,undefined,{offset:1,limit:2});expect(rest.candidates).toHaveLength(2);
  expect([...one.candidates,...rest.candidates].map((x:any)=>x.worker.id)).toEqual(all.candidates.map((x:any)=>x.worker.id));
 });
});
