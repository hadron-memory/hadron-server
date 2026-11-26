// #3647 measurement: miscastHasReferences cost on a synthetic large App, private DB (m3647). No production access.
import { db } from './integrations/db/client.js';
import { Prisma } from './generated/prisma/index.js';
import { miscastHasReferences } from './lib/workerMiscastRepair.js';
import { WORKER_SIGNATURE_DEFAULTS } from './lib/workerSignature.js';

const TIERS = (process.env.TIERS ?? '25000,250000,1000000').split(',').map(Number);
const SESSIONS = (process.env.SESSIONS ?? '0,10,100,1000').split(',').map(Number);
const sql = (s: string) => db.$executeRawUnsafe(s);
let have = 0;
let memoryId = '', appId = '', agentId = '', ownerId = '';

async function base() {
  const org = await db.organization.create({ data: { name: 'm3647', urn: 'm3647.example' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'A', urn: 'm3647.example:a', visibility: 'ORGANIZATION' } });
  agentId = agent.id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'm3647.example:team' } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  memoryId = (await db.memory.create({ data: { organizationId: org.id, name: 'Shared', urn: 'm3647.example:shared', class: 'app', appId, sharedMemoryOfAgentId: agentId } })).id;
  ownerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Owner', slug: 'owner', memoryId: null } })).id;
}

async function grow(to: number) {
  const add = to - have;
  const from = have;
  // nodes: 30% carry a small data and properties object (realistic mix), the rest are plain
  await sql(`INSERT INTO nodes (id, memory_id, loc, name, node_type, data, properties, created_at, updated_at)
    SELECT md5('n'||g), '${memoryId}', 'l/'||g, 'n'||g, 'info',
      CASE WHEN g % 10 < 3 THEN jsonb_build_object('title','node '||g,'tags',jsonb_build_array('a','b','c'),'meta',jsonb_build_object('k',g,'v',repeat('x',120))) END,
      CASE WHEN g % 10 < 3 THEN jsonb_build_object('status','open','n',g,'ref',md5(g::text)) END,
      now() - interval '30 days', now() - interval '30 days'
    FROM generate_series(${from + 1}, ${to}) g`);
  // two revisions per node (history), same shape
  await sql(`INSERT INTO node_revisions (id, node_id, loc, name, data, properties, created_at)
    SELECT md5('r'||g||'-'||r), md5('n'||g), 'l/'||g, 'n'||g,
      CASE WHEN g % 10 < 3 THEN jsonb_build_object('title','node '||g,'rev',r,'meta',jsonb_build_object('v',repeat('x',120))) END,
      CASE WHEN g % 10 < 3 THEN jsonb_build_object('status','open','n',g) END, now() - interval '20 days'
    FROM generate_series(${from + 1}, ${to}) g, generate_series(1,2) r`);
  // one team event per node-ish (chain and payload)
  await sql(`INSERT INTO agent_team_events (id, app_id, type, payload, chain, severity, created_at)
    SELECT md5('e'||g), '${appId}', 'task.progress', jsonb_build_object('taskId', md5(g::text), 'note', repeat('y',80)), CASE WHEN g % 10 = 0 THEN jsonb_build_array(md5((g%50)::text)) END, CASE WHEN g % 10 = 0 THEN 'alarm' END, now() - interval '10 days'
    FROM generate_series(${from + 1}, ${to}) g`);
  // one task per 10 nodes
  await sql(`INSERT INTO agent_tasks (id, app_id, task_number, handle, title, requirements, owner_worker_id, created_at)
    SELECT md5('t'||g), '${appId}', g, 'AT'||g, 'task '||g, jsonb_build_object('role','server-engineer'), '${ownerId}', now() - interval '10 days'
    FROM generate_series(${Math.floor(from / 10) + 1}, ${Math.floor(to / 10)}) g`);
  have = to;
  await sql('ANALYZE nodes'); await sql('ANALYZE node_revisions'); await sql('ANALYZE agent_team_events'); await sql('ANALYZE agent_tasks');
  void add;
}

async function newWorker(sessions: number) {
  const tag = Math.random().toString(36).slice(2, 8);
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'W' + tag, slug: 'w' + tag, memoryId: null } });
  if (sessions) {
    await sql(`INSERT INTO sessions (id, worker_id, started_at, ended_at, updated_at)
      SELECT md5('s${tag}'||g), '${w.id}', now() - interval '1 hour', now() - interval '30 minutes', now() - interval '30 minutes' FROM generate_series(1,${sessions}) g`).catch((e) => { throw new Error('session seed: ' + String(e).slice(0, 300)); });
  }
  return db.worker.findUniqueOrThrow({ where: { id: w.id } });
}

const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;

async function main() {
  await base();
  const rows: string[] = [];
  for (const tier of TIERS) {
    await grow(tier);
    for (const s of SESSIONS) {
      const w = await newWorker(s);
      const times: number[] = []; let result: unknown;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        try { result = await miscastHasReferences(db, w); } catch (e) { result = 'ERR ' + String(e).slice(0, 120); break; }
        times.push(performance.now() - t0);
      }
      // the same call inside the delete door's transaction shape: SERIALIZABLE, Prisma's default 5000 ms interactive timeout
      let txOutcome = 'ok'; const t1 = performance.now();
      try { await db.$transaction((tx) => miscastHasReferences(tx, w), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (e: any) { txOutcome = (e?.code ?? 'ERR') + ' ' + String(e?.message ?? e).split('\n').slice(-1)[0]!.slice(0, 90); }
      const line = `nodes=${tier} revs=${tier * 2} events=${tier} tasks=${Math.floor(tier / 10)} sessions=${s} -> result=${String(result)} census_ms(median of ${times.length})=${times.length ? Math.round(med(times)) : 'n/a'} tx_serializable_default_timeout: ${txOutcome} (${Math.round(performance.now() - t1)} ms)`;
      console.log(line); rows.push(line);
      await sql(`DELETE FROM sessions WHERE worker_id='${w.id}'`); await db.worker.delete({ where: { id: w.id } });
    }
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
