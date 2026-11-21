/**
 * #3581 (a) — plan-vs-real controls for the three projection seams of resolveNodeRef under planNodeMove
 * (cor:api:190:03; seams in src/lib/entityRef/nodeRef.ts): (1) masking a moved node's OLD address, (2) looking up a moved
 * node's PROSPECTIVE address, (3) the historical (alias) lookup under a projection. Each case runs the plan, proves it wrote
 * nothing and left every row live, then runs the real move and requires the plan's link warnings to equal the move's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let src: { id: string; urn: string };
let dest: { id: string; urn: string };
let userId: string;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
const bare = (m: { urn: string }, loc: string) => `hrn:node:${m.urn.replace(/^hrn:mem:/, '')}:${loc}`;
/** createDbNode ignores mint fields, so a minted node is made by creating then stamping it. */
const mk = async (memoryId: string, loc: string, opts: { content?: string; minted?: boolean } = {}) => {
  const n = await createDbNode(db, { memoryId, loc, content: opts.content });
  if (opts.minted) await db.node.update({ where: { id: n.id }, data: { mintedAt: new Date('2026-01-01T00:00:00Z'), mintedByInfo: 'test' } });
  return n;
};

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { githubId: 3581, githubUsername: 'plan3581', roles: ['ADMIN'] } })).id;
  src = (await createDbOrgAndGraph(db, { orgName: 'proj3581', graphName: 'src', visibility: 'PUBLIC' })).graph;
  dest = (await createDbOrgAndGraph(db, { orgName: 'projd3581', graphName: 'dest', visibility: 'PUBLIC' })).graph;
});

const state = async () => ({
  nodes: await db.node.findMany({ orderBy: { id: 'asc' } }),
  aliases: await db.urnAlias.findMany({ orderBy: { id: 'asc' } }),
  revisions: await db.nodeRevision.count(),
});
/** Plan, prove zero writes and liveness, then run the real move and return both warning sets. */
async function planThenMove(args: Record<string, unknown>) {
  const before = await state();
  const plan = await M.planNodeMove(null, args, ctx());
  expect(await state()).toEqual(before);
  expect((await db.node.findMany({ where: { deletedAt: null } })).length).toBe(before.nodes.filter(n => n.deletedAt === null).length);
  const real = await M.moveNode(null, args, ctx());
  return { plan: plan.linkWarnings as Array<{ target: string; status: string }>, real: real.moveLinkWarnings as Array<{ target: string; status: string }> };
}
const brief = (w: Array<{ target: string; status: string }>) => w.map(x => `${x.target}:${x.status}`).sort();

/** The bare (prefix-less) memory URN, the spelling a hand-written link uses: `org:memory`. */
const bareMem = (m: { urn: string }) => m.urn.replace(/^hrn:mem:/, '');
const toDest = (rootId: string) => ({ sourceRef: rootId, targetMemoryRef: dest.id });

describe('#3581 the plan resolves a memory-qualified link to a moved node exactly as the real move', () => {
  // A cross-memory move is the only one that reports link warnings. A link spelled `<org>:<src memory>:<loc>` names the
  // node's OLD address; after the move the old address resolves only through the alias a MINTED node leaves behind.
  it('N11/N13 an UNMINTED moved node leaves no alias: its old qualified address is MISSING in plan and move', async () => {
    const root = await mk(src.id, 'a', { content: `[[${bareMem(src)}:a:b]]` });
    await mk(src.id, 'a:b');
    const { plan, real } = await planThenMove(toDest(root.id));
    expect(brief(real)).toEqual([`${bareMem(src)}:a:b:MISSING`]);
    expect(brief(plan)).toEqual(brief(real));
  });

  it('N13 a MINTED moved node keeps its old address through the planned alias: no warning in plan or move', async () => {
    const root = await mk(src.id, 'a', { content: `[[${bareMem(src)}:a:b]]` });
    await mk(src.id, 'a:b', { minted: true });
    const { plan, real } = await planThenMove(toDest(root.id));
    expect(brief(real)).toEqual([]);
    expect(brief(plan)).toEqual(brief(real));
  });

  it('N13 the same through a HISTORICAL memory prefix (the source memory was renamed): unminted MISSING, minted followed', async () => {
    for (const minted of [false, true]) {
      await cleanDb(db);
      userId = (await db.user.create({ data: { githubId: 3581, githubUsername: 'plan3581', roles: ['ADMIN'] } })).id;
      src = (await createDbOrgAndGraph(db, { orgName: 'proj3581', graphName: 'src', visibility: 'PUBLIC' })).graph;
      dest = (await createDbOrgAndGraph(db, { orgName: 'projd3581', graphName: 'dest', visibility: 'PUBLIC' })).graph;
      const old = 'proj3581:before-rename';
      await recordUrnRename(db, { entityType: 'MEMORY', entityId: src.id, oldUrn: old, newUrn: bareMem(src) });
      const root = await mk(src.id, 'a', { content: `[[${old}:a:b]]` });
      await mk(src.id, 'a:b', { minted });
      const { plan, real } = await planThenMove(toDest(root.id));
      expect(brief(real), `minted=${minted}`).toEqual(minted ? [] : [`${old}:a:b:MISSING`]);
      expect(brief(plan), `minted=${minted}`).toEqual(brief(real));
    }
  });

  it('N12 a moved node\'s PROSPECTIVE address wins over an older alias to another node: RETARGETED in plan and move', async () => {
    // X once lived at dest:a:b and moved to the source, leaving an alias `<dest>:a:b` -> X. The moved child lands on dest:a:b.
    const x = await mk(dest.id, 'a:b', { minted: true });
    await M.moveNode(null, { sourceRef: x.id, targetUrn: bare(src, 'xout') }, ctx());
    const root = await mk(src.id, 'a', { content: `[[${bareMem(dest)}:a:b]]` });
    await mk(src.id, 'a:b');
    const { plan, real } = await planThenMove(toDest(root.id));
    expect(brief(real)).toEqual([`${bareMem(dest)}:a:b:RETARGETED`]);
    expect(brief(plan)).toEqual(brief(real));
  });

  it('N13 a planned alias found through the DESTINATION\'s old URN counts as living in the destination (memory override)', async () => {
    // The destination memory once carried the source memory's URN, so the planned alias key `<src>:a:b` is also one of
    // the destination's own old-prefix spellings. The moved child's id is reported under the destination, not the source.
    await recordUrnRename(db, { entityType: 'MEMORY', entityId: dest.id, oldUrn: bareMem(src), newUrn: bareMem(dest) });
    const root = await mk(src.id, 'a', { content: '[[a:b]]' });
    await mk(src.id, 'a:b', { minted: true });
    const { plan, real } = await planThenMove({ sourceRef: root.id, targetUrn: bare(dest, 'z') });
    expect(brief(real)).toEqual([]);
    expect(brief(plan)).toEqual(brief(real));
  });

  it('OCCUPIED destination: a live destination node at the link target RETARGETS the link, plan and move agree', async () => {
    const root = await mk(src.id, 'a', { content: '[[outside]]' });
    await mk(src.id, 'outside');
    await mk(dest.id, 'outside');
    const { plan, real } = await planThenMove(toDest(root.id));
    expect(brief(real)).toEqual(['outside:RETARGETED']);
    expect(brief(plan)).toEqual(brief(real));
  });

  it('TOMBSTONED destination: a soft-deleted destination node at the link target is not live, so the link is MISSING in plan and move', async () => {
    const root = await mk(src.id, 'a', { content: '[[outside]]' });
    await mk(src.id, 'outside');
    const tomb = await mk(dest.id, 'outside');
    await db.node.update({ where: { id: tomb.id }, data: { deletedAt: new Date() } });
    const { plan, real } = await planThenMove(toDest(root.id));
    expect(brief(real)).toEqual(['outside:MISSING']);
    expect(brief(plan)).toEqual(brief(real));
  });

  it('AMBIGUOUS destination: an older alias to another live node plus the planned alias of the moved node is AMBIGUOUS in plan and move', async () => {
    const earlier = await mk(src.id, 'a:b', { minted: true });
    await M.moveNode(null, { sourceRef: earlier.id, targetUrn: bare(src, 'xout') }, ctx()); // leaves the alias `<src>:a:b` -> earlier
    const root = await mk(src.id, 'a', { content: `[[${bareMem(src)}:a:b]]` });
    await mk(src.id, 'a:b', { minted: true });
    const { plan, real } = await planThenMove(toDest(root.id));
    expect(brief(real)).toEqual([`${bareMem(src)}:a:b:AMBIGUOUS`]);
    expect(brief(plan)).toEqual(brief(real));
  });
});
