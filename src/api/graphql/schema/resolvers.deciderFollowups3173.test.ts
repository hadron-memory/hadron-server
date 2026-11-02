/** #3173: test-only follow-ups to #3167/#3161; deciders must currently write the log memory. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { canWriteToMemory } from '../../../mcp/access-control.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const refusal = { extensions: { code: 'DECISION_DECIDER_NOT_ELIGIBLE' } };
const input = { title: 'Proceed?', parts: [{ question: 'Proceed?', yesno: true, recommendation: { key: 'yes', reason: 'ready' } }] };
let admin: string, candidate: string, orgId: string, memoryId: string;
const ctx = (client = db): Context => ({ db: client, userId: admin, roles: ['ADMIN'] });
const membership = () => ({ organizationId_userId: { organizationId: orgId, userId: candidate } });
const role = (next: 'READER' | 'CONTRIBUTOR') => db.orgMember.update({ where: membership(), data: { role: next } });
const createLog = (defaultDeciders = [admin], eligibleDeciders: string[] = []) =>
  M.createDecisionLog(null, { memoryRef: memoryId, loc: 'decisions', defaultDeciders, eligibleDeciders }, ctx());
const snapshot = () => db.node.findMany({
  where: { memoryId }, select: { id: true, data: true, revSeq: true, content: true }, orderBy: { id: 'asc' },
});

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { name: 'Decider follow-ups', urn: `decider-${generateId()}.example` } })).id;
  admin = (await db.user.create({ data: { handle: `admin-${generateId()}`, roles: ['ADMIN'] } })).id;
  candidate = (await db.user.create({ data: { handle: `candidate-${generateId()}`, roles: ['ADMIN'] } })).id;
  await db.orgMember.createMany({ data: [
    { organizationId: orgId, userId: admin, role: 'ADMIN' },
    { organizationId: orgId, userId: candidate, role: 'CONTRIBUTOR' },
  ] });
  memoryId = (await M.createMemory(null, { orgId, name: 'Decider follow-ups' }, ctx())).id;
});

describe('#3173 decision-log eligibility follow-ups', () => {
  it('pin 1: defaults-only replacement revalidates the kept eligible list; explicit clear succeeds', async () => {
    const log = await createLog([admin], [candidate]);
    await role('READER');
    const before = await snapshot();
    const args = { logRef: log.row.id, defaultDeciders: [admin], expectedRevision: log.row.revSeq, reason: 'defaults only' };
    await expect(M.setDecisionLogDeciders(null, args, ctx())).rejects.toMatchObject(refusal);
    expect(await snapshot()).toEqual(before);
    const cleared = await M.setDecisionLogDeciders(null, { ...args, eligibleDeciders: [] }, ctx());
    expect(cleared.data.defaultDeciders).toEqual([admin]);
    expect(cleared.data.eligibleDeciders).toEqual([]);
    expect(cleared.row.revSeq).toBe(log.row.revSeq + 1);
  });

  it('pin 3: omitted ask deciders revalidate a demoted stored default; explicit writer succeeds', async () => {
    const log = await createLog([candidate], [admin]);
    await role('READER');
    const before = await snapshot();
    await expect(M.askDecision(null, { logRef: log.row.id, input }, ctx())).rejects.toMatchObject(refusal);
    expect(await snapshot()).toEqual(before);
    const asked = await M.askDecision(null, { logRef: log.row.id, input: { ...input, deciders: [admin] } }, ctx());
    expect(asked.shown.deciders).toEqual([admin]);
    expect(asked.shown.n).toBe(1);
  });

  for (const door of ['create', 'replace'] as const) {
    it(`pin 4: ${door} checks eligibleDeciders as well as defaults`, async () => {
      const log = door === 'replace' ? await createLog() : null;
      await role('READER');
      const before = await snapshot();
      const act = () => door === 'create'
        ? createLog([admin], [candidate])
        : M.setDecisionLogDeciders(null, {
          logRef: log.row.id, defaultDeciders: [admin], eligibleDeciders: [candidate],
          expectedRevision: log.row.revSeq, reason: 'add eligible candidate',
        }, ctx());
      await expect(act()).rejects.toMatchObject(refusal);
      expect(await snapshot()).toEqual(before);
      await role('CONTRIBUTOR');
      const accepted = await act();
      expect(accepted.data.defaultDeciders).toEqual([admin]);
      expect(accepted.data.eligibleDeciders).toEqual([candidate]);
    });
  }

  for (const door of ['create', 'replace', 'ask'] as const) {
    it(`pin 2: ${door} sees transaction-local demotion, not the pooled client's committed writer`, async () => {
      const log = door === 'create' ? null : await createLog([candidate]);
      const before = await snapshot();
      let injected = 0;
      // Test-only client wrapper: actual PostgreSQL transaction and actual canonical write gate.
      // No mocks of eligibility, no timings/lock polling: the two clients deliberately see different authority.
      const client = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== '$transaction') return Reflect.get(target, key, receiver);
          return (fn: (tx: any) => Promise<unknown>, options: any) => target.$transaction(async tx => {
            injected++;
            await tx.orgMember.update({ where: membership(), data: { role: 'READER' } });
            expect(await canWriteToMemory(tx as unknown as Context['db'], { userId: candidate, roles: [] }, memoryId)).toBe(false);
            expect(await canWriteToMemory(db, { userId: candidate, roles: [] }, memoryId)).toBe(true);
            return fn(tx);
          }, options);
        },
      });
      const act = (context = ctx(client)) => door === 'create'
        ? M.createDecisionLog(null, { memoryRef: memoryId, loc: 'decisions', defaultDeciders: [candidate] }, context)
        : door === 'replace'
          ? M.setDecisionLogDeciders(null, {
            logRef: log.row.id, defaultDeciders: [candidate], expectedRevision: log.row.revSeq, reason: 'transaction-local check',
          }, context)
          : M.askDecision(null, { logRef: log.row.id, input }, context);
      await expect(act()).rejects.toMatchObject(refusal);
      expect(injected).toBe(1);
      expect(await snapshot()).toEqual(before);
      expect((await db.orgMember.findUniqueOrThrow({ where: membership() })).role).toBe('CONTRIBUTOR');
      // The refusal rolled back the synthetic demotion; the same operation can now succeed normally.
      expect(await canWriteToMemory(db, { userId: candidate, roles: [] }, memoryId)).toBe(true);
      const accepted = await act(ctx());
      expect(door === 'ask' ? accepted.shown.deciders : accepted.data.defaultDeciders).toEqual([candidate]);
    });
  }
});
