/**
 * #817 — `nextNode`, the GraphQL twin of `hadron_get_next_node`.
 *
 * The two ordering questions the issue asked to settle, pinned here AND
 * cross-checked against the MCP tool so guided reading order cannot diverge
 * between surfaces:
 *   - a NULL `seq` sorts LAST, after every explicitly ordered sibling;
 *   - ties (equal seq, or two nulls) break on `loc` ascending.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const Q = resolvers.Query as any;

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

let org: { id: string; urn: string };
let member: { id: string };
let stranger: { id: string };
let mem: { id: string; urn: string };
let parent: { id: string; loc: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'nn', urn: `nn-${generateId()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 50101, githubUsername: 'nn-member' } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 50102, githubUsername: 'nn-stranger' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  mem = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`,
      name: 'nn mem', class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
  parent = await createDbNode(db, { loc: 'sections', memoryId: mem.id, name: 'Sections' });
});

// NOTE: the shared createDbNode helper has no `seq` field and would silently
// drop it — which would make every ordering assertion below pass for the wrong
// reason. Create directly so seq is actually persisted.
const child = (loc: string, seq: number | null) =>
  db.node.create({
    data: {
      id: generateId(), memoryId: mem.id, loc: `sections:${loc}`,
      name: loc, ownerRepo: 'test/repo', tags: [], seq,
    },
  });

const next = (parentRef: string, currentRef?: string) =>
  Q.nextNode(null, { parentRef, currentRef }, ctx(member.id));

describe('nextNode — ordered traversal (#817)', () => {
  it('walks the whole sibling chain by seq, then returns null at the end', async () => {
    const a = await child('a', 10);
    const b = await child('b', 20);
    const c = await child('c', 30);

    const first = await next(parent.id);
    expect(first?.id).toBe(a.id);
    expect((await next(parent.id, first.id))?.id).toBe(b.id);
    expect((await next(parent.id, b.id))?.id).toBe(c.id);
    // End of the run.
    expect(await next(parent.id, c.id)).toBeNull();
  });

  it('seq order beats loc order — the point of the field', async () => {
    // Locs sort a,b,c but seq says c,b,a.
    const a = await child('a', 30);
    const b = await child('b', 20);
    const c = await child('c', 10);
    expect((await next(parent.id))?.id).toBe(c.id);
    expect((await next(parent.id, c.id))?.id).toBe(b.id);
    expect((await next(parent.id, b.id))?.id).toBe(a.id);
  });

  it('a NULL seq sorts LAST, after every explicitly ordered sibling', async () => {
    const unordered = await child('aaa-first-by-loc', null);
    const ordered = await child('zzz-last-by-loc', 5);
    // Despite sorting first by loc, the seq-less node comes last.
    expect((await next(parent.id))?.id).toBe(ordered.id);
    expect((await next(parent.id, ordered.id))?.id).toBe(unordered.id);
  });

  it('ties break on loc ascending — equal seq AND two nulls', async () => {
    const bTie = await child('b-tie', 10);
    const aTie = await child('a-tie', 10);
    const yNull = await child('y-null', null);
    const xNull = await child('x-null', null);
    const order: string[] = [];
    let cur = await next(parent.id);
    while (cur) {
      order.push(cur.id);
      cur = await next(parent.id, cur.id);
    }
    expect(order).toEqual([aTie.id, bTie.id, xNull.id, yNull.id]);
  });
});

describe('nextNode — scope and shape (#817)', () => {
  it('returns DIRECT children only — grandchildren never appear', async () => {
    const direct = await child('a', 10);
    await db.node.create({
      data: {
        id: generateId(), memoryId: mem.id, loc: 'sections:a:deep',
        name: 'deep', ownerRepo: 'test/repo', tags: [], seq: 1,
      },
    });
    expect((await next(parent.id))?.id).toBe(direct.id);
    // The grandchild is not a sibling, so the chain ends after the child.
    expect(await next(parent.id, direct.id)).toBeNull();
  });

  it('skips soft-deleted children rather than landing on a tombstone', async () => {
    const a = await child('a', 10);
    const dead = await child('b', 20);
    const c = await child('c', 30);
    await db.node.update({ where: { id: dead.id }, data: { deletedAt: new Date() } });
    expect((await next(parent.id, a.id))?.id).toBe(c.id);
  });

  it('accepts a fully-qualified URN as well as a PK (cor:api:140)', async () => {
    const a = await child('a', 10);
    const urn = `${mem.urn.replace(':', '::')}::${parent.loc}`;
    expect((await next(urn))?.id).toBe(a.id);
  });

  it('a childless parent returns null', async () => {
    expect(await next(parent.id)).toBeNull();
  });

  it('returns the node with edges hydrated, like node(ref:)', async () => {
    const a = await child('a', 10);
    const target = await createDbNode(db, { loc: 'other', memoryId: mem.id, name: 'Other' });
    await db.edge.create({
      data: {
        id: generateId(), memoryId: mem.id, sourceId: a.id, targetId: target.id,
        name: 'rel', loc: `sections:a:rel:other`,
      },
    });
    const got = await next(parent.id);
    expect(got?.id).toBe(a.id);
    expect(got.outgoingEdges?.length).toBe(1);
  });
});

describe('nextNode — non-disclosure posture (#817)', () => {
  it('an unreadable parent is null — denied and missing are indistinguishable', async () => {
    await child('a', 10);
    expect(await Q.nextNode(null, { parentRef: parent.id }, ctx(stranger.id))).toBeNull();
    expect(await Q.nextNode(null, { parentRef: generateId() }, ctx(member.id))).toBeNull();
  });

  it('an anonymous caller gets null', async () => {
    await child('a', 10);
    expect(await Q.nextNode(null, { parentRef: parent.id }, ctx())).toBeNull();
  });

  it('a currentRef that is not a child of this parent is null, not an error', async () => {
    // Otherwise the distinction would probe a node's parentage.
    await child('a', 10);
    const elsewhere = await createDbNode(db, { loc: 'unrelated', memoryId: mem.id, name: 'Unrelated' });
    expect(await next(parent.id, elsewhere.id)).toBeNull();
  });

  it('a MALFORMED ref throws — a shape error discloses nothing about what exists', async () => {
    await child('a', 10);
    // A bare loc is under-qualified at the API boundary (spec 022): an input
    // error, distinct from a genuine miss.
    await expect(next('sections')).rejects.toThrow();
  });
});

describe('nextNode agrees with the MCP tool it mirrors (#817)', () => {
  it('same order for the mixed seq / null / tie case', async () => {
    // The MCP tool sorts: seq-bearing first (ascending), then seq-less, with
    // loc breaking ties in both groups. Reproduce that reference ordering
    // independently and require nextNode to walk it exactly.
    const rows = [
      await child('m', 2),
      await child('b', 1),
      await child('z', null),
      await child('a', null),
      await child('c', 2),
    ];
    const reference = [...rows].sort((x, y) => {
      const xs = (x as { seq: number | null }).seq;
      const ys = (y as { seq: number | null }).seq;
      if (xs !== null && ys !== null) return xs - ys || x.loc.localeCompare(y.loc);
      if (xs !== null) return -1;
      if (ys !== null) return 1;
      return x.loc.localeCompare(y.loc);
    });

    const walked: string[] = [];
    let cur = await next(parent.id);
    while (cur) {
      walked.push(cur.id);
      cur = await next(parent.id, cur.id);
    }
    expect(walked).toEqual(reference.map((r) => r.id));
  });
});
