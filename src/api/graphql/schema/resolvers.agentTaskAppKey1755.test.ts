/**
 * #1755 — the App's own key may read its tasks and events (cor:agt:050:21).
 * READ-ONLY: it never creates, assigns or cancels, and never acts as a worker.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let member: { id: string };
let appX: { id: string; urn: string };
let appY: { id: string; urn: string };
let keyX: { id: string };
let agentId: string;
let anne: { id: string };

const userCtx = (): Context => ({ db, userId: member.id, roles: ['READER'] });
const keyCtx = (extra: Partial<Context> = {}): Context => ({ db, appId: appX.id, appKeyId: keyX.id, roles: [], ...extra });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'ak-org', urn: `ak-org-${suffix}.com` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 98_100, githubUsername: `ak-${suffix}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'ADMIN' } });
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  await db.appMember.create({ data: { appId: appX.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appY.id, userId: member.id, role: 'member' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, userCtx());
  agentId = agent.id;
  anne = await db.worker.create({ data: { id: generateId(), appId: appX.id, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
});

const mk = (appRef: string, title: string) =>
  M.createAgentTask({}, { input: { appRef, title } }, userCtx());

describe('an App key reads its OWN App\'s tasks and events (#1755)', () => {
  it('lists, gets and trees the tasks of its App, and reads its event stream', async () => {
    const t = await mk(appX.id, 'on X');
    await mk(appY.id, 'on Y');
    const list = await Q.agentTasks({}, { appRef: appX.id }, keyCtx());
    expect(list.map((r: { id: string }) => r.id)).toEqual([t.id]);
    expect((await Q.agentTask({}, { id: t.id }, keyCtx()))?.id).toBe(t.id);
    expect((await Q.agentTaskTree({}, { root: t.id }, keyCtx()))?.map((r: { id: string }) => r.id)).toEqual([t.id]);
    const events = await Q.agentTeamEvents({}, { appRef: appX.urn }, keyCtx());
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e: { appId: string }) => e.appId === appX.id)).toBe(true);
  });

  it('another App answers like a missing one, for lists, gets, trees and events', async () => {
    const y = await mk(appY.id, 'on Y');
    await expectCode(Q.agentTasks({}, { appRef: appY.id }, keyCtx()), 'APP_NOT_FOUND');
    await expectCode(Q.agentTeamEvents({}, { appRef: appY.id }, keyCtx()), 'APP_NOT_FOUND');
    await expectCode(Q.agentTasks({}, { appRef: generateId() }, keyCtx()), 'APP_NOT_FOUND');
    expect(await Q.agentTask({}, { id: y.id }, keyCtx())).toBeNull();
    expect(await Q.agentTaskTree({}, { root: y.id }, keyCtx())).toBeNull();
  });

  it('a revoked key reads nothing, at once', async () => {
    const t = await mk(appX.id, 'on X');
    await db.appKey.update({ where: { id: keyX.id }, data: { revokedAt: new Date() } });
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx()), 'APP_NOT_FOUND');
    expect(await Q.agentTask({}, { id: t.id }, keyCtx())).toBeNull();
  });

  it('a deleted App reads as missing', async () => {
    const t = await mk(appX.id, 'on X');
    await db.app.update({ where: { id: appX.id }, data: { deletedAt: new Date() } });
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx()), 'APP_NOT_FOUND');
    expect(await Q.agentTask({}, { id: t.id }, keyCtx())).toBeNull();
  });

  it('a key carrying a session is refused, never narrowed or run as the worker', async () => {
    await mk(appX.id, 'on X');
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx({ sessionId: generateId() })), 'APP_KEY_SESSION_BOUND');
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx({ sessionBindingRefused: true })), 'APP_KEY_SESSION_BOUND');
    await expectCode(
      runAsActor({ workerId: anne.id, agentId }, () => Q.agentTasks({}, { appRef: appX.id }, keyCtx())),
      'APP_KEY_SESSION_BOUND',
    );
    // A foreign App is still "not found" first, not a session refusal.
    await expectCode(Q.agentTasks({}, { appRef: appY.id }, keyCtx({ sessionId: generateId() })), 'APP_NOT_FOUND');
  });

  it('is read-only: every write is refused and nothing is written', async () => {
    const t = await mk(appX.id, 'on X');
    const before = await db.agentTeamEvent.count();
    await expectCode(M.createAgentTask({}, { input: { appRef: appX.id, title: 'nope' } }, keyCtx()), 'APP_NOT_FOUND');
    await expectCode(M.cancelAgentTask({}, { taskId: t.id }, keyCtx()), 'TASK_NOT_FOUND');
    await expectCode(M.assignAgentTask({}, { taskId: t.id, assignee: { worker: anne.id } }, keyCtx()), 'TASK_NOT_FOUND');
    await expectCode(
      runAsActor({ workerId: anne.id, agentId }, () => M.createAgentTask({}, { input: { appRef: appX.id, title: 'nope' } }, keyCtx())),
      'APP_NOT_FOUND',
    );
    expect(await db.agentTask.count()).toBe(1);
    expect(await db.agentTeamEvent.count()).toBe(before);
  });

  it('a key id with no key row (no appKeyId at all) is still refused, as before', async () => {
    await mk(appX.id, 'on X');
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, { db, appId: appX.id, roles: [] }), 'APP_NOT_FOUND');
  });
});
