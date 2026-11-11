/**
 * #3945 (cor:api:050, :02) — `globalSearch` returns agent tasks, GraphQL only.
 * The access gate is the per-kind task read gate (`mayReadAppTasks`) reused as-is, minus the ruled userless
 * carve-out; every row is pinned in hits AND `total`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
// The granted userless run: made admissible on the direct read so the search carve-out is what refuses it.
const runGrant = vi.hoisted(() => ({ value: false }));
vi.mock('../../../lib/auth/runTeamRead.js', () => ({ runMayReadTeam: vi.fn(async () => runGrant.value) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

let orgId: string;
let participant: { id: string };
let orgOnly: { id: string }; // org member, not an App participant
let stranger: { id: string };
let appX: { id: string; urn: string };
let appY: { id: string; urn: string };
let keyX: { id: string };
let agentId: string;
let workerX: { id: string };
let workerY: { id: string };
let taskX: { id: string; handle: string };
let taskY: { id: string; handle: string };

const userCtx = (u: { id: string }): Context => ({ db, userId: u.id, roles: ['READER'] });
const search = (ctx: Context, query: string, extra: Record<string, unknown> = {}) =>
  Q.globalSearch({}, { query, entityTypes: ['agentTask'], ...extra }, ctx);
const mkTask = async (u: { id: string }, appRef: string, title: string) =>
  (await M.createAgentTask({}, { input: { appRef, title } }, userCtx(u))) as { id: string; handle: string };
const agentTaskHits = (r: { hits: Array<{ entityType: string }> }) => r.hits.filter((h) => h.entityType === 'agentTask');

beforeEach(async () => {
  runGrant.value = false;
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'gs-org', urn: `gs-org-${suffix}.com` } });
  orgId = org.id;
  // Org READERs are not task actors: only an AppMember or an org CONTRIBUTOR+ participates (isAppParticipant).
  const mkUser = (n: number, tag: string) =>
    db.user.create({ data: { id: generateId(), githubId: 99_300 + n, githubUsername: `${tag}-${suffix}`, roles: ['READER'] }, select: { id: true } });
  participant = await mkUser(1, 'part');
  orgOnly = await mkUser(2, 'orgonly');
  stranger = await mkUser(3, 'stranger');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: participant.id, role: 'READER' } });
  const orgAdmin = await mkUser(5, 'admin');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgOnly.id, role: 'READER' } });
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  await db.appMember.create({ data: { appId: appX.id, userId: participant.id, role: 'member' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, userCtx(orgAdmin));
  agentId = agent.id;
  workerX = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appX.id, agentId, name: 'Wx', slug: 'wx' }, select: { id: true } });
  workerY = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appY.id, agentId, name: 'Wy', slug: 'wy' }, select: { id: true } });
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
  const yOwner = await mkUser(4, 'yowner');
  await db.appMember.create({ data: { appId: appY.id, userId: yOwner.id, role: 'member' } });
  taskX = await mkTask(participant, appX.id, 'Rotate the zebra keys');
  taskY = await mkTask(yOwner, appY.id, 'Zebra audit on Y');
});

describe('agentTask global search (#3945)', () => {
  it('finds a task by handle (any case), partial handle and title substring; name field, null description, bare handle', async () => {
    for (const q of [taskX.handle, taskX.handle.toLowerCase(), 'AT', 'zebra keys', 'ZEBRA']) {
      const r = await search(userCtx(participant), q);
      const h = agentTaskHits(r).find((x: any) => x.id === taskX.id) as any;
      expect(h, q).toBeTruthy();
      expect(h.matchedField).toBe('name');
      expect(h.description).toBeNull();
      expect(h.handle).toBe(taskX.handle);
      expect(h.name).toBe('Rotate the zebra keys');
      expect(h.urn).toBeNull();
      expect(h.memoryId).toBeNull();
      expect(h.organizationId).toBe(orgId);
    }
  });

  it('ranks an exact handle above substring matches', async () => {
    const later = await mkTask(participant, appX.id, `mentions ${taskX.handle} in passing`);
    const r = await search(userCtx(participant), taskX.handle.toLowerCase());
    expect(r.hits[0].id).toBe(taskX.id);
    expect(r.hits.map((h: any) => h.id)).toContain(later.id);
    expect(r.total).toBeGreaterThanOrEqual(2);
  });

  it('a participant sees hits for their App only; hits and total agree', async () => {
    const r = await search(userCtx(participant), 'zebra');
    expect(r.hits.map((h: any) => h.id)).toEqual([taskX.id]);
    expect(r.total).toBe(1);
    expect(r.hits.map((h: any) => h.id)).not.toContain(taskY.id);
  });

  it('a non-participant (including an org member who is not a task actor) gets nothing, like a nonexistent task', async () => {
    const empty = await search(userCtx(participant), 'no-such-thing-xyz');
    for (const u of [orgOnly, stranger]) {
      for (const q of [taskX.handle, 'zebra', 'hrn:agenttask:x:' + taskX.handle]) {
        const r = await search(userCtx(u), q);
        expect(agentTaskHits(r)).toEqual([]);
        expect(r.total).toBe(0);
        expect(r.total).toBe(empty.total);
      }
    }
  });

  it('a live worker session bound to the App sees its tasks; another App\'s session sees none', async () => {
    const ok = await runAsActor({ workerId: workerX.id, agentId }, () => search(userCtx(participant), 'zebra'));
    expect(ok.hits.map((h: any) => h.id)).toEqual([taskX.id]);
    // Y's worker, driven by someone who is not a participant of X: no hit for X's task.
    const other = await runAsActor({ workerId: workerY.id, agentId }, () => search(userCtx(participant), taskX.handle));
    expect(agentTaskHits(other).map((h: any) => h.id)).not.toContain(taskX.id);
    const retired = await db.worker.update({ where: { id: workerX.id }, data: { retiredAt: new Date() } });
    expect(retired.retiredAt).not.toBeNull();
    const gone = await runAsActor({ workerId: workerX.id, agentId }, () => search(userCtx(participant), 'zebra'));
    expect(agentTaskHits(gone)).toEqual([]);
    expect(gone.total).toBe(0);
  });

  it('the App\'s own key gets no task hits, even for its own App (ruled userless carve-out)', async () => {
    const keyCtx: Context = { db, appId: appX.id, appKeyId: keyX.id, roles: [] };
    // The direct read admits the key…
    expect((await Q.agentTask({}, { id: taskX.id }, keyCtx))?.id).toBe(taskX.id);
    // …the search does not.
    const r = await search(keyCtx, 'zebra');
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('a userless run gets no task hits, with or without the team-read grant', async () => {
    const runCtx: Context = { db, appId: appX.id, organizationId: orgId, clientId: 'run:r1', roles: [] };
    for (const granted of [false, true]) {
      runGrant.value = granted;
      const r = await search(runCtx, 'zebra');
      expect(r.hits).toEqual([]);
      expect(r.total).toBe(0);
    }
  });

  it('a deleted App yields no hits', async () => {
    await db.app.update({ where: { id: appX.id }, data: { deletedAt: new Date() } });
    const r = await search(userCtx(participant), 'zebra');
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('explicit fields: [name] searches title and handle; [urn] and [pk] return no task', async () => {
    expect(agentTaskHits(await search(userCtx(participant), taskX.handle, { fields: ['name'] })).map((h: any) => h.id)).toEqual([taskX.id]);
    for (const f of ['urn', 'pk']) {
      const r = await search(userCtx(participant), taskX.handle, { fields: [f] });
      expect(r.hits).toEqual([]);
      expect(r.total).toBe(0);
    }
  });

  it('a task id (PK-sniffed) and a task URN (URN-sniffed) return no task in this slice', async () => {
    expect((await search(userCtx(participant), taskX.id)).hits).toEqual([]);
    expect((await search(userCtx(participant), `hrn:agenttask:${appX.urn}:${taskX.handle}`)).hits).toEqual([]);
  });

  it('unrestricted search includes the type and an org narrowing never widens it', async () => {
    const all = await Q.globalSearch({}, { query: 'zebra' }, userCtx(participant));
    expect(all.hits.some((h: any) => h.entityType === 'agentTask' && h.id === taskX.id)).toBe(true);
    const other = await db.organization.create({ data: { id: generateId(), name: 'o2', urn: `o2-${generateId()}.com` } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: other.id, userId: participant.id, role: 'ADMIN' } });
    const narrowed = await search(userCtx(participant), 'zebra', { orgId: other.id });
    expect(narrowed.hits).toEqual([]);
    expect(agentTaskHits(await search(userCtx(participant), 'zebra', { orgId })).map((h: any) => h.id)).toEqual([taskX.id]); // own org: still only the gated task
  });
});
