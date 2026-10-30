import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1149 — a worker has three read tiers (cor:dmo:050:11, "Who may see a
 * worker"; hadron-concept D-2026-08-25-007, no opt-out in v1 per Holger
 * 2026-10-27):
 *   - Profile: any signed-in user who names the worker (id, URN, link) reads
 *     its identity scalars plus `appName` / `ownerName`;
 *   - Details: whoever the cast Agent's own visibility admits also reads
 *     `agent`;
 *   - Working state: App participants only, exactly as before.
 *
 * Two tenants: an org App ("Team", org A) and a user-owned App ("Notes", owned
 * by Uma). The stranger is signed in and belongs to neither. The org READER is
 * not an App participant (participation needs CONTRIBUTOR+ or an AppMember
 * row) but may read the org's ORGANIZATION-visible Agent, so it is the Details
 * reader who is not a participant.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const api = new ApolloServer<Context>({ typeDefs, resolvers });
let started: Promise<void> | null = null;

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let uma: { id: string; handle: string };
let contributor: { id: string };
let orgReader: { id: string };
let stranger: { id: string };
let appA: { id: string; urn: string };
let appB: { id: string; urn: string };
let notes: { id: string; urn: string };
let orgAgent: { id: string };
let publicAgent: { id: string };
let personalAgent: { id: string };
let teamDan: { id: string };
let teamPia: { id: string };
let umaScout: { id: string };

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

async function user(n: number) {
  return db.user.create({
    data: { id: generateId(), githubId: 114_900 + n, githubUsername: `wp-${n}`, handle: `wp-${n}`, roles: ['READER'] },
    select: { id: true, handle: true },
  });
}

async function worker(appId: string, agentId: string, name: string, extra: Record<string, unknown> = {}) {
  return db.worker.create({
    data: {
      ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name, slug: name.toLowerCase(),
      role: 'server-engineer', promptOverride: 'secret override', createdBy: contributor.id, ...extra,
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  started ??= api.start();
  await started;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'wp-a', urn: 'wp-a.com' } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'wp-b', urn: 'wp-b.com' } });
  uma = await user(1);
  contributor = await user(2);
  orgReader = await user(3);
  stranger = await user(4);
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: orgReader.id, role: 'READER' } });
  orgAgent = await db.agent.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:engineer`, name: 'Engineer', visibility: 'ORGANIZATION', systemPrompt: 'You are {{name}}.' },
    select: { id: true },
  });
  publicAgent = await db.agent.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:helper`, name: 'Helper', visibility: 'PUBLIC' },
    select: { id: true },
  });
  personalAgent = await db.agent.create({
    data: { id: generateId(), ownerUserId: uma.id, urn: `${uma.handle}:scout`, name: 'Scout', visibility: 'PERSONAL' },
    select: { id: true },
  });
  appA = await db.app.create({ data: { id: generateId(), organizationId: orgA.id, name: 'Team', urn: `${orgA.urn}:team` } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: orgB.id, name: 'Elsewhere', urn: `${orgB.urn}:elsewhere` } });
  notes = await db.app.create({ data: { id: generateId(), ownerUserId: uma.id, name: 'Notes', urn: `${uma.handle}:notes` } });
  teamDan = await worker(appA.id, orgAgent.id, 'Dan', { heldByUserId: contributor.id, heldAt: new Date() });
  teamPia = await worker(appA.id, publicAgent.id, 'Pia');
  umaScout = await worker(notes.id, personalAgent.id, 'Scout', { createdBy: uma.id });
});

const PROFILE = 'id appId agentId name slug urn role appUrn appName ownerName createdAt retiredAt';
const WORKING = 'prompt promptOverride signature trailer memoryId repos heldByUserId heldAt reportsToWorkerId reportsToRetired hasLiveSession family lastActiveAt continuity { __typename } createdBy retiredBy app { id } bootPromptRef';

async function run(query: string, variables: Record<string, unknown>, c: Context) {
  const r = await api.executeOperation({ query, variables }, { contextValue: c });
  if (r.body.kind !== 'single') throw new Error('unexpected incremental response');
  return r.body.singleResult;
}

const readWorker = (ref: string, c: Context, fields = `${PROFILE} ${WORKING} agent { id name }`) =>
  run(`query($ref: ID!) { worker(ref: $ref) { ${fields} } }`, { ref }, c);

/** The refusal an absent worker gets, as a client sees it. */
async function refusalOf(ref: string, c: Context) {
  const r = await readWorker(ref, c, 'id');
  return { data: r.data, errors: r.errors?.map((e) => ({ message: e.message, code: e.extensions?.code, workerRef: e.extensions?.workerRef })) };
}

const scoutUrn = () => `hrn:worker:${uma.handle}:notes:scout`;
const danUrn = () => `hrn:worker:${orgA.urn}:team:dan`;

describe('#1149 Profile tier: a signed-in stranger who names a worker reads its profile', () => {
  it("a personal App's worker: the profile scalars, by id and by URN", async () => {
    for (const ref of [umaScout.id, scoutUrn()]) {
      const r = await readWorker(ref, ctx(stranger.id));
      expect(r.errors).toBeUndefined();
      expect(r.data?.worker).toMatchObject({
        id: umaScout.id, appId: notes.id, agentId: personalAgent.id, name: 'Scout', slug: 'scout',
        urn: scoutUrn(), role: 'server-engineer', appUrn: `hrn:app:${uma.handle}:notes`,
        appName: 'Notes', ownerName: uma.handle, retiredAt: null,
      });
    }
  });

  it('every working-state field masks, and `app` is never part of the profile', async () => {
    const r = await readWorker(teamDan.id, ctx(stranger.id));
    expect(r.errors).toBeUndefined();
    expect(r.data?.worker).toMatchObject({
      prompt: null, promptOverride: null, signature: null, trailer: null, memoryId: null, repos: [],
      heldByUserId: null, heldAt: null, reportsToWorkerId: null, reportsToRetired: false,
      hasLiveSession: null, family: null, lastActiveAt: null, continuity: null,
      createdBy: null, retiredBy: null, app: null, bootPromptRef: null,
    });
  });

  it('ownerName is the org atom for an org App', async () => {
    const r = await readWorker(danUrn(), ctx(stranger.id), 'appName ownerName');
    expect(r.errors).toBeUndefined();
    expect(r.data?.worker).toEqual({ appName: 'Team', ownerName: orgA.urn });
  });

  it('resolveUrn resolves a hrn:worker: link for the stranger', async () => {
    const r = await run('query($u: String!) { resolveUrn(urn: $u) { kind id } }', { u: scoutUrn() }, ctx(stranger.id));
    expect(r.errors).toBeUndefined();
    expect(r.data?.resolveUrn).toEqual({ kind: 'worker', id: umaScout.id });
  });

  it('a retired worker and an uninstalled App stay legible', async () => {
    await db.worker.update({ where: { id: umaScout.id }, data: { retiredAt: new Date(), retiredBy: uma.id } });
    await db.app.update({ where: { id: notes.id }, data: { uninstalledAt: new Date() } });
    const r = await readWorker(umaScout.id, ctx(stranger.id), 'name retiredAt retiredBy');
    expect(r.errors).toBeUndefined();
    expect(r.data?.worker).toMatchObject({ name: 'Scout', retiredBy: null });
    expect((r.data?.worker as { retiredAt: unknown }).retiredAt).not.toBeNull();
  });
});

describe('#1149 Details tier: `agent` follows the cast Agent\'s own visibility', () => {
  const agentOf = async (ref: string, c: Context) =>
    ((await readWorker(ref, c, 'agent { id name }')).data?.worker as { agent: unknown } | null)?.agent;

  it('PUBLIC Agent: the stranger sees it', async () => {
    expect(await agentOf(teamPia.id, ctx(stranger.id))).toEqual({ id: publicAgent.id, name: 'Helper' });
  });

  it('ORGANIZATION Agent: an org READER (not a participant) sees it, the stranger does not', async () => {
    expect(await agentOf(teamDan.id, ctx(orgReader.id))).toEqual({ id: orgAgent.id, name: 'Engineer' });
    expect(await agentOf(teamDan.id, ctx(stranger.id))).toBeNull();
  });

  it('PERSONAL Agent: its owner sees it, the stranger does not', async () => {
    expect(await agentOf(umaScout.id, ctx(uma.id))).toEqual({ id: personalAgent.id, name: 'Scout' });
    expect(await agentOf(umaScout.id, ctx(stranger.id))).toBeNull();
  });

  it('a deleted Agent resolves none, even for a participant', async () => {
    await db.agent.update({ where: { id: orgAgent.id }, data: { deletedAt: new Date() } });
    expect(await agentOf(teamDan.id, ctx(contributor.id))).toBeNull();
  });

  it("the org READER still gets no working state", async () => {
    const r = await readWorker(teamDan.id, ctx(orgReader.id), 'promptOverride heldByUserId createdBy');
    expect(r.data?.worker).toEqual({ promptOverride: null, heldByUserId: null, createdBy: null });
  });

  it('`app` keeps Query.app\'s own audience: the profile never widens it', async () => {
    // The org READER may read the App through Query.app, so Worker.app answers it
    // here as on the session-nested path (#980); the stranger, whom Query.app
    // refuses, gets null although the profile admits it.
    const asReader = await readWorker(teamDan.id, ctx(orgReader.id), 'name app { id name }');
    expect(asReader.errors).toBeUndefined();
    expect(asReader.data?.worker).toEqual({ name: 'Dan', app: { id: appA.id, name: 'Team' } });
    const asStranger = await readWorker(teamDan.id, ctx(stranger.id), 'name app { id }');
    expect(asStranger.data?.worker).toEqual({ name: 'Dan', app: null });
  });
});

describe('#1149 Working state: participants read exactly what they read before', () => {
  it('a participant reads the profile and the working state', async () => {
    const r = await readWorker(teamDan.id, ctx(contributor.id), 'appName ownerName promptOverride heldByUserId createdBy app { id }');
    expect(r.errors).toBeUndefined();
    expect(r.data?.worker).toEqual({
      appName: 'Team', ownerName: orgA.urn, promptOverride: 'secret override',
      heldByUserId: contributor.id, createdBy: contributor.id, app: { id: appA.id },
    });
  });

  it("an App's own key reads its own staff", async () => {
    const r = await readWorker(teamDan.id, { db, roles: [], appId: appA.id } as Context, 'name appName promptOverride');
    expect(r.errors).toBeUndefined();
    expect(r.data?.worker).toEqual({ name: 'Dan', appName: 'Team', promptOverride: 'secret override' });
  });
});

describe('#1149 the profile entry gate refuses like an unknown worker', () => {
  const unknownRef = () => `hrn:worker:${orgA.urn}:team:nobody`;
  const REFUSED: Array<[string, () => Context]> = [
    ['an anonymous caller', () => ({ db, roles: [] } as Context)],
    ["another App's key", () => ({ db, roles: [], appId: appB.id } as Context)],
    ["another App's run principal, acting for a signed-in user", () => ({
      db, ...runAuthContext({ id: generateId(), appId: appB.id, userId: stranger.id, organizationId: orgB.id }),
    } as Context)],
    ['a support session impersonating into another org', () => ctx(stranger.id, {
      impersonation: { sessionId: generateId(), actorUserId: generateId(), orgId: orgB.id } as never,
    })],
  ];

  for (const [who, as] of REFUSED) {
    it(`${who}: a real worker and a guessed one get the same refusal`, async () => {
      const real = await refusalOf(danUrn(), as());
      const guessed = await refusalOf(unknownRef(), as());
      expect(guessed.errors?.[0]).toMatchObject({ message: 'Worker not found.', code: 'WORKER_NOT_FOUND' });
      expect({ ...real, errors: real.errors?.map((e) => ({ ...e, workerRef: null })) })
        .toEqual({ ...guessed, errors: guessed.errors?.map((e) => ({ ...e, workerRef: null })) });
    });
  }

  it("a deleted App's worker is refused like an unknown one, for the stranger and a participant", async () => {
    await db.app.update({ where: { id: appA.id }, data: { deletedAt: new Date() } });
    for (const c of [ctx(stranger.id), ctx(contributor.id)]) {
      expect((await refusalOf(danUrn(), c)).errors?.[0]).toMatchObject({ message: 'Worker not found.', code: 'WORKER_NOT_FOUND' });
    }
  });

  it('impersonation is bounded to the App\'s own org: admitted there, refused for a user-owned App', async () => {
    const imp = ctx(stranger.id, { impersonation: { sessionId: generateId(), actorUserId: generateId(), orgId: orgA.id } as never });
    const inOrg = await readWorker(teamDan.id, imp, 'name appName promptOverride');
    expect(inOrg.errors).toBeUndefined();
    expect(inOrg.data?.worker).toEqual({ name: 'Dan', appName: 'Team', promptOverride: null });
    expect((await refusalOf(umaScout.id, imp)).errors?.[0]).toMatchObject({ code: 'WORKER_NOT_FOUND' });
  });

  it('resolveUrn answers null for a refused caller', async () => {
    const r = await run('query($u: String!) { resolveUrn(urn: $u) { kind id } }', { u: danUrn() }, { db, roles: [], appId: appB.id } as Context);
    expect(r.data?.resolveUrn).toBeNull();
  });
});

describe('#1149 the profile never widens a list', () => {
  it('the roster, the workers list and the name form stay participant-only for the stranger', async () => {
    const roster = await run('query($a: ID!) { teamRoster(appRef: $a) { __typename } }', { a: appA.id }, ctx(stranger.id));
    expect(roster.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
    const list = await run('query($a: ID!) { workers(appRef: $a) { total } }', { a: appA.id }, ctx(stranger.id));
    expect(list.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const byName = await run('query($a: ID!) { worker(ref: "Dan", appRef: $a) { id } }', { a: appA.id }, ctx(stranger.id));
    expect(byName.errors?.[0]).toMatchObject({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND' } });
  });
});

describe('#1149 hadron_get_worker delegates to the profile read and keeps working state masked', () => {
  const auth = (userId: string) => ({ userId, roles: ['READER' as const] });

  it('the stranger reads the name and URN, with no liveness flag, override or briefing', async () => {
    const text = await createTestableMcpServer(auth(stranger.id)).callToolText('hadron_get_worker', { workerRef: danUrn() });
    expect(text).toContain('**Dan** (server-engineer)');
    expect(text).toContain(`Worker URN: ${danUrn()}`);
    expect(text).not.toMatch(/\b(taken|free)\b/);
    expect(text).not.toContain('secret override');
    expect(text).not.toContain('Boot briefing');
  });

  it('a departed participant gets no recovery line for its own still-open session', async () => {
    const own = await db.session.create({
      data: { id: generateId(), appId: appA.id, userId: contributor.id, agentId: orgAgent.id, workerId: teamDan.id, role: 'server-engineer' },
    });
    const before = await createTestableMcpServer(auth(contributor.id)).callToolText('hadron_get_worker', { workerRef: danUrn() });
    expect(before).toContain(`Your active session: ${own.id}`);
    await db.orgMember.updateMany({ where: { organizationId: orgA.id, userId: contributor.id }, data: { deletedAt: new Date() } });
    const after = await createTestableMcpServer(auth(contributor.id)).callToolText('hadron_get_worker', { workerRef: danUrn() });
    expect(after).toContain('**Dan** (server-engineer)');
    expect(after).not.toContain(own.id);
    expect(after).not.toContain('Your active session');
  });

  it('a participant still sees the liveness flag', async () => {
    const text = await createTestableMcpServer(auth(contributor.id)).callToolText('hadron_get_worker', { workerRef: danUrn() });
    expect(text).toContain('**Dan** (server-engineer) — free');
  });
});

describe('#1149 the profile fields judge the App, not the path that reached the Worker', () => {
  const W = resolvers.Worker as unknown as Record<string, (w: unknown, a: unknown, c: Context) => Promise<unknown>>;
  const row = () => db.worker.findUniqueOrThrow({ where: { id: teamDan.id } });

  it('appUrn, appName and ownerName mask to null for a principal the profile gate refuses', async () => {
    const w = await row();
    for (const c of [{ db, roles: [] } as Context, { db, roles: [], appId: appB.id } as Context]) {
      expect(await W.appUrn(w, {}, c)).toBeNull();
      expect(await W.appName(w, {}, c)).toBeNull();
      expect(await W.ownerName(w, {}, c)).toBeNull();
    }
  });

  it('and answer for a signed-in stranger', async () => {
    const w = await row();
    expect(await W.appUrn(w, {}, ctx(stranger.id))).toBe(`hrn:app:${orgA.urn}:team`);
    expect(await W.appName(w, {}, ctx(stranger.id))).toBe('Team');
    expect(await W.ownerName(w, {}, ctx(stranger.id))).toBe(orgA.urn);
  });
});
