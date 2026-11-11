/**
 * #3774 (R3, cor:dmo:050:21) — uninstalling an App ends its workers' open dark-worker episodes, a reinstall lets a worker that is
 * still dark open a NEW episode, and a sweep that listed the App as installed before an uninstall opens none after it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { evaluateDarkWorkers } from './darkWorker.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const MIN = 60_000;
const NOW = new Date('2026-10-29T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MIN);

let org: { id: string; urn: string };
let app: { id: string };
let user: { id: string };
let agent: { id: string };
let liam: { id: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'dark-org', urn: `dark-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubUsername: `dark-${suffix}`, roles: ['READER'] } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  const channel = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id })).channel;
  liam = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Liam', slug: 'liam', role: 'engineer', heldByUserId: user.id },
    select: { id: true },
  });
  // Liam is OVERDUE: a live session, a task, last checked 40 minutes ago (limit 25).
  await db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: at(120), updatedAt: NOW } });
  await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, assigneeWorkerId: liam.id, assignedAt: at(100) } });
  await db.channelReadState.create({ data: { workerId: liam.id, channelId: channel.id, appId: app.id, lastSeenSeq: 0, lastCheckedAt: at(40) } });
});

const episodes = () => db.darkWorkerEpisode.findMany({ where: { workerId: liam.id }, orderBy: { openedAt: 'asc' } });

describe('#3774 R3 against a worker that is really dark', () => {
  it('uninstall ends the open episode; the sweep skips the App; a reinstall opens a NEW episode and keeps the ended one', async () => {
    expect(await evaluateDarkWorkers(db, NOW)).toHaveLength(1);
    const [first] = await episodes();
    expect(first!.endedAt).toBeNull();

    await M.uninstallApp({}, { ref: app.id }, ctx());
    expect((await episodes())[0]!.endedAt).not.toBeNull();
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
    expect(await episodes()).toHaveLength(1);

    await M.reinstallApp({}, { ref: app.id }, ctx());
    expect(await evaluateDarkWorkers(db, NOW)).toHaveLength(1);
    const all = await episodes();
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe(first!.id);
    expect(all[0]!.endedAt).not.toBeNull();
    expect(all[1]!.endedAt).toBeNull();
  });

  it('a sweep that listed the App as installed BEFORE the uninstall opens no episode after it (both orders)', async () => {
    // The sweep captures its installed-App list, the uninstall commits, then the sweep continues with the captured list.
    let fired = false;
    const stale = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'app') {
          return new Proxy(target.app, {
            get(t, p) {
              if (p === 'findMany') {
                return async (...a: unknown[]) => {
                  const rows = await (t as any).findMany(...a);
                  if (!fired) { fired = true; await M.uninstallApp({}, { ref: app.id }, ctx()); }
                  return rows;
                };
              }
              const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v;
            },
          });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as typeof db;
    expect(await evaluateDarkWorkers(stale, NOW)).toEqual([]);
    expect(fired).toBe(true);
    expect(await db.app.findUniqueOrThrow({ where: { id: app.id } }).then((a) => a.uninstalledAt)).not.toBeNull();
    expect(await episodes()).toHaveLength(0);
  });
});
