import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #980 — `Session.worker`: the nested Worker read for session-list attribution.
 *
 * cor:agt:020:02 says org-wide surfaces render the app-qualified compound
 * ("eng-team/Iris"), and a session list is exactly such a surface — but
 * `Session` exposed only ids, so a client with a page of sessions could not
 * attribute any of them without a per-row worker(ref:) + app(ref:) pair.
 *
 * The shipped shape (decision on #980): the nested object, with three merge
 * conditions pinned here —
 *   1. one-query list path: SESSION_INCLUDE eager-loads the worker and the
 *      field resolver prefers the eager row;
 *   2. retired workers RESOLVE (retirement ends the casting, not the
 *      history);
 *   3. the #552 nested-gate audit: Worker.app / Worker.agent self-guard
 *      behind their own read gates and mask to null, per principal shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;
const S = (resolvers as any).Session;
const W = (resolvers as any).Worker;

function ctx(userId?: string, appId?: string, roles: string[] = ['READER']): Context {
  return { db, userId, appId, roles } as Context;
}

let org: { id: string; urn: string };
let member: { id: string };
let platformAdmin: { id: string };
let agent: { id: string };
let app: { id: string; urn: string };
let worker: { id: string; name: string };
let session: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'sw-org', urn: `sw-org-${suffix}.com` },
  });
  member = await db.user.create({
    data: { id: generateId(), githubId: 97001, githubUsername: `sw-member-${suffix}`, roles: ['READER'] },
  });
  platformAdmin = await db.user.create({
    data: { id: generateId(), githubId: 97002, githubUsername: `sw-admin-${suffix}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' },
  });
  agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:backend`,
      name: 'Backend Engineer',
      visibility: 'ORGANIZATION',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Eng Team', urn: `${org.urn}:eng-team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', role: 'backend-engineer' },
  });
  session = await db.session.create({
    data: { id: generateId(), appId: app.id, userId: member.id, agentId: agent.id, workerId: worker.id },
  });
});

describe('#980 — Session.worker resolution', () => {
  it('the sessions list eager-loads the worker (SESSION_INCLUDE — the one-query path)', async () => {
    const rows = await Q.sessions({}, {}, ctx(member.id));
    const row = rows.find((r: { id: string }) => r.id === session.id);
    expect(row).toBeDefined();
    // The eager row is on the parent, so the field resolver answers without
    // a second query — pinned by resolving against a DISCONNECTED db proxy.
    const poisoned = new Proxy(
      {},
      {
        get() {
          throw new Error('field resolver hit the DB — the eager include was ignored');
        },
      },
    );
    const resolved = await S.worker(row, {}, { db: poisoned } as unknown as Context);
    expect(resolved?.id).toBe(worker.id);
    expect(resolved?.name).toBe('Iris');
  });

  it('falls back to a point read for a partially-selected parent', async () => {
    const resolved = await S.worker({ workerId: worker.id }, {}, ctx(member.id));
    expect(resolved?.name).toBe('Iris');
  });

  it('resolves null for a session with no worker binding', async () => {
    const bare = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: member.id },
    });
    expect(await S.worker(bare, {}, ctx(member.id))).toBeNull();
  });

  it('a RETIRED worker still resolves — retirement ends the casting, not the history', async () => {
    await db.worker.update({
      where: { id: worker.id },
      data: { retiredAt: new Date(), retiredBy: member.id },
    });
    const rows = await Q.sessions({}, {}, ctx(member.id));
    const row = rows.find((r: { id: string }) => r.id === session.id);
    const resolved = await S.worker(row, {}, ctx(member.id));
    expect(resolved?.id).toBe(worker.id);
    expect(resolved?.name).toBe('Iris');
    expect(resolved?.retiredAt).not.toBeNull();
  });

  it('declares Session.worker in the SDL (#789 drift class)', () => {
    const type = buildSchema(typeDefs).getType('Session') as GraphQLObjectType;
    expect(String(type.getFields().worker.type)).toBe('Worker');
  });
});

describe('#980 — the #552 nested-gate audit, per principal shape', () => {
  // `Session.worker` hands the caller Worker's field resolvers; Worker.app and
  // Worker.agent were built self-guarding in PR #978 (masked to null on deny).
  // These tests pin that property FOR THE PRINCIPALS THE SESSION LIST ADMITS,
  // so a later "simplification" of the Worker resolvers can't silently turn
  // this nesting into the #552 leak.

  async function workerViaSessions(c: Context) {
    const rows = await Q.sessions({}, {}, c);
    const row = rows.find((r: { id: string }) => r.id === session.id);
    expect(row).toBeDefined();
    return S.worker(row, {}, c);
  }

  it('org member: sees the worker, and Worker.app resolves (the compound renders)', async () => {
    const c = ctx(member.id);
    const w = await workerViaSessions(c);
    expect(w?.name).toBe('Iris');
    const nestedApp = await W.app(w, {}, c);
    expect(nestedApp?.id).toBe(app.id);
  });

  it('App-key caller (pure — no userId): sees the worker, but Worker.app masks to null', async () => {
    // The App key can list its own App's sessions (sessionScopeFilter), and
    // the worker's NAME renders — but the nested App object (whose field
    // resolvers reach App.keys / App.members unguarded) stays out of reach:
    // requireOwnerOrOrgRole has no user to admit.
    const c = ctx(undefined, app.id, []);
    const w = await workerViaSessions(c);
    expect(w?.name).toBe('Iris');
    expect(await W.app(w, {}, c)).toBeNull();
  });

  it('self-attributed CLI session (appId null): its creator resolves the worker', async () => {
    const cliSession = await db.session.create({
      data: { id: generateId(), userId: member.id, workerId: worker.id, agentId: agent.id },
    });
    const rows = await Q.sessions({}, {}, ctx(member.id));
    const row = rows.find((r: { id: string }) => r.id === cliSession.id);
    expect(row).toBeDefined();
    const w = await S.worker(row, {}, ctx(member.id));
    expect(w?.name).toBe('Iris');
  });

  it('platform admin: sees the worker and the nested App (admin org-read)', async () => {
    const c = ctx(platformAdmin.id, undefined, ['ADMIN']);
    const w = await workerViaSessions(c);
    expect(w?.name).toBe('Iris');
    const nestedApp = await W.app(w, {}, c);
    expect(nestedApp?.id).toBe(app.id);
  });

  it('Worker.agent behind the session gate still runs the Agent read gate (masks for the App key)', async () => {
    const c = ctx(undefined, app.id, []);
    const w = await workerViaSessions(c);
    // ORGANIZATION-visibility agent + no user ⇒ masked, not leaked.
    expect(await W.agent(w, {}, c)).toBeNull();
  });

  // ── Working-state fields stay behind the worker read gate (#983 review) ──
  //
  // sessionScopeFilter admits ANY org member, but requireWorkerReadAccess
  // wants an App participant (AppMember / org CONTRIBUTOR+ / owner / own
  // App-key). The gap principal — an org READER who is not an AppMember —
  // must get the attribution scalars (name, and the app for the compound)
  // WITHOUT the working-state fields: prompt, memoryId.

  it('org READER (not an App participant): attribution renders, internals mask to null', async () => {
    await db.worker.update({
      where: { id: worker.id },
      data: { memoryId: null },
    });
    await serveAgentBootPrompt(db, agent.id, 'You are {{worker.name}}, a {{worker.role}}.');
    const c = ctx(member.id); // org READER, no AppMember row
    const w = await workerViaSessions(c);
    expect(w?.name).toBe('Iris');
    expect(await W.app(w, {}, c)).not.toBeNull(); // the compound still renders
    expect(await W.memoryId(w, {}, c)).toBeNull();
    expect(await W.prompt(w, {}, c)).toBeNull();
  });

  it('an App participant still reads the working-state fields', async () => {
    await serveAgentBootPrompt(db, agent.id, 'You are {{worker.name}}, a {{worker.role}}.');
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
    const c = ctx(member.id);
    const w = await workerViaSessions(c);
    expect(await W.prompt(w, {}, c)).toContain('You are Iris');
  });

  it("the App's own key reads internals; a session readable past membership loss does not", async () => {
    await serveAgentBootPrompt(db, agent.id, 'internal note for {{worker.name}}');
    // Pure App-key principal of the same App: requireWorkerReadAccess admits.
    expect(await W.prompt(await workerViaSessions(ctx(undefined, app.id, [])), {}, ctx(undefined, app.id, []))).toBe('internal note for Iris');
    // A user whose only reach is their self-attributed session (no org, no
    // AppMember) keeps the session readable — but not the worker internals.
    const stranger = await db.user.create({
      data: { id: generateId(), githubId: 97099, githubUsername: `sw-str-${Date.now()}`, roles: ['READER'] },
    });
    const strangersSession = await db.session.create({
      data: { id: generateId(), userId: stranger.id, workerId: worker.id, agentId: agent.id },
    });
    const c = ctx(stranger.id);
    const rows = await Q.sessions({}, {}, c);
    const row = rows.find((r: { id: string }) => r.id === strangersSession.id);
    expect(row).toBeDefined();
    const w = await S.worker(row, {}, c);
    expect(w?.name).toBe('Iris'); // attribution survives
    expect(await W.prompt(w, {}, c)).toBeNull();
  });
});
