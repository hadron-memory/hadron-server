/** #3161 / cor:dmo:130:09: every decision decider must currently write the log memory. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { canWriteToMemory } from '../../../mcp/access-control.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let admin: string, candidate: string, orgId: string, memoryId: string;
const ctx = (): Context => ({ db, userId: admin, roles: ['ADMIN'] });
const createLog = (decider = admin) => M.createDecisionLog(null,
  { memoryRef: memoryId, loc: 'decisions', defaultDeciders: [decider] }, ctx());
const input = { title: 'Proceed?', parts: [{ question: 'Proceed?', yesno: true, recommendation: { key: 'yes', reason: 'ready' } }] };

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Decider test', urn: `decider-${generateId()}.example` } });
  orgId = org.id;
  admin = (await db.user.create({ data: { handle: `admin-${generateId()}`, roles: ['ADMIN'] } })).id;
  candidate = (await db.user.create({ data: { handle: `candidate-${generateId()}`, roles: ['ADMIN'] } })).id;
  await db.orgMember.createMany({ data: [
    { organizationId: orgId, userId: admin, role: 'ADMIN' },
    { organizationId: orgId, userId: candidate, role: 'CONTRIBUTOR' },
  ] });
  memoryId = (await M.createMemory(null, { orgId, name: 'Decider memory' }, ctx())).id;
});

describe('#3161 decider write eligibility at all three doors', () => {
  for (const door of ['create', 'replace', 'ask'] as const) {
    for (const state of ['reader', 'writer', 'deleted', 'outsider'] as const) {
      it(`${door}: ${state} is judged as that user without the caller or stored platform-admin bypass`, async () => {
        // For ask, name a valid writer first, then change their authority. This also covers old default-decider rows.
        const log = door === 'create' ? null : await createLog(door === 'ask' ? candidate : admin);
        if (state === 'reader') await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: candidate } }, data: { role: 'READER' } });
        if (state === 'outsider') await db.orgMember.delete({ where: { organizationId_userId: { organizationId: orgId, userId: candidate } } });
        if (state === 'deleted') await db.user.update({ where: { id: candidate }, data: { deletedAt: new Date() } });
        if (state !== 'deleted') expect(await canWriteToMemory(db, { userId: candidate, roles: [] }, memoryId)).toBe(state === 'writer');
        const before = await db.node.findMany({ where: { memoryId }, select: { id: true, data: true, revSeq: true, content: true }, orderBy: { id: 'asc' } });
        const act = () => door === 'create' ? createLog(candidate)
          : door === 'replace' ? M.setDecisionLogDeciders(null, { logRef: log.row.id, defaultDeciders: [candidate], expectedRevision: log.row.revSeq, reason: 'change deciders' }, ctx())
          : M.askDecision(null, { logRef: log.row.id, input: { ...input, deciders: [candidate] } }, ctx());
        if (state === 'writer') {
          const result = await act();
          expect((door === 'ask' ? result.shown.deciders : result.data.defaultDeciders)).toEqual([candidate]);
        } else {
          await expect(act()).rejects.toMatchObject({ extensions: { code: 'DECISION_DECIDER_NOT_ELIGIBLE' } });
          expect(await db.node.findMany({ where: { memoryId }, select: { id: true, data: true, revSeq: true, content: true }, orderBy: { id: 'asc' } })).toEqual(before);
        }
      });
    }
  }
});
