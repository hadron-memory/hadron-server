/**
 * #4041 (V82/V83) — a host's repair outcome on a dark report, and the notice the PLATFORM posts for it.
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-12-vera-rulings-host-repair-notice
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let manager: { id: string };
let lead: { id: string }; // the worker kit reports to
let kit: { id: string };
let solo: { id: string }; // reports to nobody
let channel: { id: string };
let key: { id: string };

const ago = (min: number) => new Date(Date.now() - min * 60_000);
const send = (reports: unknown[]) =>
  M.setHostWorkerTerminals({}, { input: { appRef: app.id, reports } }, { db, appId: app.id, appKeyId: key.id, organizationId: org.id, roles: [] } as Context);
const dark = (worker: string, extra: Record<string, unknown> = {}) => ({
  worker, status: 'dark', prompt: 'unknown', reason: 'bare_shell', lastTurnAt: null, checkedAt: ago(1), ...extra,
});
const posts = async () =>
  (await db.node.findMany({ where: { messageChannelId: channel.id, nodeType: 'chat-message' }, orderBy: { seq: 'asc' } })) as any[];
const keyOf = (id: string) => db.worker.findUniqueOrThrow({ where: { id }, select: { repairNoticeKey: true } }).then((w) => w.repairNoticeKey);

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Repair', urn: `repair-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 91_000_000 + n, githubUsername: `rp-manager-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  channel = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id })).channel;
  const w = (name: string, reportsTo: string | null = null) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), reportsToWorkerId: reportsTo }, select: { id: true } });
  lead = await w('Mara');
  kit = await w('Kit', lead.id);
  solo = await w('Solo');
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'orca1' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: key.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.registerHost(
    {},
    { input: { appRef: app.id, label: 'Orca One', pollIntervalSeconds: 60, workers: [lead, kit, solo].map((x) => ({ worker: x.id, family: 'claude' })) } },
    { db, appId: app.id, appKeyId: key.id, organizationId: org.id, roles: [] } as Context,
  );
});

describe('RELAUNCHED posts one line, once', () => {
  it('names the worker, the attempt and the host, as the platform, mentioning nobody', async () => {
    const r = await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 2 })]);
    expect(r.stored).toHaveLength(1);
    const [p, ...rest] = await posts();
    expect(rest).toEqual([]);
    expect(p.content).toBe('Kit was relaunched on Orca One (attempt 2).');
    expect(p.data.authorSystem).toBe(true);
    expect(p.data.mentions ?? []).toEqual([]);
  });

  it('a replayed batch posts nothing a second time', async () => {
    const batch = [dark(kit.id, { repair: 'RELAUNCHED', attempt: 1, checkedAt: ago(1) })];
    await send(batch);
    await send(batch);
    expect(await posts()).toHaveLength(1);
  });

  it('a later relaunch of the same worker posts again', async () => {
    await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 1, checkedAt: ago(5) })]);
    await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 2, checkedAt: ago(1) })]);
    expect((await posts()).map((p) => p.content)).toEqual([
      'Kit was relaunched on Orca One (attempt 1).',
      'Kit was relaunched on Orca One (attempt 2).',
    ]);
  });
});

describe('the authorship invariant (cor:agt:080:15)', () => {
  it('every post is the platform system author, never the key, the reported worker or a person', async () => {
    await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 1 }), dark(solo.id, { repair: 'NO_SNAPSHOT' })]);
    const all = await posts();
    expect(all).toHaveLength(2);
    for (const p of all) {
      expect(p.data.authorSystem).toBe(true);
      expect(p.data.authorName).toBe('Hadron (platform)');
      expect(p.data.authorWorkerId).toBeUndefined();
      expect(p.data.authorUserId).toBeUndefined();
      expect(p.data.authorAppId).toBeUndefined();
      expect(p.createdByWorkerId).toBeNull();
      expect(p.createdBy).toBeNull();
    }
  });
});

describe('NO_SNAPSHOT and CAP_REACHED alert once per worker, to the dark worker\'s chain', () => {
  it('mentions the worker it reports to, and only that worker', async () => {
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT' })]);
    const [p, ...rest] = await posts();
    expect(rest).toEqual([]);
    expect(p.content).toBe('Kit is dark on Orca One and was not relaunched: it has no launch snapshot.');
    expect(p.data.mentions).toEqual(['mara']);
    // Vera #101856: the waker is the system author, not a manager, so no exemption stamp: the wake counts against the
    // daily budget (cor:agt:080:15) like any other.
    expect(p.data.managerPost).toBeUndefined();
    expect(p.data.broadcastWakes).toBeUndefined();
  });

  it('with no reporting line, mentions whoever manages the App', async () => {
    await send([dark(solo.id, { repair: 'CAP_REACHED' })]);
    const [p] = await posts();
    expect(p.content).toBe('Solo is dark on Orca One and was not relaunched: the relaunch attempt cap was reached.');
    const handle = (await db.user.findUniqueOrThrow({ where: { id: manager.id }, select: { handle: true } })).handle!.toLowerCase();
    expect(p.data.mentions).toEqual([handle]);
  });

  it('no recipient comes from a role name or from caller text: a worker named Coordinator is not mentioned unless it is the chain', async () => {
    await db.worker.update({ where: { id: solo.id }, data: { role: 'Coordinator' } });
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT' })]);
    expect((await posts())[0].data.mentions).toEqual(['mara']);
  });

  it('a worker named like a broadcast word is never mentioned as one', async () => {
    await db.worker.update({ where: { id: lead.id }, data: { name: 'All' } });
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT' })]);
    const [p] = await posts();
    expect(p.data.mentions ?? []).toEqual([]);
    expect(p.data.broadcastWakes).toBeUndefined();
  });

  it('an @ in a worker name is neutralised and adds no mention', async () => {
    await db.worker.update({ where: { id: kit.id }, data: { name: 'Kit @mara @all' } });
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT' })]);
    const [p] = await posts();
    expect(p.content).not.toContain('@');
    expect(p.data.mentions).toEqual(['mara']);
  });

  it('a repeat posts nothing, and CAP_REACHED after NO_SNAPSHOT is the same alert', async () => {
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(5) })]);
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(4) })]);
    await send([dark(kit.id, { repair: 'CAP_REACHED', checkedAt: ago(3) })]);
    expect(await posts()).toHaveLength(1);
    expect(await keyOf(kit.id)).toBe('alert');
  });

  it('a replayed alert batch posts nothing twice', async () => {
    const batch = [dark(kit.id, { repair: 'NO_SNAPSHOT' })];
    await send(batch);
    await send(batch);
    expect(await posts()).toHaveLength(1);
  });

  it('re-arms after a report with no repair outcome', async () => {
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(5) })]);
    await send([dark(kit.id, { checkedAt: ago(4) })]);
    expect(await keyOf(kit.id)).toBeNull();
    await send([dark(kit.id, { repair: 'CAP_REACHED', checkedAt: ago(3) })]);
    expect(await posts()).toHaveLength(2);
  });

  it('re-arms after a relaunch', async () => {
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(5) })]);
    await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 1, checkedAt: ago(4) })]);
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(3) })]);
    expect((await posts()).map((p) => p.data.mentions ?? [])).toEqual([['mara'], [], ['mara']]);
  });

  it('is once per worker: another worker alerts on its own', async () => {
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT' }), dark(solo.id, { repair: 'NO_SNAPSHOT' })]);
    expect(await posts()).toHaveLength(2);
  });
});

describe('a repair outcome is judged per worker, the rest of the batch stands', () => {
  for (const status of ['busy', 'idle', 'locked'] as const) {
    it(`on a ${status} report: REPAIR_NOT_DARK, nothing stored or posted for it`, async () => {
      const reason = status === 'locked' ? 'rate_limited' : null;
      const r = await send([
        { worker: kit.id, status, prompt: 'empty', reason, checkedAt: ago(1), repair: 'NO_SNAPSHOT' },
        dark(solo.id),
      ]);
      expect(r.refused).toEqual([{ worker: kit.id, code: 'REPAIR_NOT_DARK' }]);
      expect(r.stored.map((s: any) => s.id)).toEqual([solo.id]);
      expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).terminal).toBeNull();
      expect(await posts()).toHaveLength(0);
    });
  }

  for (const [name, extra] of [
    ['attempt 0', { repair: 'RELAUNCHED', attempt: 0 }],
    ['a negative attempt', { repair: 'RELAUNCHED', attempt: -1 }],
    ['no attempt', { repair: 'RELAUNCHED' }],
    ['an attempt with NO_SNAPSHOT', { repair: 'NO_SNAPSHOT', attempt: 1 }],
    ['an attempt with no repair', { attempt: 1 }],
  ] as [string, Record<string, unknown>][]) {
    it(`${name}: REPAIR_ATTEMPT_INVALID`, async () => {
      const r = await send([dark(kit.id, extra), dark(solo.id)]);
      expect(r.refused).toEqual([{ worker: kit.id, code: 'REPAIR_ATTEMPT_INVALID' }]);
      expect(r.stored.map((s: any) => s.id)).toEqual([solo.id]);
      expect(await posts()).toHaveLength(0);
    });
  }

  it('an unknown outcome is refused as a whole-batch input error', async () => {
    await expect(send([dark(kit.id, { repair: 'GAVE_UP' })])).rejects.toBeInstanceOf(GraphQLError);
    expect(await posts()).toHaveLength(0);
  });

  it('a stale report posts nothing', async () => {
    await send([dark(kit.id, { checkedAt: ago(1) })]);
    const r = await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(9) })]);
    expect(r.refused).toEqual([{ worker: kit.id, code: 'TERMINAL_REPORT_STALE' }]);
    expect(await posts()).toHaveLength(0);
  });

  it('the stored report keeps its exact keys: the outcome is not stored on it', async () => {
    await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 1 })]);
    const t = (await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).terminal as any;
    expect(Object.keys(t).sort()).toEqual(['checkedAt', 'host', 'lastTurnAt', 'prompt', 'reason', 'reportedAt', 'status']);
  });
});

describe('no live team chat', () => {
  it('the report is stored, nothing is posted and no marker is claimed, so the next report retries', async () => {
    await db.channel.updateMany({ where: { id: channel.id }, data: { deletedAt: new Date() } });
    const r = await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(3) })]);
    expect(r.stored).toHaveLength(1);
    expect(await keyOf(kit.id)).toBeNull();
    await db.channel.updateMany({ where: { id: channel.id }, data: { deletedAt: null } });
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(2) })]);
    expect(await posts()).toHaveLength(1);
  });
});
