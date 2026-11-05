/** #1336 (§10 P2-1): a HUMAN authorship stamp names a person, so a user merge moves it to the survivor. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { approvedMergeProof } from '../../test/mergeConsent.js';
import { mergeUsers } from './mergeUsers.js';

let source: { id: string };
let target: { id: string };
let other: { id: string };
let admin: { id: string };
let memoryId: string;

const AT = new Date('2026-01-01T00:00:00Z');

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'hs1336', urn: `hs1336-${generateId()}.test` } });
  [source, target, other, admin] = await Promise.all([
    db.user.create({ data: { handle: `src-${generateId().slice(-6)}` } }),
    db.user.create({ data: { handle: `tgt-${generateId().slice(-6)}` } }),
    db.user.create({ data: { handle: `oth-${generateId().slice(-6)}` } }),
    db.user.create({ data: { handle: `adm-${generateId().slice(-6)}`, roles: ['ADMIN'] } }),
  ]);
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'hs1336-mem', urn: `hs1336:${generateId()}`, class: 'knowledge' } as never });
  memoryId = memory.id;
});

const humanNode = (loc: string, human: string) => db.node.create({ data: {
  id: generateId(), memoryId, loc, name: loc, abstract: loc, content: 'x',
  authorshipKind: 'HUMAN', authoredByHuman: human, authoredAt: AT,
} as never });

describe('mergeUsers: HUMAN authorship stamp (#1336)', () => {
  it('moves the source id on the live node and its revision snapshot, leaves other persons alone', async () => {
    const mine = await humanNode('n:mine', source.id);
    const theirs = await humanNode('n:theirs', other.id);
    await db.nodeRevision.create({ data: {
      nodeId: mine.id, memoryId, revNo: 1, loc: 'n:mine', name: 'n', abstract: 'n', content: 'x',
      authorshipKind: 'HUMAN', authoredByHuman: source.id, authoredAt: AT,
    } as never });
    await mergeUsers(db, {
      sourceUserId: source.id, targetUserId: target.id, actorUserId: admin.id,
      consentProof: await approvedMergeProof(db, source.id, target.id, admin.id),
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: mine.id } })).authoredByHuman).toBe(target.id);
    expect((await db.node.findUniqueOrThrow({ where: { id: theirs.id } })).authoredByHuman).toBe(other.id);
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: mine.id, revNo: 1 } });
    expect(rev.authoredByHuman).toBe(target.id);
    expect(rev.authoredAt).toEqual(AT);
  });
});
