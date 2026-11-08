import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1934 — cor:agt:070:04: a host key never drives the session it starts. "Drives" is ANY session write (Ada's ruling,
 * team chat #11486 item 4): updating, ending, or recording work against it. Two refusals on the shared session write
 * gate (GraphQL `requireSessionWriteAccess`, and MCP `hadron_end_session`, which shares the same predicate). The gate's
 * other two callers, posting to the team chat as a session and recording work against one, already refuse every pure
 * App key upstream (their membership and worklog gates), so they gain the refusal only as defence in depth:
 *
 *  1. No App key writes a host-launched session (one with a `launchOperationId`): not the host key that started it,
 *     nor any other key of the App. The same rule #1883 put on binding, liveness and usage (`ownsSession`).
 *  2. A key that holds, or EVER held, `host:operate` writes no session of its App, launched or not (#1919's rule).
 *
 * 3. Otherwise an App key writes only USER-LESS sessions of its App, the ones App keys start: never a session a person
 *    is behind, worker sessions included (Holger's ruling A via Vera, team chat #11860). #932's purpose, an App
 *    closing the sessions it runs, survives.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { serveEveryAgent } from '../../test/servedBootPrompt.js';
import { generateId } from '../id.js';
import { APP_KEY_PREFIX, hashAppKey, type AuthContext } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../../mcp/server.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let org: { id: string; urn: string };
let app: { id: string };
let manager: { id: string };
let holder: { id: string };
let kit: { id: string };
let orca1: { id: string };
let plainKey: { id: string };

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;
const keyAuth = (k: { id: string }): AuthContext => ({ appId: app.id, appKeyId: k.id, clientId: `app:${app.id}` });

/** Kit's session, started by the manager through orca1 and bound with the holder's token: a host-launched session. */
async function launchedSession(): Promise<{ id: string; opId: string }> {
  const op = await M.issueHostOperation({}, {
    input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worker.start', args: { worktree: 'hadron-server/kit', family: 'claude' } },
  }, ctx(manager.id));
  const [got] = ((await M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1))) as Array<{ id: string; launchGrant: string }>)
    .filter((o) => o.id === op.id);
  const s = await M.startSession({}, { input: { id: generateId(), tool: 'vitest', launchGrant: got!.launchGrant } }, ctx(holder.id));
  expect(s.launchOperationId).toBe(op.id);
  return { id: s.id, opId: op.id };
}

/** An ordinary session of the App, started by a plain App key (no launch). */
async function ordinarySession(): Promise<{ id: string }> {
  const s = await M.startSession({}, { input: { id: generateId(), tool: 'vitest' } }, keyCtx(plainKey));
  expect(s.launchOperationId ?? null).toBeNull();
  return { id: s.id };
}

/** A person's session of the App: attributed to the holder, bound to no worker. */
async function personSession(): Promise<{ id: string }> {
  return db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, tool: 'vitest' }, select: { id: true } });
}

/** A worker session a person holds: Kit, bound by its holder (not launched). */
async function heldWorkerSession(): Promise<{ id: string }> {
  return db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: kit.id, tool: 'vitest' }, select: { id: true } });
}

const update = (c: Context, id: string) => M.updateSession({}, { id, prNumber: 1934, branch: 'driven' }, c);
const end = (c: Context, id: string) => M.endSession({}, { id, summary: 'driven' }, c);
const row = (id: string) => db.session.findUniqueOrThrow({ where: { id }, select: { endedAt: true, prNumber: true, branch: true, summary: true, updatedAt: true } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Gate1934', urn: `gate1934-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `g34-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(61, 'manager');
  holder = await u(62, 'holder');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  orca1 = await mkKey('orca1');
  plainKey = await mkKey('plain');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.registerHost({}, {
    input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }] },
  }, keyCtx(orca1));
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

describe('GraphQL: no App key writes a host-launched session (cor:agt:070:04)', () => {
  it('the host key that started it can neither update nor end it, and the row is untouched', async () => {
    const s = await launchedSession();
    const before = await row(s.id);
    expect(await code(update(keyCtx(orca1), s.id))).toBe('FORBIDDEN');
    expect(await code(end(keyCtx(orca1), s.id))).toBe('FORBIDDEN');
    // An update would also have refreshed its liveness; nothing moved.
    expect(await row(s.id)).toEqual(before);
  });

  it('nor can any other key of the App', async () => {
    const s = await launchedSession();
    const before = await row(s.id);
    expect(await code(update(keyCtx(plainKey), s.id))).toBe('FORBIDDEN');
    expect(await code(end(keyCtx(plainKey), s.id))).toBe('FORBIDDEN');
    expect(await row(s.id)).toEqual(before);
  });

  it('control: the holder still updates and ends their own launched session', async () => {
    const s = await launchedSession();
    expect((await update(ctx(holder.id), s.id)).prNumber).toBe(1934);
    await end(ctx(holder.id), s.id);
    expect((await row(s.id)).endedAt).not.toBeNull();
  });

  it('control: the sanctioned host path, reporting its own worker.end SUCCEEDED, still ends it', async () => {
    const s = await launchedSession();
    const op = await M.issueHostOperation({}, {
      input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worker.end', args: { sessionId: s.id } },
    }, ctx(manager.id));
    expect(((await M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1))) as Array<{ id: string }>).map((o) => o.id)).toContain(op.id);
    expect(await M.reportHostOperation({}, { input: { appRef: app.id, id: op.id, outcome: 'SUCCEEDED' } }, keyCtx(orca1)))
      .toMatchObject({ status: 'succeeded' });
    expect((await row(s.id)).endedAt).not.toBeNull();
  });
});

describe('GraphQL: a key that ever held host:operate writes no session of its App (#1919\'s rule)', () => {
  it('a live host key is refused on an ordinary App session', async () => {
    const s = await ordinarySession();
    const before = await row(s.id);
    expect(await code(update(keyCtx(orca1), s.id))).toBe('FORBIDDEN');
    expect(await code(end(keyCtx(orca1), s.id))).toBe('FORBIDDEN');
    expect(await row(s.id)).toEqual(before);
  });

  it('a key whose host:operate was revoked is still refused: revoking the scope never restores the power', async () => {
    const formerHost = await mkKey('former-host');
    await M.grantAppKeyScope({}, { id: formerHost.id, scope: 'host:operate', hostId: 'orca2' }, ctx(manager.id));
    await M.revokeAppKeyScope({}, { id: formerHost.id, scope: 'host:operate' }, ctx(manager.id));
    const s = await ordinarySession();
    const before = await row(s.id);
    expect(await code(update(keyCtx(formerHost), s.id))).toBe('FORBIDDEN');
    expect(await code(end(keyCtx(formerHost), s.id))).toBe('FORBIDDEN');
    expect(await row(s.id)).toEqual(before);
  });

  it('control (#932\'s purpose, #11860): a plain App key still updates and ends a user-less session of its App', async () => {
    const s = await ordinarySession();
    expect((await update(keyCtx(plainKey), s.id)).prNumber).toBe(1934);
    await end(keyCtx(plainKey), s.id);
    expect((await row(s.id)).endedAt).not.toBeNull();
  });
});

describe('GraphQL: a plain App key writes only user-less sessions (Holger\'s ruling A, #11860)', () => {
  it('refused on a person\'s session', async () => {
    const s = await personSession();
    const before = await row(s.id);
    expect(await code(update(keyCtx(plainKey), s.id))).toBe('FORBIDDEN');
    expect(await code(end(keyCtx(plainKey), s.id))).toBe('FORBIDDEN');
    expect(await row(s.id)).toEqual(before);
  });

  it('refused on a worker session a person holds', async () => {
    const s = await heldWorkerSession();
    const before = await row(s.id);
    expect(await code(update(keyCtx(plainKey), s.id))).toBe('FORBIDDEN');
    expect(await code(end(keyCtx(plainKey), s.id))).toBe('FORBIDDEN');
    expect(await row(s.id)).toEqual(before);
  });

  it('control: the person still updates and ends their own session', async () => {
    const s = await heldWorkerSession();
    expect((await update(ctx(holder.id), s.id)).prNumber).toBe(1934);
    await end(ctx(holder.id), s.id);
    expect((await row(s.id)).endedAt).not.toBeNull();
  });
});

describe('MCP hadron_end_session shares the gate', () => {
  it('the host key cannot end the launched session; neither can a plain key', async () => {
    const s = await launchedSession();
    expect(await createTestableMcpServer(keyAuth(orca1)).callToolText('hadron_end_session', { id: s.id })).toContain('Forbidden');
    expect(await createTestableMcpServer(keyAuth(plainKey)).callToolText('hadron_end_session', { id: s.id })).toContain('Forbidden');
    expect((await row(s.id)).endedAt).toBeNull();
  });

  it('a host key cannot end an ordinary App session either', async () => {
    const s = await ordinarySession();
    expect(await createTestableMcpServer(keyAuth(orca1)).callToolText('hadron_end_session', { id: s.id })).toContain('Forbidden');
    expect((await row(s.id)).endedAt).toBeNull();
  });

  it('a plain App key cannot end a person\'s session or a held worker session (#11860)', async () => {
    for (const s of [await personSession(), await heldWorkerSession()]) {
      expect(await createTestableMcpServer(keyAuth(plainKey)).callToolText('hadron_end_session', { id: s.id })).toContain('Forbidden');
      expect((await row(s.id)).endedAt).toBeNull();
    }
  });

  it('control (#11860): a plain App key still ends a user-less session of its App', async () => {
    const s = await ordinarySession();
    expect(await createTestableMcpServer(keyAuth(plainKey)).callToolText('hadron_end_session', { id: s.id })).toContain('Session ended');
  });
});

/**
 * #1969 (cor:agt:070:07: every call the platform refuses a host key is recorded). The gate above refuses; this is the
 * record of it. A key that is or was a host key leaves one `HostKeyUse` row per refused session write, action
 * `session`, code FORBIDDEN, written apart from the refused call, on both surfaces (one shared site,
 * `appPrincipalSessionWriteAllowed`). A plain App key refused here is not a host key and records nothing.
 */
describe('#1969: a host key\'s refused session write is recorded as a host-key use', () => {
  const sessionUses = () =>
    db.hostKeyUse.findMany({ where: { action: 'session' }, orderBy: [{ usedAt: 'asc' }, { id: 'asc' }] });
  const shape = (u: { appKeyId: string; appId: string; hostId: string; operationId: string | null; count: number | null; refusedCode: string | null }) =>
    [u.appKeyId, u.appId, u.hostId, u.operationId, u.count, u.refusedCode];

  it('GraphQL, the launched-session clause: each refused update and end of the host key records one row', async () => {
    const s = await launchedSession();
    expect(await code(update(keyCtx(orca1), s.id))).toBe('FORBIDDEN');
    expect(await code(end(keyCtx(orca1), s.id))).toBe('FORBIDDEN');
    expect((await sessionUses()).map(shape)).toEqual([
      [orca1.id, app.id, 'orca1', null, null, 'FORBIDDEN'],
      [orca1.id, app.id, 'orca1', null, null, 'FORBIDDEN'],
    ]);
  });

  it('GraphQL, the ever-host clause: a live host key and a revoked one, each under its own host', async () => {
    const formerHost = await mkKey('former-host');
    await M.grantAppKeyScope({}, { id: formerHost.id, scope: 'host:operate', hostId: 'orca2' }, ctx(manager.id));
    await M.revokeAppKeyScope({}, { id: formerHost.id, scope: 'host:operate' }, ctx(manager.id));
    const s = await ordinarySession();
    expect(await code(update(keyCtx(orca1), s.id))).toBe('FORBIDDEN');
    expect(await code(end(keyCtx(formerHost), s.id))).toBe('FORBIDDEN');
    expect((await sessionUses()).map(shape).sort()).toEqual([
      [formerHost.id, app.id, 'orca2', null, null, 'FORBIDDEN'],
      [orca1.id, app.id, 'orca1', null, null, 'FORBIDDEN'],
    ].sort());
  });

  it('MCP hadron_end_session records through the same site, on both clauses', async () => {
    const launched = await launchedSession();
    const ordinary = await ordinarySession();
    for (const s of [launched, ordinary]) {
      expect(await createTestableMcpServer(keyAuth(orca1)).callToolText('hadron_end_session', { id: s.id })).toContain('Forbidden');
    }
    expect((await sessionUses()).map(shape)).toEqual([
      [orca1.id, app.id, 'orca1', null, null, 'FORBIDDEN'],
      [orca1.id, app.id, 'orca1', null, null, 'FORBIDDEN'],
    ]);
  });

  it('the plain-App-key choice: a never-host key refused here records nothing, on either surface', async () => {
    const launched = await launchedSession();
    const person = await personSession();
    for (const s of [launched, person]) {
      expect(await code(update(keyCtx(plainKey), s.id))).toBe('FORBIDDEN');
      expect(await createTestableMcpServer(keyAuth(plainKey)).callToolText('hadron_end_session', { id: s.id })).toContain('Forbidden');
    }
    expect(await db.hostKeyUse.count({ where: { appKeyId: plainKey.id } })).toBe(0);
  });

  it('controls: an admitted write records nothing, and nor does a person refused on someone else\'s session', async () => {
    const userless = await ordinarySession();
    expect((await update(keyCtx(plainKey), userless.id)).prNumber).toBe(1934);
    const held = await heldWorkerSession();
    expect((await update(ctx(holder.id), held.id)).prNumber).toBe(1934);
    expect(await code(update(ctx(manager.id), held.id))).toBe('FORBIDDEN');
    expect(await sessionUses()).toEqual([]);
  });

  it('the record never decides: a failed record leaves the refusal as it was, and nothing is written', async () => {
    const s = await launchedSession();
    const spy = vi.spyOn(db.hostKeyUse, 'create').mockRejectedValueOnce(new Error('record down'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await code(update(keyCtx(orca1), s.id))).toBe('FORBIDDEN');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
    expect(await sessionUses()).toEqual([]);
    expect((await row(s.id)).prNumber).toBeNull();
  });

  it('the six host-operation recordings are unchanged: registration still records register, and no session row', async () => {
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: orca1.id } });
    expect(uses.map((u) => [u.action, u.refusedCode])).toEqual([['register', null]]);
  });
});
