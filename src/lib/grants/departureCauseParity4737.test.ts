/**
 * #4737 (follow-up of #4180 / hadron-server#4706, Antonio's BLIND delta P2-1 and P2-2, Rodolfo's §10 note): the departure cause list
 * is kept by hand in several places, and the database's cause check ends in `ELSE TRUE`, so a code added to one list and not another
 * would pass silently. These pins read the LIVE database (the CHECK and the functions as applied, not the source file) and the SDL,
 * and assert one set:
 *   * `DEPARTURE_REASONS` per holder kind;
 *   * the SDL enum `GrantHolderDepartureReason`, minus the read-side `REASON_NOT_RECORDED`;
 *   * the codes `chk_grants_shape` admits for each holder kind;
 *   * the codes `hadron_departure_cause_fits` names explicitly. `APP_DELETED` is the one code it does not name: a grantee App's
 *     only cause, judged by the CHECK alone (the `ELSE TRUE` arm). Any other code reaching that arm is the drift this file catches.
 * Then the yield of `hadron_fit_departure_cause` is pinned directly for each kind (user, worker, agent), with its no-yield cases.
 * The worker branch has no door that reaches it today (retireWorker needs the row; a hard delete stamps through the trigger).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Kind, parse, type EnumTypeDefinitionNode } from 'graphql';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { DEPARTURE_REASONS, REASON_NOT_RECORDED } from './departure.js';
import { dropTestActions, seedWorld, type World } from './grantFixtures3668.js';

const KINDS = ['user', 'worker', 'agent', 'app'] as const;
const HOLDER_COLUMN = { user: 'user_id', worker: 'worker_id', agent: 'agent_id', app: 'grantee_app_id' } as const;
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const ALL = sorted(KINDS.flatMap((k) => DEPARTURE_REASONS[k]));

/** The SDL enum's values, from the schema text the server serves. */
function sdlReasons(): string[] {
  const docs = (Array.isArray(typeDefs) ? typeDefs : [typeDefs]).map((t) => (typeof t === 'string' ? parse(t) : t));
  for (const doc of docs) {
    for (const def of doc.definitions) {
      if (def.kind === Kind.ENUM_TYPE_DEFINITION && def.name.value === 'GrantHolderDepartureReason') {
        return ((def as EnumTypeDefinitionNode).values ?? []).map((v) => v.name.value);
      }
    }
  }
  throw new Error('GrantHolderDepartureReason not found in typeDefs');
}

/** The codes the live chk_grants_shape admits, per holder column, parsed from Postgres's own rendering of the constraint. */
async function checkReasonsByColumn(): Promise<Record<string, string[]>> {
  const [{ def }] = await db.$queryRaw<Array<{ def: string }>>(Prisma.sql`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_grants_shape' AND conrelid = 'grants'::regclass`);
  const out: Record<string, string[]> = {};
  // Postgres renders each arm as `(<col> IS NOT NULL) AND (holder_departure_reason = ANY (ARRAY['A'::text, ...]))`, or with a single
  // code as `(holder_departure_reason = 'A'::text)`.
  const arm = /\((\w+) IS NOT NULL\) AND \(holder_departure_reason = (ANY \(ARRAY\[([^\]]*)\]\)|'(\w+)'::text)\)/g;
  for (const m of def.matchAll(arm)) {
    const codes = m[3] !== undefined ? [...m[3].matchAll(/'(\w+)'::text/g)].map((c) => c[1]!) : [m[4]!];
    out[m[1]!] = sorted([...(out[m[1]!] ?? []), ...codes]);
  }
  return out;
}

/** Every quoted code the live hadron_departure_cause_fits names. */
async function fitsReasons(): Promise<string[]> {
  const [{ def }] = await db.$queryRaw<Array<{ def: string }>>(Prisma.sql`
    SELECT pg_get_functiondef('hadron_departure_cause_fits(text,text,text,text)'::regprocedure) AS def`);
  return sorted([...def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!));
}

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('#4737 one set of departure causes, wherever it is written', () => {
  it('the SDL enum is DEPARTURE_REASONS plus the read-side REASON_NOT_RECORDED, nothing else', () => {
    expect(sorted(sdlReasons())).toEqual(sorted([...ALL, REASON_NOT_RECORDED]));
  });

  it('chk_grants_shape admits, for each holder kind, exactly that kind\'s DEPARTURE_REASONS', async () => {
    const byColumn = await checkReasonsByColumn();
    for (const kind of KINDS) {
      expect({ kind, codes: byColumn[HOLDER_COLUMN[kind]] ?? [] }).toEqual({ kind, codes: sorted(DEPARTURE_REASONS[kind]) });
    }
    expect(sorted(Object.keys(byColumn))).toEqual(sorted(Object.values(HOLDER_COLUMN))); // no arm for an unknown column
  });

  it('hadron_departure_cause_fits names every code except APP_DELETED (the one its ELSE TRUE arm is for), and no other', async () => {
    expect(await fitsReasons()).toEqual(ALL.filter((c) => c !== 'APP_DELETED'));
  });

  it('no code is shared between holder kinds (a cause names what happened to ONE kind of holder)', () => {
    const counts = new Map<string, number>();
    for (const kind of KINDS) for (const c of DEPARTURE_REASONS[kind]) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect([...counts].filter(([, n]) => n > 1)).toEqual([]);
  });
});

/** One call of the live yield function. */
async function fit(reason: string | null, userId: string | null, workerId: string | null, agentId: string | null): Promise<string | null> {
  const [{ r }] = await db.$queryRaw<Array<{ r: string | null }>>(Prisma.sql`
    SELECT hadron_fit_departure_cause(${reason}::text, ${userId}::text, ${workerId}::text, ${agentId}::text) AS r`);
  return r;
}
const fits = async (reason: string, userId: string | null, workerId: string | null, agentId: string | null) =>
  (await db.$queryRaw<Array<{ ok: boolean }>>(Prisma.sql`
    SELECT hadron_departure_cause_fits(${reason}::text, ${userId}::text, ${workerId}::text, ${agentId}::text) AS ok`))[0]!.ok;

describe('#4737 hadron_fit_departure_cause yields to what already happened to the holder, per kind', () => {
  it('user: ORG_LEFT / ORG_REMOVED stand for a live person, and yield USER_ERASED for an erased one', async () => {
    for (const r of ['ORG_LEFT', 'ORG_REMOVED']) expect(await fit(r, w.user2Id, null, null)).toBe(r);
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: new Date() } });
    for (const r of ['ORG_LEFT', 'ORG_REMOVED']) expect(await fit(r, w.user2Id, null, null)).toBe('USER_ERASED');
    expect(await fit('USER_ERASED', w.user2Id, null, null)).toBe('USER_ERASED');
  });

  it('worker: WORKER_RETIRED stands while the worker row exists, and yields WORKER_DELETED once it is gone (no door reaches this today)', async () => {
    expect(await fit('WORKER_RETIRED', null, w.workerId, null)).toBe('WORKER_RETIRED');
    const gone = 'w-gone-4737'; // a worker id with no row: the state a hard delete leaves behind
    expect(await fit('WORKER_RETIRED', null, gone, null)).toBe('WORKER_DELETED');
    expect(await fit('WORKER_DELETED', null, gone, null)).toBe('WORKER_DELETED');
  });

  it('agent: every install-loss code stands for a live agent, and yields AGENT_DELETED for a deleted one', async () => {
    const installLoss = DEPARTURE_REASONS.agent.filter((c) => c !== 'AGENT_DELETED');
    for (const r of installLoss) expect(await fit(r, null, null, w.agentId)).toBe(r);
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
    for (const r of installLoss) expect(await fit(r, null, null, w.agentId)).toBe('AGENT_DELETED');
  });

  it('no cause stays no cause (the previous image\'s bare stamp)', async () => {
    expect(await fit(null, w.user2Id, null, null)).toBeNull();
    expect(await fit(null, null, w.workerId, null)).toBeNull();
  });

  it('AGENT_IMPORTER_DELETED (Rodolfo): fits the imported agent while it is live (its importer went), never once the agent itself is deleted', async () => {
    expect(await fits('AGENT_IMPORTER_DELETED', null, null, w.agentId)).toBe(true);
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
    expect(await fits('AGENT_IMPORTER_DELETED', null, null, w.agentId)).toBe(false);
    expect(await fits('AGENT_DELETED', null, null, w.agentId)).toBe(true);
  });
});
