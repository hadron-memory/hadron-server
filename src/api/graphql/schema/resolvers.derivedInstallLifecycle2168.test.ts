/** #2168 shared derived-install lifecycle. Pins supplied by Brooks during
 * #3435 scaffolding; folded here before freeze. Public projection stays #3435.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { parse, Kind } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { listAppInstallations, loadAppInstallationPage, loadUnfilteredAppInstallationPage } from '../../../lib/appInstallations.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
const M = resolvers.Mutation as any;
const T = (n: number) => new Date(Date.UTC(2026, 0, n));
let user: { id: string }, org: { id: string }, app: { id: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] });
const agent = (name: string) => M.createAgent({}, { orgId: org.id, name, personaRole: name.toLowerCase() }, ctx());
async function grant(agentId: string) {
  await db.agentOrgGrant.upsert({
    where: { orgId_agentId: { orgId: org.id, agentId } },
    create: { orgId: org.id, agentId, activatedAt: new Date(), revokedAt: null },
    update: { activatedAt: new Date(), revokedAt: null },
  });
}
async function importEdge(parentId: string, childId: string, createdAt: Date) {
  await grant(childId);
  return db.agentImport.create({
    data: { parentAgentId: parentId, importedAgentId: childId, position: 100, required: true, agentOrgGrantOrgId: org.id, agentOrgGrantAgentId: childId, createdAt },
  });
}
const roster = () => (resolvers.App as any).appAgents(app, {}, ctx()) as Promise<any[]>;
const entry = async (agentId: string) => (await roster()).find((r) => r.agentId === agentId);

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Install method', urn: `im-${generateId().toLowerCase()}.example` } });
  user = await db.user.create({ data: { handle: `im-${generateId()}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Install method', urn: `im-${generateId().toLowerCase()}.example:team` } });
});

it('a derived entry has null audit fields, and the earliest across importers of the later of (install, import) as createdAt', async () => {
  const [a, c, b] = [await agent('Alpha'), await agent('Gamma'), await agent('Beta')];
  // Alpha installed late (day 5), its import is early (day 1): later = day 5.
  // Gamma installed on day 3, its import is on day 2: later = day 3. The earliest across the two importers is day 3.
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdAt: T(5), createdBy: user.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: c.id, createdAt: T(3), createdBy: user.id } });
  await importEdge(a.id, b.id, T(1));
  await importEdge(c.id, b.id, T(2));
  const derived = await entry(b.id);
  expect(derived).toBeTruthy();
  expect(derived.createdBy).toBeNull();
  expect(derived.updatedAt).toBeNull();
  expect(derived.updatedBy).toBeNull();
  expect(derived.createdAt.toISOString()).toBe(T(3).toISOString());
  // Not the first importer's value (day 5) and not the import dates alone (day 1): the earliest of the laters.
  expect(derived.createdAt.toISOString()).not.toBe(T(5).toISOString());
});

it('one importer: createdAt is the later of its install and the import (both orders)', async () => {
  for (const [install, imported, want] of [[2, 4, 4], [6, 4, 6]] as const) {
    await cleanDb(db);
    org = await db.organization.create({ data: { name: 'Install method', urn: `im-${generateId().toLowerCase()}.example` } });
    user = await db.user.create({ data: { handle: `im-${generateId()}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
    app = await db.app.create({ data: { organizationId: org.id, name: 'Install method', urn: `im-${generateId().toLowerCase()}.example:team` } });
    const [a, b] = [await agent('Alpha'), await agent('Beta')];
    await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdAt: T(install) } });
    await importEdge(a.id, b.id, T(imported));
    expect((await entry(b.id)).createdAt.toISOString()).toBe(T(want).toISOString());
  }
});

it.each(['source', 'roster'] as const)('a physical row wins over a simultaneous import in the %s listing', async (surface) => {
  const [a, b] = [await agent('Alpha'), await agent('Beta')];
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdAt: T(1) } });
  await importEdge(a.id, b.id, T(2));
  const physical = await db.appAgent.create({
    data: { appId: app.id, agentId: b.id, createdAt: T(5), createdBy: user.id },
  });
  // Keep both witnesses live: checking only after import removal cannot kill
  // the duplicate DERIVED entry produced when the physical-precedence guard goes.
  const rows = surface === 'source' ? await listAppInstallations(db, app.id) : await roster();
  const matches = rows.filter(row => row.agentId === b.id);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({
    installationKind: 'ROW', importerAgentId: null,
    createdAt: physical.createdAt, createdBy: user.id,
  });
  expect(await db.agentImport.count({ where: { parentAgentId: a.id, importedAgentId: b.id } })).toBe(1);
});

it('after the import is removed the derived entry leaves the listing; the importer stays', async () => {
  const [a, b] = [await agent('Alpha'), await agent('Beta')];
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
  await importEdge(a.id, b.id, T(2));
  expect(await entry(b.id)).toBeTruthy();
  await db.agentImport.deleteMany({});
  expect(await entry(b.id)).toBeUndefined();
  expect(await entry(a.id)).toBeTruthy();
});

it('uninstall against a still-derived entry has no row to delete and writes nothing, register rows included', async () => {
  const [a, b] = [await agent('Alpha'), await agent('Beta')];
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
  await importEdge(a.id, b.id, T(2));
  const memory = await db.memory.create({
    data: { organizationId: org.id, urn: `${org.id}:reg`, name: 'reg', class: 'app', appId: app.id, sharedMemoryOfAgentId: a.id },
  });
  const ch = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id })).channel;
  // The default Channel's register already seats the derived Agent (#2168); create it only if a fixture change drops that.
  const reg =
    (await db.registerEntry.findFirst({ where: { appId: app.id, channelId: ch.id, attendeeAgentId: b.id, deletedAt: null } })) ??
    (await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: ch.id, attendeeAgentId: b.id, role: 'BOTH' } }));
  const rowsBefore = await db.appAgent.count();
  // The mutation is an idempotent delete by row: it answers (no refusal for a readable agent), but the agent is
  // STILL installed by derivation, so nothing may be removed, and the App's own register rows naming it stay live.
  await M.uninstallAgentFromApp({}, { appRef: app.id, agentRef: b.id }, ctx());
  expect(await db.appAgent.count()).toBe(rowsBefore);
  expect(await entry(b.id)).toBeTruthy();
  expect((await db.registerEntry.findUniqueOrThrow({ where: { id: reg.id } })).deletedAt).toBeNull();
});

it('an explicit install gives a row that survives the import removal; uninstall then addresses that row', async () => {
  const [a, b] = [await agent('Alpha'), await agent('Beta')];
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
  await importEdge(a.id, b.id, T(2));
  await M.installAgentIntoApp({}, { appRef: app.id, agentRef: b.id }, ctx());
  await db.agentImport.deleteMany({});
  const rowEntry = await entry(b.id);
  expect(rowEntry).toBeTruthy();
  expect(await db.appAgent.count({ where: { appId: app.id, agentId: b.id } })).toBe(1);
  await M.uninstallAgentFromApp({}, { appRef: app.id, agentRef: b.id }, ctx());
  expect(await db.appAgent.count({ where: { appId: app.id, agentId: b.id } })).toBe(0);
});

async function registerFixture(attendee: string, sharedBy: string) {
  const memory = await db.memory.create({
    data: { organizationId: org.id, urn: `${org.id}:reg${generateId()}`, name: 'reg', class: 'app', appId: app.id, sharedMemoryOfAgentId: sharedBy },
  });
  const ch = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id })).channel;
  return (
    (await db.registerEntry.findFirst({ where: { appId: app.id, channelId: ch.id, attendeeAgentId: attendee, deletedAt: null } })) ??
    (await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: ch.id, attendeeAgentId: attendee, role: 'BOTH' } }))
  );
}

it('uninstalling a row-installed Agent that nothing imports still removes the App-owned register rows naming it', async () => {
  const a = await agent('Alpha');
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
  const reg = await registerFixture(a.id, a.id);
  await M.uninstallAgentFromApp({}, { appRef: app.id, agentRef: a.id }, ctx());
  expect(await db.appAgent.count({ where: { appId: app.id, agentId: a.id } })).toBe(0);
  expect((await db.registerEntry.findUniqueOrThrow({ where: { id: reg.id } })).deletedAt).not.toBeNull();
});

it('removing the row of an Agent that is also derived keeps it installed: its register rows stay', async () => {
  const [a, b] = [await agent('Alpha'), await agent('Beta')];
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: b.id } }); // explicit row for B ...
  await importEdge(a.id, b.id, T(2)); // ... and A imports B
  const reg = await registerFixture(b.id, a.id);
  await M.uninstallAgentFromApp({}, { appRef: app.id, agentRef: b.id }, ctx());
  expect(await db.appAgent.count({ where: { appId: app.id, agentId: b.id } })).toBe(0);
  expect(await entry(b.id)).toBeTruthy(); // now DERIVED
  expect((await db.registerEntry.findUniqueOrThrow({ where: { id: reg.id } })).deletedAt).toBeNull();
});

it('ruling A keeps the installation discriminator internal until the whole-App gated companion', () => {
  const definitions = parse(typeDefs).definitions;
  expect(definitions.some(d => 'name' in d && d.name?.value === 'AppAgentInstallationKind')).toBe(false);
  const appAgent = definitions.find(d => d.kind === Kind.OBJECT_TYPE_DEFINITION && d.name.value === 'AppAgent');
  expect(appAgent?.kind).toBe(Kind.OBJECT_TYPE_DEFINITION);
  if (appAgent?.kind !== Kind.OBJECT_TYPE_DEFINITION) return;
  expect(appAgent.fields?.some(f => f.name.value === 'installationKind')).toBe(false);
});

it('an empty held-import set cannot admit a later edge in the witness-restricted re-read', async () => {
  const [a,b] = [await agent('Alpha'),await agent('Beta')];
  await db.appAgent.create({data:{appId:app.id,agentId:a.id}});
  await importEdge(a.id,b.id,T(2));
  expect((await listAppInstallations(db,app.id)).map(row=>row.agentId)).toContain(b.id);
  const {installations} = await loadUnfilteredAppInstallationPage(db,app.id,false,undefined,{rows:[a.id],imports:[]});
  expect(installations.map(row=>row.agentId)).toEqual([a.id]);
});

it('uninstall holds the surviving import witness until its register decision commits', async () => {
  const [a,b] = [await agent('Alpha'),await agent('Beta')];
  await db.appAgent.create({data:{appId:app.id,agentId:a.id}});
  await importEdge(a.id,b.id,T(2));
  const reg = await registerFixture(b.id,a.id);
  let release!:()=>void, ready!:()=>void;
  const held = new Promise<void>(r=>{release=r;});
  const staged = new Promise<void>(r=>{ready=r;});
  let writerPid=0,paused=false;
  const hooked = new Proxy(db,{get(target,key){
    if(key==='$transaction') return (work:any,options:any)=>db.$transaction(async tx=>{
      const wrapped=new Proxy(tx,{get(transaction,model){
        if(model==='app') return new Proxy(tx.app,{get(delegate,method){
          if(method==='findMany') return async(args:any)=>{
            const result=await tx.app.findMany(args);
            if(!paused && args.select?.appAgents){
              paused=true; writerPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;
              ready();await held;
            }
            return result;
          };
          const value=Reflect.get(delegate,method,delegate);return typeof value==='function'?value.bind(delegate):value;
        }});
        const value=Reflect.get(transaction,model,transaction);return typeof value==='function'?value.bind(transaction):value;
      }});return work(wrapped);
    },options);
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const uninstall=M.uninstallAgentFromApp({}, {appRef:app.id,agentRef:b.id},{...ctx(),db:hooked});
  await Promise.race([staged,uninstall.then(()=>{throw new Error('uninstall did not reach the deciding read');})]);
  let removerPid=0;
  const removing=db.$transaction(async tx=>{
    removerPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;
    await tx.agentImport.deleteMany({where:{parentAgentId:a.id,importedAgentId:b.id}});
  },{timeout:15000});
  try {
    await vi.waitFor(async()=>{
      expect(removerPid).toBeGreaterThan(0);
      const rows=await db.$queryRaw<Array<{blocked:boolean}>>`SELECT ${writerPid}=ANY(pg_blocking_pids(${removerPid}::int)) AS blocked`;
      expect(rows[0].blocked).toBe(true);
    },{timeout:5000,interval:10});
  } finally {release();await Promise.all([uninstall,removing]);}
  expect((await db.registerEntry.findUniqueOrThrow({where:{id:reg.id}})).deletedAt).toBeNull();
}, 30000);

it('a deleted imported Agent leaves both installation source and roster',async()=>{
  const [a,b]=[await agent('Alpha'),await agent('Beta')];
  await db.appAgent.create({data:{appId:app.id,agentId:a.id}});
  await importEdge(a.id,b.id,T(2));
  expect((await listAppInstallations(db,app.id)).some(row=>row.agentId===b.id)).toBe(true);
  await db.agent.update({where:{id:b.id},data:{deletedAt:new Date()}});
  expect((await listAppInstallations(db,app.id)).some(row=>row.agentId===b.id)).toBe(false);
  expect((await roster()).some(row=>row.agentId===b.id)).toBe(false);
});
