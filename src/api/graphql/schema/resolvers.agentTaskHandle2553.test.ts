/**
 * #2553 (epic #1704, T12): every AgentTask has a per-App short handle `AT<n>`. An alias for the id, never a
 * replacement: numbers are permanent, counted per App, and a handle that names no readable task answers
 * byte-identically to an unknown id (cor:agt:050:01 Proposed handle paragraph, cor:agt:050:21).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { readFileSync } from 'node:fs';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const T = (resolvers as any).AgentTask as Record<string, (t: any, a: unknown, c: Context) => unknown>;

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
  return expect.fail('expected a refusal');
}

let org: { id: string; urn: string };
let alice: { id: string }; // ADMIN member of the org, AppMember of X and Y: belongs to two Apps
let bob: { id: string };   // AppMember of X only: belongs to one App
let eve: { id: string };   // belongs to no App
let appX: { id: string; urn: string };
let appY: { id: string; urn: string };
let appZ: { id: string; urn: string }; // another org; alice cannot read it
let keyX: { id: string };
let agentId: string;
let anne: { id: string };

const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: ['READER'] });
const keyCtx = (): Context => ({ db, appId: appX.id, appKeyId: keyX.id, roles: [] });
const mk = (app: { id: string }, title: string, u = alice) => M.createAgentTask({}, { input: { appRef: app.id, title } }, as(u));
const user = (githubId: number) => db.user.create({ data: { id: generateId(), githubId, githubUsername: `u${githubId}-${generateId().slice(0, 6)}`, roles: ['READER'] }, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'h-org', urn: `h-org-${suffix}.com` } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'z-org', urn: `z-org-${suffix}.com` } });
  alice = await user(99_201);
  bob = await user(99_202);
  eve = await user(99_203);
  const zed = await user(99_204);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: alice.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: zed.id, role: 'ADMIN' } });
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  appZ = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Z', urn: `${otherOrg.urn}:z` } });
  await db.appMember.create({ data: { appId: appX.id, userId: alice.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appY.id, userId: alice.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appX.id, userId: bob.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appZ.id, userId: zed.id, role: 'member' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, as(alice));
  agentId = agent.id;
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appX.id, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
});

describe('numbering (item 1, 2)', () => {
  it('N parallel creates in one App get distinct gap-free numbers 1..N; another App counts on its own', async () => {
    const made = await Promise.all(Array.from({ length: 8 }, (_, i) => mk(appX, `t${i}`)));
    expect(made.map((t: any) => Number(t.taskNumber)).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Number((await mk(appY, 'first on Y') as any).taskNumber)).toBe(1);
  });

  it('exposes handle and taskNumber on the task', async () => {
    const t: any = await mk(appX, 'one');
    expect(await T.handle!(t, {}, as(alice))).toBe('AT1');
    expect(await T.taskNumber!(t, {}, as(alice))).toBe(1);
  });

  it('cancelling a task does not free its number; the next task takes the next', async () => {
    const a: any = await mk(appX, 'a');
    await M.cancelAgentTask({}, { taskId: a.id }, as(alice));
    expect(Number(((await mk(appX, 'b')) as any).taskNumber)).toBe(2);
  });

  it('a rolled-back create returns its number: no committed task, no gap', async () => {
    await expect(db.$transaction(async (tx) => {
      await tx.agentTask.create({ data: { appId: appX.id, title: 'doomed', ownerUserId: alice.id } });
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect(Number(((await mk(appX, 'after')) as any).taskNumber)).toBe(1);
  });

  it('a writer that states no number still gets one, and a committed number cannot be changed', async () => {
    const row = await db.agentTask.create({ data: { appId: appX.id, title: 'raw', ownerUserId: alice.id } });
    expect(row.taskNumber).toBe(1n);
    await expect(db.agentTask.update({ where: { id: row.id }, data: { taskNumber: 9n } })).rejects.toThrow(/permanent/);
    await expect(db.agentTask.create({ data: { appId: appX.id, title: 'dup', ownerUserId: alice.id, taskNumber: 1n } })).rejects.toThrow();
  });

  it('the migration carries a byte-identical copy of the invariants file', () => {
    const source = readFileSync(new URL('../../../../prisma/agent-task-number-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../../prisma/migrations/20261027060000_agent_task_number/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(source)).toBe(true);
  });
});

describe('resolution (item 3, 4, 5)', () => {
  it('a person in exactly one App reads by bare handle, case-insensitively; id still works', async () => {
    const t: any = await mk(appX, 'x1', bob);
    expect((await Q.agentTask({}, { id: 'AT1' }, as(bob)))?.id).toBe(t.id);
    expect((await Q.agentTask({}, { id: 'at1' }, as(bob)))?.id).toBe(t.id);
    expect((await Q.agentTask({}, { id: t.id }, as(bob)))?.id).toBe(t.id);
  });

  it('every task operation takes the handle', async () => {
    // Only the parent's assignee creates its children, so the parent is assigned to bob.
    const t: any = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'ops', assignee: { user: bob.id } } }, as(bob));
    expect((await Q.agentTaskTree({}, { root: 'AT1' }, as(bob)))?.map((r: any) => r.id)).toEqual([t.id]);
    const child: any = await M.createAgentTask({}, { input: { parentTaskId: 'AT1', title: 'child' } }, as(bob));
    expect(child.parentTaskId).toBe(t.id);
    expect((await Q.agentTasks({}, { appRef: appX.id, parentTaskId: 'AT1' }, as(bob))).map((r: any) => r.id)).toEqual([child.id]);
    const events = await Q.agentTeamEvents({}, { appRef: appX.id, taskId: 'AT2' }, as(bob));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e: any) => e.taskId === child.id)).toBe(true);
    const cancelled = await M.cancelAgentTask({}, { taskId: 'AT2' }, as(bob));
    expect(cancelled.id).toBe(child.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('an App key reads by bare handle within its own App only', async () => {
    const x: any = await mk(appX, 'x1');
    await mk(appY, 'y1');
    expect((await Q.agentTask({}, { id: 'AT1' }, keyCtx()))?.id).toBe(x.id);
    expect(await Q.agentTask({}, { id: 'AT2' }, keyCtx())).toBeNull();
  });

  it('a worker session resolves a bare handle in the session\'s App', async () => {
    const x: any = await mk(appX, 'x1');
    const y: any = await mk(appY, 'y1');
    await mk(appY, 'y2');
    const got = await runAsActor({ workerId: anne.id, agentId }, () => Q.agentTask({}, { id: 'AT1' }, as(alice)));
    expect(got?.id).toBe(x.id);
    expect(got?.id).not.toBe(y.id);
    expect(await runAsActor({ workerId: anne.id, agentId }, () => Q.agentTask({}, { id: 'AT2' }, as(alice)))).toBeNull();
  });

  it('a person in several Apps: a bare handle is refused "qualify it", the same whether or not the number exists', async () => {
    await mk(appX, 'x1');
    const exists = await refusal(Q.agentTask({}, { id: 'AT1' }, as(alice)));
    const absent = await refusal(Q.agentTask({}, { id: 'AT999' }, as(alice)));
    expect(exists.extensions?.code).toBe('TASK_HANDLE_QUALIFY');
    expect(absent.extensions?.code).toBe('TASK_HANDLE_QUALIFY');
    expect(exists.message).toBe(absent.message);
    expect({ ...exists.extensions, taskId: null }).toEqual({ ...absent.extensions, taskId: null });
    const mutation = await refusal(M.cancelAgentTask({}, { taskId: 'AT1' }, as(alice)));
    expect(mutation.extensions?.code).toBe('TASK_HANDLE_QUALIFY');
  });

  it('the qualified form names the App by its URN, and resolves for a person in several Apps', async () => {
    const y: any = await mk(appY, 'y1');
    await mk(appX, 'x1');
    expect((await Q.agentTask({}, { id: `hrn:agenttask:${appY.urn}:AT1` }, as(alice)))?.id).toBe(y.id);
    expect((await Q.agentTask({}, { id: `hrn:agenttask:${appX.urn}:at1` }, as(alice)))?.id).not.toBe(y.id);
  });

  it('unknown, foreign-App and unreadable-App handles answer byte-identically to an unknown id, echo included', async () => {
    const z: any = await mk(appZ, 'z1', (await db.appMember.findFirstOrThrow({ where: { appId: appZ.id } }).then((m) => ({ id: m.userId }))));
    expect(z.taskNumber).toBeDefined();
    await mk(appX, 'x1', bob);
    const unknownId = generateId();
    const probes = [
      { input: unknownId },
      { input: 'AT999' },
      { input: `hrn:agenttask:${appZ.urn}:AT1` }, // an App bob cannot read
      { input: `hrn:agenttask:${appZ.urn}:AT999` },
      { input: `hrn:agenttask:no-such.org:app:AT1` },
    ];
    for (const who of [bob]) {
      for (const p of probes) {
        const e = await refusal(M.cancelAgentTask({}, { taskId: p.input }, as(who)));
        expect(e.extensions?.code).toBe('TASK_NOT_FOUND');
        expect(e.message).toBe('Task not found.');
        expect(e.extensions?.taskId).toBe(p.input);
        expect(Object.keys(e.extensions ?? {}).sort()).toEqual(['code', 'taskId']);
        expect(await Q.agentTask({}, { id: p.input }, as(who))).toBeNull();
      }
    }
    // The same for a person in no App, for a key asking about another App, and for a worker session.
    for (const p of probes) {
      expect(await Q.agentTask({}, { id: p.input }, as(eve))).toBeNull();
      expect(await Q.agentTask({}, { id: p.input }, keyCtx())).toBeNull();
      expect(await runAsActor({ workerId: anne.id, agentId }, () => Q.agentTask({}, { id: p.input }, as(alice)))).toBeNull();
    }
    expect((await refusal(M.cancelAgentTask({}, { taskId: 'AT1' }, as(eve)))).extensions?.code).toBe('TASK_NOT_FOUND');
  });

  it('a person who belongs to no App is told nothing a stranger would not hear', async () => {
    await mk(appX, 'x1');
    const e = await refusal(M.cancelAgentTask({}, { taskId: 'AT1' }, as(eve)));
    const f = await refusal(M.cancelAgentTask({}, { taskId: 'AT777' }, as(eve)));
    expect(e.extensions).toEqual({ code: 'TASK_NOT_FOUND', taskId: 'AT1' });
    expect(f.extensions).toEqual({ code: 'TASK_NOT_FOUND', taskId: 'AT777' });
  });

  it.each(['AT', 'AT-1', 'AT0', 'AT0312', 'AT312 ', ' AT312', 'AT3.12', 'AT99999999999999999999', 'XAT1', 'AT1x'])(
    'a malformed handle %j falls through to the unknown-id answer',
    async (bad) => {
      await mk(appX, 'x1', bob);
      expect(await Q.agentTask({}, { id: bad }, as(bob))).toBeNull();
      expect((await refusal(M.cancelAgentTask({}, { taskId: bad }, as(bob)))).extensions).toEqual({ code: 'TASK_NOT_FOUND', taskId: bad });
    },
  );

  it('a number past the bigint range is unknown, never an error', async () => {
    await mk(appX, 'x1', bob);
    expect(await Q.agentTask({}, { id: 'AT9223372036854775808' }, as(bob))).toBeNull();
    expect(await Q.agentTask({}, { id: 'AT9223372036854775807' }, as(bob))).toBeNull();
  });
});
