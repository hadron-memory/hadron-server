import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1742 — the worker surfaces must not tell a caller who cannot READ an App
 * whether a worker of that App exists.
 *
 * Every surface resolves a `workerRef` to its row and then gates the row's App.
 * Before the fix, an unreadable App refused FORBIDDEN while an absent worker
 * refused WORKER_NOT_FOUND, so guessing a name and reading the code enumerated
 * another tenant's roster (Chip's repro, Cameron's live confirmation). Now a
 * caller who cannot read the App gets the absent worker's answer exactly:
 * same code, same message, same extensions. FORBIDDEN stays for a caller who
 * CAN read the App and is refused the change itself, because that caller
 * already sees the roster.
 *
 * The same-ref pins compare one ref before and after its worker is deleted, so
 * "identical" covers every byte of the envelope, the echoed ref included.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

type Envelope = { message: string; extensions: Record<string, unknown> } | 'NO_ERROR';

/** The refusal as a client sees it: message plus extensions (stacktrace is a dev-only Apollo addition). */
async function envelopeOf(p: Promise<unknown>): Promise<Envelope> {
  try {
    await p;
    return 'NO_ERROR';
  } catch (e) {
    if (!(e instanceof GraphQLError)) throw e;
    return { message: e.message, extensions: { ...e.extensions } };
  }
}

let org: { id: string; urn: string };
let otherOrg: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let reader: { id: string };
let outsider: { id: string };
let foreignContributor: { id: string };
let teamAgent: { id: string };
let app: { id: string; urn: string };
let foreignApp: { id: string; urn: string };
let dan: { id: string };

async function user(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 97_420 + n, githubUsername: `wo-${n}`, roles: ['READER'] }, select: { id: true } });
}
async function worker(appId: string, name: string) {
  return db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: teamAgent.id, name, slug: name.toLowerCase() }, select: { id: true } });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'wo-org', urn: 'wo-org.com' } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'wo-other', urn: 'wo-other.com' } });
  admin = await user(1);
  member = await user(2);
  reader = await user(3);
  outsider = await user(4);
  foreignContributor = await user(5);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: foreignContributor.id, role: 'CONTRIBUTOR' } });
  teamAgent = { id: (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id))).id };
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  foreignApp = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Elsewhere', urn: `${otherOrg.urn}:elsewhere` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'reader' } });
  dan = await worker(app.id, 'Dan');
});

const danUrn = () => `hrn:worker:${org.urn}:team:dan`;
const nobodyUrn = () => `hrn:worker:${org.urn}:team:nobody`;

/** Every worker surface that takes a ref, as one call each. */
const SURFACES: Array<[string, (c: Context, ref: string) => Promise<unknown>]> = [
  ['retireWorker', (c, ref) => M.retireWorker({}, { workerRef: ref }, c)],
  ['setWorkerReportsTo', (c, ref) => M.setWorkerReportsTo({}, { workerRef: ref, reportsTo: null }, c)],
  ['releaseWorker', (c, ref) => M.releaseWorker({}, { workerRef: ref }, c)],
  ['updateWorker', (c, ref) => M.updateWorker({}, { workerRef: ref, promptOverride: 'x' }, c)],
  ['deleteWorker', (c, ref) => M.deleteWorker({}, { workerRef: ref }, c)],
  ['Query.worker', (c, ref) => Q.worker({}, { ref }, c)],
];

/** Principals who cannot read the App: no membership, another org's contributor, another App's key. */
const OUTSIDERS: Array<[string, () => Context]> = [
  ['a signed-in user with no membership', () => ctx(outsider.id)],
  ["another org's CONTRIBUTOR", () => ctx(foreignContributor.id)],
  ["another App's key", () => ({ db, roles: [], appId: foreignApp.id } as Context)],
];

/**
 * #1149 (cor:dmo:050:11): `Query.worker` by id or URN opens a worker's PROFILE
 * to any signed-in user, so for that surface the caller who cannot know about
 * the worker is one the profile gate refuses: anonymous, or another App's key.
 * Every other surface keeps the participant gate and the signed-in outsider.
 */
const anonymous = (): Context => ({ db, roles: [] } as Context);
const outsiderFor = (surface: string): Context => (surface === 'Query.worker' ? anonymous() : ctx(outsider.id));
const SIGNED_IN = new Set(['a signed-in user with no membership', "another org's CONTRIBUTOR"]);

describe('#1742 the oracle is closed: an unreadable App answers like an absent worker', () => {
  for (const [surface, call] of SURFACES) {
    for (const [who, as] of OUTSIDERS) {
      if (surface === 'Query.worker' && SIGNED_IN.has(who)) {
        it(`${surface}, ${who}: reads the profile instead (#1149)`, async () => {
          expect(((await call(as(), danUrn())) as { id: string }).id).toBe(dan.id);
          expect(await envelopeOf(call(as(), nobodyUrn())))
            .toEqual({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef: nobodyUrn() } });
        });
        continue;
      }
      it(`${surface}, ${who}: a real name and a guessed one get the same refusal`, async () => {
        const real = await envelopeOf(call(as(), danUrn()));
        const guessed = await envelopeOf(call(as(), nobodyUrn()));
        expect(guessed).toEqual({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef: nobodyUrn() } });
        // The only difference is the echoed ref, which the caller supplied.
        expect(real).toEqual({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef: danUrn() } });
      });
    }

    it(`${surface}: the same ref answers byte-identically before and after its worker is deleted`, async () => {
      const before = await envelopeOf(call(outsiderFor(surface), danUrn()));
      await db.worker.delete({ where: { id: dan.id } });
      const after = await envelopeOf(call(outsiderFor(surface), danUrn()));
      expect(JSON.stringify(before)).toBe(JSON.stringify(after));
    });

    it(`${surface}: the id form is closed too`, async () => {
      const real = await envelopeOf(call(outsiderFor(surface), dan.id));
      const absentId = generateId();
      const absent = await envelopeOf(call(outsiderFor(surface), absentId));
      expect(real).toEqual({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef: dan.id } });
      expect(absent).toEqual({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef: absentId } });
    });
  }

  it("a soft-deleted App's worker answers like an absent one, even to its former participant", async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    for (const [, call] of SURFACES) {
      expect(await envelopeOf(call(ctx(member.id), danUrn())))
        .toEqual({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef: danUrn() } });
    }
  });

  it('nothing is written for a refused outsider', async () => {
    for (const [, call] of SURFACES) await envelopeOf(call(ctx(outsider.id), danUrn()));
    const row = await db.worker.findUniqueOrThrow({ where: { id: dan.id } });
    expect(row.retiredAt).toBeNull();
    expect(row.promptOverride).toBeNull();
  });
});

describe('#1742 controls: readers keep their answers', () => {
  it('a reader of the App is still refused a staff change with FORBIDDEN, which tells them nothing new', async () => {
    for (const call of [
      (c: Context) => M.retireWorker({}, { workerRef: danUrn() }, c),
      (c: Context) => M.updateWorker({}, { workerRef: danUrn(), promptOverride: 'x' }, c),
      (c: Context) => M.deleteWorker({}, { workerRef: danUrn() }, c),
    ]) {
      const env = await envelopeOf(call(ctx(reader.id)));
      expect(env).not.toBe('NO_ERROR');
      expect((env as Exclude<Envelope, 'NO_ERROR'>).extensions.code).toBe('FORBIDDEN');
    }
  });

  it('a participant still resolves the worker, and an absent one is still WORKER_NOT_FOUND', async () => {
    expect((await Q.worker({}, { ref: danUrn() }, ctx(member.id))).id).toBe(dan.id);
    expect(await envelopeOf(Q.worker({}, { ref: nobodyUrn() }, ctx(member.id))))
      .toEqual({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef: nobodyUrn() } });
  });

  it('a staffer still makes the change', async () => {
    await M.retireWorker({}, { workerRef: danUrn() }, ctx(admin.id));
    expect((await db.worker.findUniqueOrThrow({ where: { id: dan.id } })).retiredAt).not.toBeNull();
  });

  it('an outage inside the read gate propagates; it is never reported as a missing worker', async () => {
    const down = () => { throw new Error('database unavailable'); };
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'appMember' || prop === 'orgMember') return new Proxy({}, { get: () => down });
        return Reflect.get(target, prop, receiver);
      },
    }) as Context['db'];
    for (const [surface, call] of SURFACES) {
      // #1149: the profile gate admits a signed-in user without a membership
      // lookup, so Query.worker's participant arm is driven by a run principal
      // acting for that user, which the profile gate sends to the participant gate.
      const c = surface === 'Query.worker'
        ? ({ db: broken, ...runAuthContext({ id: generateId(), appId: foreignApp.id, userId: outsider.id, organizationId: otherOrg.id }) } as Context)
        : ({ db: broken, userId: outsider.id, roles: ['READER'] } as Context);
      await expect(call(c, danUrn())).rejects.toThrow('database unavailable');
    }
  });
});

describe('#1742 MCP delegates, so its worker tools are closed as well', () => {
  const auth = (userId: string) => ({ userId, roles: ['READER' as const] });
  const tools: Array<[string, (ref: string) => Record<string, unknown>]> = [
    ['hadron_get_worker', (ref) => ({ workerRef: ref })],
    ['hadron_update_worker', (ref) => ({ workerRef: ref, promptOverride: 'x' })],
    ['hadron_set_worker_reports_to', (ref) => ({ workerRef: ref, reportsTo: null })],
  ];
  // #1149: hadron_get_worker reads the PROFILE for any signed-in user
  // (resolvers.workerProfile1149.test.ts), so its outsider is another App's key.
  const outsiderAuth = (tool: string) =>
    tool === 'hadron_get_worker' ? ({ appId: foreignApp.id, roles: [] as const } as never) : auth(outsider.id);
  for (const [tool, args] of tools) {
    it(`${tool}: a real name and a guessed one read the same to an outsider`, async () => {
      const real = await createTestableMcpServer(outsiderAuth(tool)).callToolText(tool, args(danUrn()));
      const guessed = await createTestableMcpServer(outsiderAuth(tool)).callToolText(tool, args(nobodyUrn()));
      expect(real).not.toMatch(/not authorized|forbidden/i);
      expect(real.replace(danUrn(), '<ref>')).toBe(guessed.replace(nobodyUrn(), '<ref>'));
    });
  }
});
