/**
 * QA scratch (Cooper, hadron-server#2055 / #2054): real-caller, two-transaction
 * deadlock probe. Committed red-first regression based on Cooper's #2054 QA receipt; timings controlled, callers unchanged. Callers are the production closures
 * (MCP tools via createTestableMcpServer, GraphQL moveNode resolver) on the
 * per-worker disposable test DB; only the observation hook (pause after a named
 * advisory key is granted) wraps db.$transaction.
 *
 * R = root loc, D = R:d. 'r1': hashtext(D) < hashtext(R) (inverted vs loc length);
 * 'r2': hashtext(D) > hashtext(R) (control).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import { generateId } from './id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

function latch() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let admin: { id: string };
let memory: { id: string; urn: string };
let h1 = 0;
const roles = new AsyncLocalStorage<'A'|'B'>();
let backendB = -1;
const hash = async (s: string) => (await db.$queryRaw<Array<{ h: number }>>`SELECT hashtext(${s}) AS h`)[0].h;
const auth = () => ({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` }) as never;
const urn = (loc: string) => `urn:node:${memory.urn}:${loc}`;
const ctx = () => ({ db, userId: admin.id, roles: ['ADMIN'] }) as Context;

async function mkNode(loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc, nodeType: 'info', tags: [], content: loc, ...extra } });
}

// Pause the first transaction that GRANTS the key (h1,h2) after the grant.
let pauseOn: { h2: number; loc: string; granted: ReturnType<typeof latch>; release: ReturnType<typeof latch> } | null = null;
function installHook() {
  const orig = db.$transaction.bind(db);
  vi.spyOn(db, '$transaction').mockImplementation(((work: unknown, opts?: unknown) => {
    if (typeof work !== 'function') return orig(work as never, opts as never);
    return orig(async (tx: any) => {
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      if (roles.getStore() === 'B') backendB = pid;
      const proxied = new Proxy(tx, {
        get(target, prop) {
          const v = Reflect.get(target, prop);
          if (prop !== '$executeRaw') return typeof v === 'function' ? v.bind(target) : v;
          return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const result = await target.$executeRaw(strings, ...values);
            const p = pauseOn;
            if (p && /pg_advisory_xact_lock/.test(strings.join(''))) {
              const hit = typeof values[0] === 'string' ? values[1] === p.loc && values[0] === memory.id : values[0] === h1 && values[1] === p.h2;
              if (hit) { pauseOn = null; p.granted.resolve(); await p.release.promise; }
            }
            return result;
          };
        },
      });
      return (work as (t: unknown) => Promise<unknown>)(proxied);
    }, opts as never);
  }) as never);
}

async function waiterOn(h2: number, other: number, timeoutMs = 8000): Promise<number> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rows = await db.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND pid=${backendB} AND classid=${h1 >>> 0}::bigint::oid
        AND objid IN (${h2 >>> 0}::bigint::oid, ${other >>> 0}::bigint::oid) AND objsubid=2`;
    if (rows.length) return rows[0].pid;
    await sleep(10);
  }
  throw new Error('no waiter on key');
}
async function holds(pid: number, h2: number) {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND granted AND pid=${pid}
      AND classid=${h1 >>> 0}::bigint::oid AND objid=${h2 >>> 0}::bigint::oid AND objsubid=2`;
  return Number(rows[0].n) > 0;
}
const deadlocks = async () => Number((await db.$queryRaw<Array<{ d: bigint }>>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname=current_database()`)[0].d);

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'qa2055', urn: 'qa2055' } });
  admin = await db.user.create({ data: { githubId: 20551, githubUsername: 'qa2055-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'qa2055m' }, ctx());
  h1 = await hash(memory.id);
  installHook();
});

const CASES = [
  { name: 'INVERTED r1 (hash(D) < hash(R))', R: 'r1', expectInverted: true },
  { name: 'CONTROL  r2 (hash(D) > hash(R))', R: 'r2', expectInverted: false },
];

async function run(label: string, R: string, startA: () => Promise<unknown>, startB: () => Promise<unknown>, D: string) {
  const hR = await hash(R); const hD = await hash(D);
  backendB=-1;
  const before = await deadlocks();
  const granted = latch(); const release = latch();
  pauseOn = { h2: hR, loc: R, granted, release };
  const a = Promise.allSettled([roles.run('A', startA)]);
  await Promise.race([granted.promise, sleep(8000).then(()=>{throw new Error('A did not grant root');})]); // A holds R, has not asked for anything after it
  const b = Promise.allSettled([roles.run('B', startB)]);
  // B must be queued behind A on R; record whether it already holds D.
  let bHoldsD = false; let observationError: unknown;
  try { const pidB = await waiterOn(hR, hD); bHoldsD = await holds(pidB, hD); }
  catch (error) { observationError=error; }
  finally { release.resolve(); }
  const [ra] = await a; const [rb] = await b;
  if(observationError) throw observationError;
  const dl = (await deadlocks()) - before;
  return { dl, bHoldsD, hD, hR, ra, rb };
}

describe.each(CASES)('$name', ({ R, expectInverted }) => {
  const D = `${R}:d`;
  it.each([false,true])('S1: MCP create/upsert (tombstone=%s) versus MCP move', async (upsert) => {
    if(upsert) await mkNode(D, {deletedAt:new Date(),deletedBy:admin.id});
    await mkNode('xsrc1');
    const A = createTestableMcpServer(auth()); const B = createTestableMcpServer(auth());
    const res = await run('S1', R,
      () => A.callToolText('hadron_create_node', { urn: urn(D), name: 'D', content: 'from create' }),
      () => B.callToolText('hadron_move_node', { urn: urn('xsrc1'), targetUrn: urn(D) }), D);
    expect(res.hD < res.hR).toBe(expectInverted);
    expect(res.dl, "real callers must not deadlock").toBe(0);
    expect(res.ra.status).toBe("fulfilled");
    expect(res.rb.status).toBe("fulfilled");
    if (res.ra.status === 'fulfilled') expect(String(res.ra.value)).not.toMatch(/internal_server_error|deadlock|40P01/i);
    if (res.rb.status === 'fulfilled') expect(String(res.rb.value)).toContain('URN_ALREADY_EXISTS:');
    expect(await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: D, memoryId: memory.id } } })).toMatchObject({ content: 'from create', deletedAt: null });
    expect(await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'xsrc1', memoryId: memory.id } } })).toMatchObject({ deletedAt: null });
  }, 60_000);

  it('S2: MCP hadron_move_node onto tombstone R (archiveTombstone, live descendant D) vs GraphQL moveNode D->q', async () => {
    await mkNode(R, { deletedAt: new Date(), deletedBy: admin.id });
    const d = await mkNode(D);
    await mkNode('xsrc2');
    const A = createTestableMcpServer(auth());
    const res = await run('S2', R,
      () => A.callToolText('hadron_move_node', { urn: urn('xsrc2'), targetUrn: urn(R), overwrite: true }),
      () => resolvers.Mutation.moveNode(null, { sourceRef: d.id, targetUrn: urn('qdest') }, ctx()), D);
    expect(res.hD < res.hR).toBe(expectInverted);
    expect(res.dl, "real callers must not deadlock").toBe(0);
    expect(res.ra.status).toBe("fulfilled");
    expect(res.rb.status).toBe("fulfilled");
    if (res.ra.status === 'fulfilled') expect(String(res.ra.value)).not.toMatch(/internal_server_error|deadlock|40P01/i);
    expect((await db.node.findUniqueOrThrow({ where: { id: d.id } })).loc).toBe('qdest');
    expect(await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: R, memoryId: memory.id } } })).toMatchObject({ content: 'xsrc2', deletedAt: null });
  }, 60_000);
  it('S3: reserveSpecCitation tombstone with live child versus GraphQL move',async()=>{
    await mkNode(R,{deletedAt:new Date(),deletedBy:admin.id});
    const d=await mkNode(D);
    const res=await run('S3',R,
      ()=>resolvers.Mutation.reserveSpecCitation({}, {memoryRef:memory.id,loc:R},ctx()),
      ()=>resolvers.Mutation.moveNode(null,{sourceRef:d.id,targetUrn:urn('reserve-dest')},ctx()),D);
    expect(res.hD < res.hR).toBe(expectInverted);
    expect(res.dl,'reserve callers must not deadlock').toBe(0);
    expect(res.ra.status).toBe('fulfilled'); expect(res.rb.status).toBe('fulfilled');
    expect((await db.node.findUniqueOrThrow({where:{id:d.id}})).loc).toBe('reserve-dest');
    expect((await db.node.findUniqueOrThrow({where:{loc_memoryId:{loc:R,memoryId:memory.id}}})).isPlaceholder).toBe(true);
  },60000);

});