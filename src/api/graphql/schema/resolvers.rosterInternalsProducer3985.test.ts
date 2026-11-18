/**
 * #3985 — the roster producer's `internalsVisible` comes from `maySeeWorkerInternals`, end to end.
 *
 * The #3865/#3981 pins feed `internalsVisible` straight into the availability projection; nothing drove
 * it from the gate through the producer (`projectTeamRoster` in resolvers.agentTaskMatching.ts), so a
 * producer hard-wired to `true` passed every test. This suite reads `teamRoster` through the GraphQL
 * schema with the gate forced false via a test seam (the #2223 spy pattern), and asserts the USER
 * setter's identity is withheld while the setter KIND and every other availability field stay.
 *
 * Pins BUILT behaviour (#3865 lineage, #3984), not law: no corpus rule yet decides who sees a USER
 * setter's identity (cor:agt:060:02 has no audience split; the cor:dmo:050:11 proposal is unruled).
 * LATENT: every real roster reader passes the gate today (cor:dmo:050:11 keeps teamRoster
 * participant-only), so the forced-false branch is unreachable by a real reader — this is coverage,
 * not an exposure report.
 */

import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import * as workerGate from './resolvers.worker.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const MIN = 60_000;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let mia: { id: string };
let rook: { id: string };
const setAt = new Date(Date.now() - 60 * MIN);
const until = new Date(Date.now() + 120 * MIN);

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Producer', urn: `producer-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 810_000 + n, githubUsername: `pr-admin-${n}`, roles: ['READER'], handle: `pr-admin-${n}` } });
  mia = await db.user.create({ data: { githubId: 820_000 + n, githubUsername: `pr-mia-${n}`, roles: ['READER'], handle: `pr-mia-${n}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `producer-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  rook = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Rook', slug: 'rook', role: 'engineer', heldByUserId: mia.id },
    select: { id: true },
  });
  await db.workerAvailability.create({
    data: { workerId: rook.id, state: 'unavailable', reason: 'other', setAt, until, setBy: 'holder', setByUserId: mia.id } as any,
  });
});

const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());

const query = `query($app: ID!) { teamRoster(appRef: $app) { workers { worker { name }
  availability { state reason until setAt setBy inEffect setByParty { kind name } } } } }`;

async function rookAvailability() {
  const result = await server.executeOperation({ query, variables: { app: app.id } }, { contextValue: ctx(mia.id) });
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  expect(result.body.singleResult.errors).toBeUndefined();
  const rows = (result.body.singleResult.data as any).teamRoster.workers as any[];
  return rows.find((r) => r.worker.name === 'Rook').availability;
}

/** Every availability field a participant reads regardless of the gate (cor:agt:060:02): only the USER identity is withheld. */
const sharedFields = {
  state: 'UNAVAILABLE',
  reason: 'OTHER',
  until: until.toISOString(),
  setAt: setAt.toISOString(),
  setBy: 'HOLDER',
  inEffect: true,
};

describe('#3985 roster producer: internalsVisible is driven by maySeeWorkerInternals (built behaviour, latent)', () => {
  it('control: the gate admits the reader, so the USER setter identity is visible', async () => {
    const spy = vi.spyOn(workerGate, 'maySeeWorkerInternals');
    try {
      const availability = await rookAvailability();
      expect(spy).toHaveBeenCalled();
      expect(availability).toEqual({ ...sharedFields, setByParty: { kind: 'USER', name: expect.any(String) } });
    } finally { spy.mockRestore(); }
  });

  it('the gate forced false withholds the USER setter identity; setter kind and the other fields stay', async () => {
    const spy = vi.spyOn(workerGate, 'maySeeWorkerInternals').mockResolvedValue(false);
    try {
      const availability = await rookAvailability();
      expect(spy).toHaveBeenCalled();
      expect(availability).toEqual({ ...sharedFields, setByParty: null });
    } finally { spy.mockRestore(); }
  });

  it('restoring the gate restores the identity (the seam leaves no residue)', async () => {
    const spy = vi.spyOn(workerGate, 'maySeeWorkerInternals').mockResolvedValue(false);
    expect((await rookAvailability()).setByParty).toBeNull();
    spy.mockRestore();
    expect((await rookAvailability()).setByParty).toMatchObject({ kind: 'USER' });
  });
});
