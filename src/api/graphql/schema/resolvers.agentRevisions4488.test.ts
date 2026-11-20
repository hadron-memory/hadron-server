/**
 * #4488 — an Agent's revisions: the list, and delete-one.
 * Contract (issue ruling, AT0.8516.2): list newest first with the slot facts; delete by loc under restoreRevision's
 * gate; refuse the published and the only revision before any write; no other Agent's revisions visible or deletable.
 * Slot numbers are never reused (#2507), so a delete does not free a slot: pinned below.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { MAX_REVISION_SLOT } from '../../../lib/revisionSlot.js';
import { lockNodeForDelete } from '../../../lib/nodeSubtreeLock.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let manager: { id: string };
let outsider: { id: string };
let agentA: { id: string; systemMemoryId: string | null };
let agentB: { id: string; systemMemoryId: string | null };

const asManager = (): Context => ({ db, roles: ['READER'], userId: manager.id });
const asOutsider = (): Context => ({ db, roles: ['READER'], userId: outsider.id });
const save = (a = agentA, ctx = asManager()) => resolvers.Mutation.createRevision({}, { agentRef: a.id }, ctx);
const list = (a = agentA, ctx = asManager()) => resolvers.Query.agentRevisions({}, { agentRef: a.id }, ctx);
const del = (loc: string, a = agentA, ctx = asManager()) =>
  resolvers.Mutation.deleteAgentRevision({}, { agentRef: a.id, revisionLoc: loc }, ctx);
const live = (a: { systemMemoryId: string | null }, loc: string) =>
  db.node.findFirst({ where: { memoryId: a.systemMemoryId!, loc, deletedAt: null } });

async function makeAgent(orgName: string, userId: string, name: string) {
  const org = await db.organization.create({ data: { id: generateId(), name: orgName, urn: orgName } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  return resolvers.Mutation.createAgent({}, { orgRef: org.id, name, visibility: 'PERSONAL' }, { db, roles: ['READER'], userId });
}

beforeEach(async () => {
  await cleanDb(db);
  manager = await db.user.create({ data: { githubId: 8801, githubUsername: 'rev4488-mgr', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 8802, githubUsername: 'rev4488-out', roles: ['READER'] } });
  const other = await db.user.create({ data: { githubId: 8803, githubUsername: 'rev4488-other', roles: ['READER'] } });
  agentA = await makeAgent('rev4488-a', manager.id, 'agent-a');
  agentB = await makeAgent('rev4488-b', other.id, 'agent-b');
});

describe('agentRevisions (list)', () => {
  it('lists newest first with the slot facts, the pinned one marked published', async () => {
    await save(); await save(); await save();
    await resolvers.Mutation.publishRevision({}, { agentRef: agentA.id, revisionLoc: 'revisions:rev-2' }, asManager());
    const r = await list();
    expect(r.revisions.map((x: any) => x.revisionLoc)).toEqual(['revisions:rev-3', 'revisions:rev-2', 'revisions:rev-1']);
    expect(r.revisions.map((x: any) => x.published)).toEqual([false, true, false]);
    expect(r.slotLimit).toBe(MAX_REVISION_SLOT);
    expect(r.highestSlotUsed).toBe(3);
    expect(r.slotsRemaining).toBe(MAX_REVISION_SLOT - 3);
  });

  it('does not list a deleted revision, but its slot stays used', async () => {
    await save(); await save(); await save();
    await del('revisions:rev-3');
    const r = await list();
    expect(r.revisions.map((x: any) => x.revisionLoc)).toEqual(['revisions:rev-2', 'revisions:rev-1']);
    expect(r.highestSlotUsed).toBe(3);
    expect((await save()).revisionLoc).toBe('revisions:rev-4');
  });

  it('is empty for an Agent with no revisions', async () => {
    const r = await list();
    expect(r.revisions).toEqual([]);
    expect(r.highestSlotUsed).toBe(0);
  });

  it('answers another tenant\'s Agent as absent, and a reader without manage rights is refused', async () => {
    await save(agentB, { db, roles: ['READER'], userId: (await db.orgMember.findFirstOrThrow({ where: { role: 'ADMIN', organization: { urn: 'rev4488-b' } } })).userId });
    await expect(list(agentB, asManager())).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(list(agentA, asOutsider())).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });
});

describe('deleteAgentRevision', () => {
  it('deletes a non-published revision by loc; it leaves the list and cannot be restored', async () => {
    await save(); await save(); await save();
    await resolvers.Mutation.publishRevision({}, { agentRef: agentA.id, revisionLoc: 'revisions:rev-3' }, asManager());
    const out = await del('revisions:rev-1');
    expect(out).toMatchObject({ revisionLoc: 'revisions:rev-1', label: 'rev-1' });
    expect(await live(agentA, 'revisions:rev-1')).toBeNull();
    await expect(
      resolvers.Mutation.restoreRevision({}, { agentRef: agentA.id, revisionLoc: 'revisions:rev-1' }, asManager()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('a delete does not free a slot: the next save takes the next number (#2507)', async () => {
    await save(); await save();
    await del('revisions:rev-1');
    expect((await save()).revisionLoc).toBe('revisions:rev-3');
    expect((await list()).highestSlotUsed).toBe(3);
  });

  it('refuses the published revision with REVISION_PUBLISHED, writing nothing', async () => {
    await save(); await save();
    await resolvers.Mutation.publishRevision({}, { agentRef: agentA.id, revisionLoc: 'revisions:rev-1' }, asManager());
    await expect(del('revisions:rev-1')).rejects.toMatchObject({ extensions: { code: 'REVISION_PUBLISHED' } });
    expect(await live(agentA, 'revisions:rev-1')).not.toBeNull();
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentA.id } })).publishedRevisionLoc).toBe('revisions:rev-1');
  });

  it('refuses the only revision with REVISION_ONLY, writing nothing', async () => {
    await save();
    await expect(del('revisions:rev-1')).rejects.toMatchObject({ extensions: { code: 'REVISION_ONLY' } });
    expect(await live(agentA, 'revisions:rev-1')).not.toBeNull();
  });

  it('judges "only" on live revisions: a deleted one does not count', async () => {
    await save(); await save();
    await del('revisions:rev-1');
    await expect(del('revisions:rev-2')).rejects.toMatchObject({ extensions: { code: 'REVISION_ONLY' } });
  });

  it('refuses the published one before the only one when it is both', async () => {
    await save();
    await resolvers.Mutation.publishRevision({}, { agentRef: agentA.id, revisionLoc: 'revisions:rev-1' }, asManager());
    await expect(del('revisions:rev-1')).rejects.toMatchObject({ extensions: { code: 'REVISION_PUBLISHED' } });
  });

  it('answers an unknown, already-deleted, non-slot or descendant loc as not found', async () => {
    await save(); await save(); await save();
    await del('revisions:rev-1');
    for (const loc of ['revisions:rev-99', 'revisions:rev-1', 'prompts:hello', 'revisions', 'revisions:rev-2:child', 'revisions:rev-1__deleted-x']) {
      await expect(del(loc)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
    expect(await live(agentA, 'revisions:rev-2')).not.toBeNull();
  });

  // #4550 BLIND N2: the discriminating order. The OTHER tenant's rev-1 is created FIRST and is still live when the delete
  // runs, so a delete that lost its memory scope (an unscoped loc lookup) would find THAT row first and delete it.
  // One creation order per direction: each tenant takes a turn as the earlier, "victim" owner.
  const ownerOf = async (urn: string) => (await db.orgMember.findFirstOrThrow({ where: { organization: { urn } } })).userId;
  const asUser = (userId: string): Context => ({ db, roles: ['READER'], userId });

  it('tenant isolation: A deleting its rev-1 leaves B\'s earlier, still-live rev-1 alone', async () => {
    const bOwner = await ownerOf('rev4488-b');
    await save(agentB, asUser(bOwner)); await save(agentB, asUser(bOwner)); // B rev-1, rev-2 first
    await save(); await save();                                           // then A rev-1, rev-2
    await del('revisions:rev-1', agentA, asManager());
    expect(await live(agentA, 'revisions:rev-1')).toBeNull();
    expect(await live(agentB, 'revisions:rev-1')).not.toBeNull();
    expect(await live(agentB, 'revisions:rev-2')).not.toBeNull();
  });

  it('tenant isolation: B deleting its rev-1 leaves A\'s earlier, still-live rev-1 alone', async () => {
    const bOwner = await ownerOf('rev4488-b');
    await save(); await save();                                           // A first
    await save(agentB, asUser(bOwner)); await save(agentB, asUser(bOwner));
    await del('revisions:rev-1', agentB, asUser(bOwner));
    expect(await live(agentB, 'revisions:rev-1')).toBeNull();
    expect(await live(agentA, 'revisions:rev-1')).not.toBeNull();
    expect(await live(agentA, 'revisions:rev-2')).not.toBeNull();
  });

  it('tenant isolation: another tenant\'s manager, and an outsider, are answered as absent and nothing is deleted', async () => {
    const bOwner = await ownerOf('rev4488-b');
    await save(agentB, asUser(bOwner)); await save(agentB, asUser(bOwner));
    await save(); await save();
    // the manager of A names B's Agent (#1944), and an outsider names A's: AGENT_NOT_FOUND, both Agents keep their rows
    await expect(del('revisions:rev-1', agentB, asManager())).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(del('revisions:rev-1', agentA, asOutsider())).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    expect(await live(agentB, 'revisions:rev-1')).not.toBeNull();
    expect(await live(agentA, 'revisions:rev-1')).not.toBeNull();
  });

  it('a member who can read the Agent but does not manage it is refused (list and delete), and nothing is written', async () => {
    await save(); await save();
    const reader = await db.user.create({ data: { githubId: 8804, githubUsername: 'rev4488-reader', roles: ['READER'] } });
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'rev4488-a' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
    const asReader: Context = { db, roles: ['READER'], userId: reader.id };
    await expect(del('revisions:rev-1', agentA, asReader)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(list(agentA, asReader)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await live(agentA, 'revisions:rev-1')).not.toBeNull();
  });

  // Deterministic interleave (#4550 P2): a second connection holds one lock; delete and publish of the same revision
  // must both WAIT on it and finish once it is released. Removing either operation's lock lets it finish while held.
  const LOC = 'revisions:rev-1';
  // The pin is seeded on rev-2 first, so it is never null and the invariant below is checked on every run. The two
  // operations race on rev-1: exactly one wins (delete wins -> publish finds it gone; publish wins -> delete is refused
  // REVISION_PUBLISHED), and the pin never ends on a deleted revision. Outcomes are captured, not swallowed.
  async function bothWaitWhileHeld(hold: (tx: any) => Promise<void>) {
    await save(); await save();
    await resolvers.Mutation.publishRevision({}, { agentRef: agentA.id, revisionLoc: 'revisions:rev-2' }, asManager());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const holder = db.$transaction(async (tx) => { await hold(tx); held(); await gate; }, { timeout: 30000 });
    await holding;
    let done = 0;
    const d = del(LOC).finally(() => { done++; });
    const p = resolvers.Mutation.publishRevision({}, { agentRef: agentA.id, revisionLoc: LOC }, asManager()).finally(() => { done++; });
    const settled = Promise.allSettled([d, p]);
    await new Promise((r) => setTimeout(r, 400));
    const whileHeld = done;
    release();
    await holder;
    const [dr, pr] = await settled;
    expect(whileHeld).toBe(0);
    expect(done).toBe(2);
    expect([dr.status, pr.status].filter((x) => x === 'fulfilled')).toHaveLength(1);
    const code = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason as any).extensions?.code : null);
    if (dr.status === 'rejected') expect(code(dr)).toBe('REVISION_PUBLISHED');
    if (pr.status === 'rejected') expect(code(pr)).toBe('BAD_USER_INPUT');
    const pin = (await db.agent.findUniqueOrThrow({ where: { id: agentA.id } })).publishedRevisionLoc;
    expect(pin).not.toBeNull();
    expect(await live(agentA, pin!)).not.toBeNull();
  }

  it('delete and publish of one revision both wait on the revision\'s node lock, and never leave the pin on a deleted one', async () => {
    await bothWaitWhileHeld((tx) => lockNodeForDelete(tx, agentA.systemMemoryId!, LOC));
  });

  it('delete and publish of one revision both wait on the Agent row lock', async () => {
    await bothWaitWhileHeld(async (tx) => { await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agentA.id} FOR UPDATE`; });
  });
});
