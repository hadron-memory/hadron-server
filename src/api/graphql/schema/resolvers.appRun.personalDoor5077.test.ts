/**
 * hadron-server#5077 (Billing F3a, second PR F3a-2): the manual-run door, reading and cancelling a run of an App a person
 * owns, the SDL and MCP. F3a-1 (#5420) built the data, the owner value on the run path and an interim fail-closed refusal
 * of every read and cancel of a person's run; this file pins the ruled "Who" table that replaces it (cor:dmo:050:12):
 *
 * | Caller on a person's App                      | Launch | Read one run              | Cancel                       |
 * | owner, or an owner-role member, as themself   | yes    | yes                       | yes                          |
 * | the App's own key (no user)                   | yes    | yes (existing arm)        | no (decision c not built)    |
 * | ordinary member; subscriber of the Agent      | no     | only their own run        | no                           |
 * | platform admin                                | no     | no                        | yes, no run content (Q4)     |
 * | impersonated session, run principal, other    | no     | no                        | no                           |
 *
 * Red on main (69fcb0bd): the door answers "Manual runs are not supported for user-owned Apps yet." (BAD_USER_INPUT) to
 * everyone, every read of a person's run is null and every cancel refused; `AppRun.organizationId` is `ID!` and there is
 * no `ownerUserId` field. Also answers Belinda's #5420 P3-7 (adoption of a person's MANUAL run) and P3-9 (a merge moves
 * every App a person owns in the transaction that moves their runs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../integrations/objectstore/index.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

import { buildSchema, isNonNullType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { mintAppRun } from '../../../jobs/appRuns.js';
import { composeAppRunUrn } from '../../../lib/entityRef/appRunRef.js';
import { isOwnedBy } from '../../../lib/owner.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import type { AuthContext } from '../../../middleware/auth.js';

const ON = 'PERSONAL_APP_RUNS_ENABLED';
let saved: string | undefined;
beforeEach(async () => {
  saved = process.env[ON];
  process.env[ON] = 'true';
  vi.clearAllMocks();
  await cleanDb(db);
});
afterEach(() => {
  if (saved === undefined) delete process.env[ON]; else process.env[ON] = saved;
});

const Q = resolvers.Query as Record<string, (...a: unknown[]) => Promise<any>>;
const M = resolvers.Mutation as Record<string, (...a: unknown[]) => Promise<any>>;

type Person = { user: { id: string }; app: { id: string }; agent: { id: string }; memory: { id: string }; entryUrn: string; entryId: string; handle: string };

/** A person with their own App, Agent and the App's own memory (class app, owned by them), and a runnable entry in it. */
async function person(handle: string): Promise<Person> {
  const user = await db.user.create({ data: { handle } });
  const app = await db.app.create({ data: { name: `${handle} app`, urn: `${handle}:app`, ownerUserId: user.id } });
  const agent = await db.agent.create({ data: { name: `${handle} agent`, urn: `${handle}:agent`, ownerUserId: user.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const memory = await db.memory.create({ data: { name: `${handle} flow`, urn: `${handle}:flow`, class: 'app', appId: app.id, ownerUserId: user.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: memory.id, role: 'read-write' } });
  const entry = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, nodeType: 'task', content: 'Say ok.' } });
  return { user, app, agent, memory, entryUrn: `hrn:node:${handle}:flow:entry`, entryId: entry.id, handle };
}

const as = (userId: string, extra: Record<string, unknown> = {}) => ({ db, userId, roles: [], clientId: `user:${userId}`, ...extra }) as unknown as Context;
const appKey = (p: Person) => ({ db, appId: p.app.id, roles: [], clientId: `app:${p.app.id}` }) as unknown as Context;
async function userWith(handle: string, roles: string[] = []) {
  return db.user.create({ data: { handle, roles } });
}
async function member(p: Person, handle: string, role: string) {
  const u = await userWith(handle);
  await db.appMember.create({ data: { appId: p.app.id, userId: u.id, role } });
  return u;
}
async function subscriber(p: Person, handle: string) {
  const u = await userWith(handle);
  await db.agentSubscription.create({ data: { userId: u.id, agentId: p.agent.id, activatedAt: new Date() } as never });
  return u;
}

const trigger = (p: Person, ctx: Context, extra: Record<string, unknown> = {}) =>
  M.triggerAppRun({}, { input: { appRef: p.app.id, entryNodeUrn: p.entryUrn, ...extra } }, ctx);
const runTask = (p: Person, ctx: Context) => M.runTask({}, { nodeRef: p.entryUrn, appRef: p.app.id }, ctx);
const importTask = (p: Person, ctx: Context) => M.importNode({}, { input: {
  memoryRef: p.memory.id, loc: `clips:${generateId()}`, content: '# Imported', contentType: 'text/markdown', taskRef: p.entryId, appRef: p.app.id,
} }, ctx);
const code = (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code;
const mint = (p: Person, extra: Partial<Parameters<typeof mintAppRun>[1]> = {}) => mintAppRun(db, {
  owner: { userId: p.user.id }, appId: p.app.id, agentId: p.agent.id, triggerKind: 'MANUAL', entryNodeUrn: p.entryUrn, publish: false, ...extra,
});

describe('#5077 acceptance 1: the door launches for the owner, an owner-role member and the App key', () => {
  it('the owner\'s triggerAppRun is PENDING with organizationId null and ownerUserId the owner', async () => {
    const a = await person('pd5077');
    const run = await trigger(a, as(a.user.id));
    expect(run).toMatchObject({ status: 'PENDING', organizationId: null, ownerUserId: a.user.id, appId: a.app.id, createdBy: a.user.id });
  });

  it('an owner-role member gets the same; the run is the App owner\'s, not the member\'s', async () => {
    const a = await person('pd5077');
    const co = await member(a, 'co5077', 'owner');
    await expect(trigger(a, as(co.id))).resolves.toMatchObject({ status: 'PENDING', organizationId: null, ownerUserId: a.user.id, createdBy: co.id });
  });

  it('runAsSelf by an owner with no member row passes the relationship check', async () => {
    const a = await person('pd5077');
    expect(await db.appMember.count({ where: { appId: a.app.id } })).toBe(0);
    await expect(trigger(a, as(a.user.id), { runAsSelf: true })).resolves.toMatchObject({ userId: a.user.id, ownerUserId: a.user.id });
  });

  it('runTask(appRef:) and importNode(taskRef:) launch for the owner too', async () => {
    const a = await person('pd5077');
    const id = await runTask(a, as(a.user.id));
    expect(await db.appRun.findUniqueOrThrow({ where: { id } })).toMatchObject({ organizationId: null, ownerUserId: a.user.id });
    const imported = await importTask(a, as(a.user.id));
    expect(await db.appRun.findUniqueOrThrow({ where: { id: imported.runId } })).toMatchObject({ organizationId: null, ownerUserId: a.user.id });
  });

  it('the App\'s own key launches a run with no user', async () => {
    const a = await person('pd5077');
    await expect(trigger(a, appKey(a))).resolves.toMatchObject({ status: 'PENDING', ownerUserId: a.user.id, userId: null });
  });
});

describe('#5077 acceptance 2: nobody else launches on a person\'s App (FORBIDDEN, no row)', () => {
  const callers: Array<[string, (a: Person) => Promise<Context>]> = [
    ['an ordinary member', async a => as((await member(a, 'mem5077', 'member')).id)],
    ['a subscriber of the App\'s Agent', async a => as((await subscriber(a, 'sub5077')).id)],
    ['a platform admin', async () => ({ ...as((await userWith('adm5077', ['ADMIN'])).id), roles: ['ADMIN'] }) as unknown as Context],
    ['the owner under impersonation', async a => as(a.user.id, { impersonation: { actorUserId: generateId() } })],
    ['a user who only SELECTED the App (a user principal with appId set)', async a => as((await userWith('sel5077')).id, { appId: a.app.id })],
  ];
  for (const [label, ctxOf] of callers) {
    it(`${label}: triggerAppRun, runTask(appRef:) and importNode(taskRef:) are FORBIDDEN`, async () => {
      const a = await person('pd5077');
      const ctx = await ctxOf(a);
      for (const door of [trigger, runTask, importTask]) {
        const err = await door(a, ctx).then(() => null, (e: unknown) => e);
        expect(code(err), `${label} via ${door === trigger ? 'triggerAppRun' : door === runTask ? 'runTask' : 'importNode'}`).toBe('FORBIDDEN');
      }
      expect(await db.appRun.count()).toBe(0);
    });
  }

  it('MCP hadron_run_task: a user who only selected the App gets no run', async () => {
    const a = await person('pd5077');
    const u = await userWith('sel5077');
    const text = await createTestableMcpServer({ userId: u.id, appId: a.app.id, roles: ['READER'], clientId: `user:${u.id}` } as AuthContext)
      .callToolText('hadron_run_task', { urn: a.entryUrn, appRef: a.app.id });
    expect(text).not.toMatch(/^Run started/);
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#5077 acceptance 3: another person\'s memory at the door', () => {
  it('A\'s App with the entry in B\'s memory is ENTRY_NOT_IN_ORG before any write, and importNode writes no node', async () => {
    const a = await person('pd5077');
    const b = await person('pe5077');
    expect(code(await trigger(a, as(a.user.id), { entryNodeUrn: b.entryUrn }).catch((e: unknown) => e))).toBe('ENTRY_NOT_IN_ORG');
    const nodesBefore = await db.node.count();
    expect(code(await M.importNode({}, { input: {
      memoryRef: a.memory.id, loc: 'clips:x', content: '# x', contentType: 'text/markdown', taskRef: b.entryId, appRef: a.app.id,
    } }, as(a.user.id)).catch((e: unknown) => e))).toBe('ENTRY_NOT_IN_ORG');
    expect(await db.node.count()).toBe(nodesBefore);
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#5077 acceptance 11: with the switch off the door is main\'s, byte for byte', () => {
  it('the owner gets main\'s text and code; an outsider still gets main\'s FORBIDDEN first', async () => {
    const a = await person('pd5077');
    for (const value of [undefined, 'TRUE', '1', ' true']) {
      if (value === undefined) delete process.env[ON]; else process.env[ON] = value;
      const err = await trigger(a, as(a.user.id)).catch((e: unknown) => e) as { message: string; extensions: { code: string } };
      expect(err.message).toBe('Manual runs are not supported for user-owned Apps yet.');
      expect(err.extensions.code).toBe('BAD_USER_INPUT');
      const outsider = await userWith(`out${generateId().slice(-6)}`);
      expect(code(await trigger(a, as(outsider.id)).catch((e: unknown) => e))).toBe('FORBIDDEN');
    }
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#5077 acceptance 5: reading a person\'s run', () => {
  it('the owner and an owner-role member read it through appRun, latestAppRun, resolveUrn and MCP hadron_get_run', async () => {
    const a = await person('pd5077');
    const co = await member(a, 'co5077', 'owner');
    const run = await mint(a); // App-only: not on anyone's behalf, started by nobody
    for (const u of [a.user.id, co.id]) {
      expect(await Q.appRun({}, { ref: run.id }, as(u))).toMatchObject({ id: run.id });
      expect(await Q.latestAppRun({}, { appRef: a.app.id }, as(u))).toMatchObject({ id: run.id });
      expect(await Q.resolveUrn({}, { urn: composeAppRunUrn(`${a.handle}:app`, run.id) }, as(u))).toMatchObject({ kind: 'apprun', id: run.id });
      const text = await createTestableMcpServer({ userId: u, roles: ['READER'], clientId: `user:${u}` } as AuthContext)
        .callToolText('hadron_get_run', { ref: run.id });
      expect(text).toContain(run.id);
    }
  });

  it('the App\'s own key reads its run (the existing arm)', async () => {
    const a = await person('pd5077');
    const run = await mint(a);
    expect(await Q.appRun({}, { ref: run.id }, appKey(a))).toMatchObject({ id: run.id });
  });

  it('an ordinary member reads only their own run (on their behalf, or one they started), never another\'s', async () => {
    const a = await person('pd5077');
    const m = await member(a, 'mem5077', 'member');
    const mine = await mint(a, { userId: m.id });
    const started = await mint(a, { createdBy: m.id });
    const other = await mint(a);
    expect(await Q.appRun({}, { ref: mine.id }, as(m.id))).toMatchObject({ id: mine.id });
    expect(await Q.appRun({}, { ref: started.id }, as(m.id))).toMatchObject({ id: started.id });
    expect(await Q.appRun({}, { ref: other.id }, as(m.id))).toBeNull();
    // latestAppRun is the App's latest run, whoever's: a manager's read only.
    await expect(Q.latestAppRun({}, { appRef: a.app.id }, as(m.id))).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('a platform admin, another person and the impersonated owner read nothing, like a missing run', async () => {
    const a = await person('pd5077');
    const b = await person('pe5077');
    const run = await mint(a, { userId: a.user.id, createdBy: a.user.id });
    const admin = { ...as((await userWith('adm5077', ['ADMIN'])).id), roles: ['ADMIN'] } as unknown as Context;
    const imp = as(a.user.id, { impersonation: { actorUserId: generateId() } });
    for (const ctx of [admin, as(b.user.id), imp]) {
      expect(await Q.appRun({}, { ref: run.id }, ctx)).toBeNull();
      expect(await Q.appRun({}, { ref: generateId() }, ctx)).toBeNull();
      expect(await Q.resolveUrn({}, { urn: composeAppRunUrn(`${a.handle}:app`, run.id) }, ctx)).toBeNull();
      await expect(Q.latestAppRun({}, { appRef: a.app.id }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    }
    const text = await createTestableMcpServer({ userId: b.user.id, roles: ['READER'], clientId: `user:${b.user.id}` } as AuthContext)
      .callToolText('hadron_get_run', { ref: run.id });
    expect(text).toBe('Run not found.');
  });

  it('AppRun.servedPrompt answers through the same gate: null for a platform admin', async () => {
    const a = await person('pd5077');
    const run = await mint(a);
    const admin = { ...as((await userWith('adm5077', ['ADMIN'])).id), roles: ['ADMIN'] } as unknown as Context;
    const served = (resolvers as unknown as { AppRun: { servedPrompt: (r: unknown, a: unknown, c: Context) => Promise<unknown> } }).AppRun.servedPrompt;
    expect(await served(run, {}, admin)).toBeNull();
  });

  it('limit (Celine, #5420 QA): appRuns(appRef:) lists no run of a person\'s App; the run list is F3c', async () => {
    const a = await person('pd5077');
    await mint(a);
    const err = await Q.appRuns({}, { appRef: a.app.id }, as(a.user.id)).catch((e: unknown) => e);
    expect(code(err)).toBe('BAD_USER_INPUT');
  });
});

describe('#5077 acceptance 5: cancelling a person\'s run', () => {
  it('the owner and an owner-role member cancel it, with the full run in the answer', async () => {
    const a = await person('pd5077');
    const co = await member(a, 'co5077', 'owner');
    for (const u of [a.user.id, co.id]) {
      const run = await mint(a, { eventData: { k: 'v' } });
      const out = await M.cancelAppRun({}, { ref: run.id }, as(u));
      expect(out).toMatchObject({ id: run.id, status: 'CANCELLED', entryNodeUrn: a.entryUrn, eventData: { k: 'v' } });
    }
  });

  it('a platform admin cancels it (by id and by URN) and the answer carries no run content (Q4)', async () => {
    const a = await person('pd5077');
    const admin = { ...as((await userWith('adm5077', ['ADMIN'])).id), roles: ['ADMIN'] } as unknown as Context;
    for (const byUrn of [false, true]) {
      const run = await mint(a, { eventData: { secret: 'x' } });
      await db.appRun.update({ where: { id: run.id }, data: {
        status: 'RUNNING', data: { out: 1 }, hops: [{ n: 1 }], curNodeUrn: a.entryUrn, policy: { allow: ['run.execute'] },
      } as never });
      const ref = byUrn ? composeAppRunUrn(`${a.handle}:app`, run.id) : run.id;
      const out = await M.cancelAppRun({}, { ref }, admin) as Record<string, unknown>;
      expect(out).toMatchObject({ id: run.id, status: 'CANCELLED', appId: a.app.id, ownerUserId: a.user.id, organizationId: null });
      for (const f of ['eventData', 'data', 'hops', 'failure', 'curNodeUrn', 'policy', 'registerSnapshot', 'scopeSnapshot', 'spawn', 'derivedLog', 'automationPin']) {
        expect(out[f] ?? null, f).toBeNull();
      }
      expect(out.entryNodeUrn).toBe('');
      expect(out.entryNodeId ?? null).toBeNull();
      const served = (resolvers as unknown as { AppRun: { servedPrompt: (r: unknown, a: unknown, c: Context) => Promise<unknown> } }).AppRun.servedPrompt;
      expect(await served(out, {}, admin)).toBeNull();
      expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('CANCELLED');
    }
  });

  it('the App\'s own key and an ordinary member who started the run are FORBIDDEN, and the run stays PENDING', async () => {
    const a = await person('pd5077');
    const m = await member(a, 'mem5077', 'member');
    const run = await mint(a, { userId: m.id, createdBy: m.id });
    for (const ctx of [appKey(a), as(m.id)]) {
      expect(code(await M.cancelAppRun({}, { ref: run.id }, ctx).catch((e: unknown) => e))).toBe('FORBIDDEN');
    }
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('PENDING');
  });

  it('another person and the impersonated owner get NOT_FOUND, as for a missing run', async () => {
    const a = await person('pd5077');
    const b = await person('pe5077');
    const run = await mint(a);
    const imp = as(a.user.id, { impersonation: { actorUserId: generateId() } });
    const impAdmin = { ...as((await userWith('adm5077', ['ADMIN'])).id, { impersonation: { actorUserId: generateId() } }), roles: ['ADMIN'] } as unknown as Context;
    for (const ctx of [as(b.user.id), imp, impAdmin]) {
      expect(code(await M.cancelAppRun({}, { ref: run.id }, ctx).catch((e: unknown) => e))).toBe('NOT_FOUND');
    }
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('PENDING');
  });
});

describe('#5077 acceptance 7 (schema): AppRun names its owner', () => {
  it('AppRun.organizationId is nullable and AppRun.ownerUserId exists, nullable', () => {
    const t = buildSchema(typeDefs as string, { assumeValidSDL: true }).getType('AppRun') as { getFields(): Record<string, { type: unknown }> };
    const fields = t.getFields();
    expect(fields.organizationId).toBeDefined();
    expect(isNonNullType(fields.organizationId.type)).toBe(false);
    expect(fields.ownerUserId).toBeDefined();
    expect(isNonNullType(fields.ownerUserId.type)).toBe(false);
  });
});

describe('Belinda #5420 P3-7: adoption of a person\'s MANUAL run', () => {
  it('the owner previews, approves and declines it (no raw error); another person is refused', async () => {
    const a = await person('pd5077');
    const b = await person('pe5077');
    const run = await mint(a);
    const input = { triggerKind: 'MANUAL', triggerRef: run.id };
    const detail = await Q.automationApproval({}, input, as(a.user.id));
    expect(detail).toMatchObject({ state: expect.any(String) });
    await expect(Q.previewAutomation({}, input, as(a.user.id))).resolves.toBeTruthy();
    await expect(M.declineAutomation({}, input, as(a.user.id))).resolves.toBe(true);
    const err = await Q.automationApproval({}, input, as(b.user.id)).catch((e: unknown) => e);
    expect(code(err)).toBe('FORBIDDEN');
  });
});

describe('Belinda #5420 P3-9: a merge moves every App a person owns with their runs, in one transaction', () => {
  it('live, soft-deleted and uninstalled Apps of A all name B after the merge, and every run is owned by its App\'s owner', async () => {
    const a = await person('pd5077');
    const b = await userWith('pf5077');
    const dead = await db.app.create({ data: { name: 'dead', urn: 'pd5077:dead', ownerUserId: a.user.id, deletedAt: new Date() } });
    const gone = await db.app.create({ data: { name: 'gone', urn: 'pd5077:gone', ownerUserId: a.user.id, uninstalledAt: new Date() } });
    const runs = [await mint(a)];
    for (const app of [dead, gone]) {
      runs.push(await db.appRun.create({ data: { id: generateId(), ownerUserId: a.user.id, appId: app.id, agentId: a.agent.id, triggerKind: 'MANUAL', entryNodeUrn: a.entryUrn, status: 'COMPLETED' } }));
    }
    const admin = await userWith('adm5077', ['ADMIN']);
    await mergeUsers(db, { sourceUserId: a.user.id, targetUserId: b.id, actorUserId: admin.id });
    expect(await db.app.count({ where: { ownerUserId: a.user.id } })).toBe(0);
    for (const r of runs) {
      const run = await db.appRun.findUniqueOrThrow({ where: { id: r.id } });
      const app = await db.app.findUniqueOrThrow({ where: { id: run.appId } });
      expect(run.ownerUserId).toBe(b.id);
      expect(isOwnedBy(app, { userId: run.ownerUserId! })).toBe(true);
    }
  });
});
