/**
 * #4971 — the NUL / lone-surrogate pre-reject (#2975, `refHasUnstorableChars`) on the ref arms #4893 narrowed
 * but did not guard: workerRef, `worker(ref:)` by name, taskRef, nodeRef and the write-grant register URN —
 * plus direct pins for the agentRef and userRef guards that already exist (Baylor local P3, Celine QA P3).
 *
 * Contract per door: a ref no stored URN can contain answers EXACTLY like a well-formed ref naming nothing
 * (same value, or same message/code/extension keys), and is never a driver fault (`INTERNAL_SERVER_ERROR`).
 * Every row also carries the reaches-resolution control of #4948: with the unstorable ref replaced by the
 * MISS ref and a db that faults on the lookup the door must REJECT, so a row that refuses earlier
 * (argument validation, a gate) cannot pass vacuously.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { formatGraphQLError as formatError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

const NUL = '\u0000';
const HIGH = '\uD800';
const LOW = '\uDC00';
/** Each unstorable shape, spliced into the ref's LAST segment by the row. */
const BAD = [NUL, HIGH, LOW];

type Answer = { ok: true; value: unknown } | { ok: false; message: string; code: unknown; extra: string[] };
async function answer(p: Promise<unknown>): Promise<Answer> {
  try { return { ok: true, value: await p }; } catch (e) {
    const err = e instanceof GraphQLError ? e : new GraphQLError((e as Error).message, { originalError: e as Error });
    const f = formatError(err.toJSON() as any, err) as any;
    return {
      ok: false, message: f.message, code: f.extensions?.code,
      extra: Object.keys(f.extensions ?? {}).filter((k) => k !== 'code' && k !== 'stacktrace').sort(),
    };
  }
}

/** Code and extension keys only: a typed refusal may quote the caller's own ref, so its message is not compared. */
const shapeOf = (a: Answer): unknown => (a.ok ? a : { code: a.code, extra: a.extra });

let org: any, admin: any, member: any, teamAgent: any, app: any, memory: any, worker: any;
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'ur-org', urn: 'ur-org.com' } });
  const mk = (n: number) => db.user.create({ data: { id: generateId(), githubId: 497_100 + n, githubUsername: `ur-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await mk(1); member = await mk(2);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  teamAgent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(admin.id));
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'ur-worker', slug: 'ur-worker' },
  });
  memory = await db.memory.create({
    data: { id: generateId(), name: 'ur-mem', urn: `${org.urn}:ur-mem`, class: 'app', appId: app.id, organizationId: org.id } as never,
  });
});

/** A db whose `target.findFirst/findUnique/findMany` fault: the control that proves a row reaches the lookup. */
const faulting = (table: string): Context['db'] =>
  new Proxy(db as any, {
    get: (t, p) => p === table
      ? new Proxy(t[p], { get: (tt, m) => (typeof m === 'string' && m.startsWith('find') ? () => { throw new Error('driver fault'); } : tt[m]) })
      : t[p],
  });

interface Row {
  door: string;
  call: (ref: string, c: Context) => Promise<unknown>;
  who: () => Context;
  /** The ref with the unstorable code point spliced in. */
  bad: (u: string) => string;
  /** A well-formed ref naming nothing. */
  miss: string;
  /** The db table whose lookup the control makes fault. */
  table: string;
  /** KEEP door (typed boundary contract): the unstorable ref answers as an ordinary malformed ref, not as a miss. */
  keep?: { malformed: string };
}
const wUrn = (slug: string) => `hrn:worker:${org.urn}:team:${slug}`;
const memberCtx = () => ctx(member.id);
const adminCtx = () => ctx(admin.id);

const ROWS = (): Row[] => [
  { door: 'attendeeRegister(workerRef) [workerRef arm]', call: (r, c) => Q.attendeeRegister({}, { workerRef: r }, c), who: memberCtx,
    bad: (u) => wUrn(`ur-worker${u}`), miss: wUrn('nope'), table: 'worker' },
  { door: 'worker(ref:, appRef:) by name [worker(ref:) arm]', call: (r, c) => Q.worker({}, { ref: r, appRef: app.urn }, c), who: memberCtx,
    bad: (u) => `ur-worker${u}`, miss: 'nope-worker', table: 'worker' },
  // The handle grammar admits digits only, so the unstorable code point can only ride in the qualified
  // handle's App part, which resolveAppRef already guards: a regression pin for a door that cannot reach the
  // lookup with one (the control uses a valid App and an absent handle, which does reach `agentTask`).
  { door: 'agentTask(id:) [taskRef arm]', call: (r, c) => Q.agentTask({}, { id: r }, c), who: memberCtx,
    bad: (u) => `hrn:agenttask:${org.urn}:te${u}am:at99`, miss: `hrn:agenttask:${app.urn}:at99`, table: 'agentTask' },
  // KEEP door (resolvers.query.node.ts: "a malformed input propagates as UrnNotQualifiedError rather than masking as
  // not-found"): the typed contract is preserved, never folded to null.
  { door: 'node(ref:) [nodeRef arm, KEEP]', call: (r, c) => Q.node({}, { ref: r }, c), who: memberCtx,
    bad: (u) => `hrn:node:${memory.urn}:no${u}pe`, miss: `hrn:node:${memory.urn}:nope`, table: 'node',
    keep: { malformed: 'hrn:node:nope' } },
  { door: 'setAppMemoryWriteGrant(registerNodeUrn) [register URN arm]',
    call: (r, c) => M.setAppMemoryWriteGrant({}, { appRef: app.urn, memoryRef: memory.urn, prefix: 'pin', registerNodeUrn: r }, c), who: adminCtx,
    bad: (u) => `hrn:node:${memory.urn}:no${u}pe`, miss: 'not-a-node-urn', table: 'appMemoryWriteGrant' },
  // Section 2: the guards that already exist on agentRef / userRef had no pin of their own.
  { door: 'attendeeRegister(agentRef, appRef) [agentRef guard]', call: (r, c) => Q.attendeeRegister({}, { agentRef: r, appRef: app.urn }, c), who: memberCtx,
    bad: (u) => `hrn:agent:${org.urn}:no${u}pe`, miss: `hrn:agent:${org.urn}:nope`, table: 'agent' },
  { door: 'secrets(user owner) [userRef guard]', call: (r, c) => Q.secrets({}, { ownerType: 'user', ownerRef: r }, c), who: memberCtx,
    bad: (u) => `hrn:user:no${u}pe`, miss: 'hrn:user:nope', table: 'user' },
];

describe('#4971 unstorable ref arms: NUL and lone surrogates answer exactly like a ref naming nothing', () => {
  it('premise: the bare worker and node resolvers reach the database with an unstorable ref today', async () => {
    // Not an assertion about the fix: it records that the lookups, not the grammar, are what the guard protects.
    await expect(resolveWorkerRef(db, wUrn('nope'))).rejects.toMatchObject({ name: 'WorkerNotFoundError' });
    await expect(resolveNodeRef(db, `${memory.urn}:nope`)).rejects.toMatchObject({ name: 'NodeNotFoundError' });
  });

  for (const row of [0, 1, 2, 3, 4, 5, 6]) {
    const name = () => ROWS()[row]!.door;
    for (const [i, u] of BAD.entries()) {
      it(`${['NUL', 'lone high surrogate', 'lone low surrogate'][i]}: row ${row}`, async () => {
        const r = ROWS()[row]!;
        const badAns = await answer(r.call(r.bad(u), r.who()));
        expect(name()).toBeTruthy();
        if (!badAns.ok) expect(badAns.code, r.door).not.toBe('INTERNAL_SERVER_ERROR');
        if (r.keep) {
          const plain = await answer(r.call(r.keep.malformed, r.who()));
          expect(plain.ok, `${r.door}: an ordinary malformed ref is the typed refusal`).toBe(false);
          expect(shapeOf(badAns), r.door).toEqual(shapeOf(plain));
        } else {
          expect(badAns, r.door).toEqual(await answer(r.call(r.miss, r.who())));
        }
      });
    }
    it(`control: row ${row} reaches resolution (a lookup fault rejects the MISS ref)`, async () => {
      const r = ROWS()[row]!;
      const c = { ...r.who(), db: faulting(r.table) } as Context;
      const a = await answer(r.call(r.miss, c));
      expect(a.ok, `${r.door} must reach the ${r.table} lookup`).toBe(false);
    });
  }
});
