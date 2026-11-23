/**
 * #4876 (ruling V58, cor:agt:020:04, cor:dmo:070:05): a MALFORMED App ref on the read doors gets the bare
 * `APP_NOT_FOUND` "App not found." an absent ref gets, and the answer never quotes the caller's value (a token
 * pasted into `appRef` must not print back). A database fault still propagates.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError as formatError } from '../formatError.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAppRefConcealed } from '../../../lib/auth/workerRead.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

const CANARY = 'hdr_user_CANARY0123456789abcdef';
const MALFORMED = [CANARY, `  ${CANARY}  `, `hrn:app:${CANARY}`, `a:${CANARY}`, 'hrn:app:', ':'];

async function wire(p: Promise<unknown>): Promise<{ message: string; code: unknown; extra: string[] } | 'NO_ERROR'> {
  try { await p; return 'NO_ERROR'; } catch (e) {
    const err = e instanceof GraphQLError ? e : new GraphQLError((e as Error).message, { originalError: e as Error });
    const f = formatError(err.toJSON() as any, err) as any;
    return { message: f.message, code: f.extensions?.code, extra: Object.keys(f.extensions ?? {}).filter((k) => k !== 'code' && k !== 'stacktrace').sort() };
  }
}
const NOT_FOUND = { message: 'App not found.', code: 'APP_NOT_FOUND', extra: [] };

let org: any, member: any, outsider: any, teamAgent: any, app: any;
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'mf-org', urn: 'mf-org.com' } });
  const mk = (n: number) => db.user.create({ data: { id: generateId(), githubId: 487_600 + n, githubUsername: `mf-${n}`, roles: ['READER'] }, select: { id: true } });
  const admin = await mk(1); outsider = await mk(2); member = await mk(3);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  teamAgent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(admin.id));
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
});

const SURFACES: Array<[string, (c: Context, ref: string) => Promise<unknown>]> = [
  ['teamChatMessages', (c, ref) => Q.teamChatMessages({}, { appRef: ref }, c)],
  ['createTeamChatMessage', (c, ref) => M.createTeamChatMessage({}, { appRef: ref, body: 'hi' }, c)],
  ['workers', (c, ref) => Q.workers({}, { appRef: ref }, c)],
  ['teamRoles', (c, ref) => Q.teamRoles({}, { appRef: ref }, c)],
  ['castWorker', (c, ref) => M.castWorker({}, { appRef: ref, agentRef: teamAgent.id, name: 'Zed' }, c)],
  ['castWorkerPreview', (c, ref) => Q.castWorkerPreview({}, { appRef: ref, agentRef: teamAgent.id, name: 'Zed' }, c)],
];

describe('#4876 a malformed App ref gets the concealed answer, no echo', () => {
  it('premise: the bare resolver throws the typed parse error, and it quotes the value', async () => {
    const caught: unknown[] = [];
    for (const r of MALFORMED) { try { await resolveAppRef(db, r); } catch (e) { caught.push(e); } }
    expect(caught.map((e) => (e as Error)?.constructor?.name)).toContain('UrnNotQualifiedError');
    expect(caught.map((e) => (e as Error).message).join('\n')).toContain('CANARY');
  });
  for (const [surface, call] of SURFACES) {
    for (const who of ['a member', 'an outsider']) {
      it(`${surface}, ${who}: every malformed shape answers the bare unknown-App answer`, async () => {
        const c = ctx(who === 'a member' ? member.id : outsider.id);
        const absent = await wire(call(c, 'mf-org.com:nope'));
        expect(absent).toEqual(NOT_FOUND);
        for (const r of MALFORMED) {
          const got = await wire(call(c, r));
          expect(got).toEqual(NOT_FOUND);
          expect(JSON.stringify(got)).not.toContain('CANARY');
        }
      });
    }
  }
  it('workers by name through worker(ref:, appRef:) already collapses (control)', async () => {
    const got = await wire(Q.worker({}, { ref: 'zed', appRef: CANARY }, ctx(member.id)));
    expect(JSON.stringify(got)).not.toContain('CANARY');
  });
  it('worker(ref:) with an id-shaped ref echoes nothing of a pasted value', async () => {
    for (const r of [generateId(), CANARY]) {
      const got = await wire(Q.worker({}, { ref: r }, ctx(outsider.id)));
      expect(JSON.stringify(got)).not.toContain('CANARY');
    }
  });
});

describe('#4876 the fold stays narrow', () => {
  it('a database fault still propagates, unconcealed', async () => {
    const boom = new Error('connection terminated');
    const faulty = { app: { findFirst: () => { throw boom; } }, urnAlias: {} } as any;
    await expect(resolveAppRefConcealed(faulty, 'mf-org.com:team')).rejects.toBe(boom);
    await expect(resolveAppRefConcealed(faulty, app.id)).rejects.toBe(boom);
  });
  it('a database fault on a real door is not an APP_NOT_FOUND', async () => {
    const faultyCtx = { ...ctx(member.id), db: new Proxy(db, { get: (t, k) => (k === 'app' ? { findFirst: () => { throw new Error('connection terminated'); } } : (t as any)[k]) }) } as Context;
    const got = await wire(Q.workers({}, { appRef: 'mf-org.com:team' }, faultyCtx));
    expect(got).not.toEqual(NOT_FOUND);
  });
});
