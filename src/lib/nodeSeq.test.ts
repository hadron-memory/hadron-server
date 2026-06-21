import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { nextSiblingSeq } from './nodeSeq.js';

let memoryId: string;
let otherMemoryId: string;

async function seed(
  loc: string,
  seq: number | null,
  opts: { memoryId?: string; deleted?: boolean } = {},
) {
  return db.node.create({
    data: {
      id: generateId(),
      memoryId: opts.memoryId ?? memoryId,
      loc,
      name: loc,
      tags: [],
      seq,
      ...(opts.deleted ? { deletedAt: new Date() } : {}),
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'seq-org', urn: 'seq-org' },
  });
  const mem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'seq-org:m1', name: 'm1', class: 'knowledge' },
  });
  const mem2 = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'seq-org:m2', name: 'm2', class: 'knowledge' },
  });
  memoryId = mem.id;
  otherMemoryId = mem2.id;
});

describe('nextSiblingSeq', () => {
  it('returns max(sibling seq)+1 for an ordered nested list', async () => {
    await seed('parent:a', 1);
    await seed('parent:b', 3); // a gap is fine — "next" is max+1, not count+1
    expect(await nextSiblingSeq(db, memoryId, 'parent:c')).toBe(4);
  });

  it('returns null when no sibling has a seq (unordered list)', async () => {
    await seed('parent:a', null);
    await seed('parent:b', null);
    expect(await nextSiblingSeq(db, memoryId, 'parent:c')).toBeNull();
  });

  it('returns null when there are no siblings at all', async () => {
    expect(await nextSiblingSeq(db, memoryId, 'lonely:child')).toBeNull();
  });

  it('counts only direct children, not deeper descendants', async () => {
    await seed('parent:a', 5);
    await seed('parent:a:deep', 99); // grandchild of `parent` — not a sibling of parent:c
    expect(await nextSiblingSeq(db, memoryId, 'parent:b')).toBe(6);
  });

  it('handles root-level siblings (no colon in loc)', async () => {
    await seed('alpha', 1);
    await seed('beta', 2);
    await seed('child:x', 50); // nested — must not count as a root-level sibling
    expect(await nextSiblingSeq(db, memoryId, 'gamma')).toBe(3);
  });

  it('ignores soft-deleted siblings', async () => {
    await seed('parent:a', 1);
    await seed('parent:b', 9, { deleted: true });
    expect(await nextSiblingSeq(db, memoryId, 'parent:c')).toBe(2);
  });

  it('is scoped to the memory', async () => {
    await seed('parent:a', 7, { memoryId: otherMemoryId });
    expect(await nextSiblingSeq(db, memoryId, 'parent:c')).toBeNull();
  });
});
