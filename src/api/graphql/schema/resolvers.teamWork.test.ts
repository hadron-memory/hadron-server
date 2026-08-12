/**
 * #947 — recordTeamWork + teamWorkItems: the team-worklog platform operations.
 *
 * The #936/#941 template: auth matrix one case per PRINCIPAL SHAPE, session
 * conditions as typed refusals, first-write bootstrap (root + schema
 * declaration) idempotent under a race, and racing records BOTH persisting
 * (append-only — no uniqueness to fight over). The acceptance case is the
 * epic's provenance query: record a pr item for a session started through the
 * REAL startSession (findings:gate-with-no-satisfying-write-path — the
 * precondition must be client-reachable), then look it up by EVERY accepted
 * ref spelling and resolve the sessionIds to sessions carrying
 * transcriptPath.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import {
  WORKLOG_LOC,
  WORKLOG_OBJECT_TYPE,
  WORK_DETAIL_MAX_CHARS,
} from './resolvers.teamWork.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: ['READER'] };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let appMember: { id: string; handle: string };
let appReader: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; urn: string; systemMemoryId: string };
let app: { id: string; urn: string };
let contribSession: { id: string };

/** The worklog root among the App's OWN app-class memories (mirrors the
 * resolver's relation-scoped lookup). */
const findWorklogRoot = () =>
  db.node.findFirst({
    // loc-scope-ok: deliberately spans the App's OWN app-class memories — the
    // relation filter is the tenant scope, mirroring the resolver (#947).
    where: { loc: WORKLOG_LOC, memory: { appId: app.id, class: 'app' } },
  });

const record = (c: Context, args: Record<string, unknown> = {}) =>
  M.recordTeamWork(
    {},
    {
      appRef: app.id,
      sessionRef: contribSession.id,
      tool: 'github',
      kind: 'pr',
      ref: 'o/r#371',
      action: 'opened',
      ...args,
    },
    c,
  );
const items = (c: Context, args: Record<string, unknown> = {}) =>
  Q.teamWorkItems({}, { appRef: app.id, ...args }, c);

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'tw-org', urn: `tw-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 94701, githubUsername: `tw-admin-${suffix}`, roles: ['READER'] },
  });
  contrib = await db.user.create({
    data: { id: generateId(), githubId: 94702, githubUsername: `tw-contrib-${suffix}`, roles: ['READER'] },
  });
  appMember = await db.user.create({
    data: {
      id: generateId(),
      githubId: 94703,
      githubUsername: `tw-member-${suffix}`,
      handle: `wanda-${suffix.replace(/[^a-z0-9-]/gi, '')}`,
      roles: ['READER'],
    },
    select: { id: true, handle: true },
  });
  appReader = await db.user.create({
    data: { id: generateId(), githubId: 94704, githubUsername: `tw-reader-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 94705, githubUsername: `tw-outsider-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
  });

  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id, urn: created.urn, systemMemoryId: created.systemMemoryId };
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{name}}, a {{role}}.',
      data: { names: ['Iris', 'Henry'] },
    },
  });

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: appReader.id, role: 'reader' } });

  // A session of this App attributed to contrib — through the REAL mutation
  // (SessionInput.appRef, #944), not a fixture write, so the whole
  // precondition chain is client-reachable.
  contribSession = await M.startSession(
    {},
    { input: { id: generateId(), appRef: app.id, transcriptPath: '/tmp/tw-transcript.jsonl', host: 'devbox', tool: 'claude-code' } },
    ctx(contrib.id),
  );
});

describe('recordTeamWork — auth matrix (one case per principal shape)', () => {
  it('org ADMIN records (and first write bootstraps root + schema)', async () => {
    const item = await record(ctx(admin.id), {
      sessionRef: (await ownSession(admin.id)).id,
    });
    expect(item.ref).toBe('o/r#371');
    const root = await findWorklogRoot();
    expect(root).not.toBeNull();
    const memory = await db.memory.findUnique({ where: { id: root!.memoryId }, select: { schema: true } });
    expect((memory!.schema as any)?.objectTypes?.[WORKLOG_OBJECT_TYPE]).toBeDefined();
  });

  it('org CONTRIBUTOR records', async () => {
    const item = await record(ctx(contrib.id));
    expect(item.sessionId).toBe(contribSession.id);
  });

  it('an AppMember (role member) records against their own session', async () => {
    const s = await ownSession(appMember.id);
    const item = await record(ctx(appMember.id), { sessionRef: s.id });
    expect(item.personaName).toBe(appMember.handle);
  });

  it("an AppMember with role 'reader' records too (participation follows the memory audience)", async () => {
    const s = await ownSession(appReader.id);
    const item = await record(ctx(appReader.id), { sessionRef: s.id });
    expect(item.nodeId).toBeDefined();
  });

  it('a non-member is refused', async () => {
    await expectCode(record(ctx(outsider.id)), 'FORBIDDEN');
  });

  it('a pure App-key principal may not record — the worklog write is read-only for keys', async () => {
    await expectCode(record(ctx(undefined, app.id)), 'FORBIDDEN');
  });

  it('a hybrid user+selection principal is judged on the USER (outsider with app selection: refused)', async () => {
    await expectCode(record(ctx(outsider.id, app.id)), 'FORBIDDEN');
  });

  it('a pure App-key principal reads its own App\'s worklog, but not another App\'s', async () => {
    await record(ctx(contrib.id));
    const page = await items(ctx(undefined, app.id));
    expect(page.total).toBe(1);

    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other` },
    });
    await expectCode(items(ctx(undefined, otherApp.id)), 'FORBIDDEN');
  });

  it('a non-member cannot read', async () => {
    await expectCode(items(ctx(outsider.id)), 'FORBIDDEN');
  });
});

/** A session of the team App attributed to `userId`, via the real mutation. */
async function ownSession(userId: string): Promise<{ id: string }> {
  return M.startSession({}, { input: { id: generateId(), appRef: app.id } }, ctx(userId));
}

describe('recordTeamWork — session conditions', () => {
  it('unknown session → SESSION_NOT_FOUND', async () => {
    await expectCode(record(ctx(contrib.id), { sessionRef: 'nope' }), 'SESSION_NOT_FOUND');
  });

  it("another user's session → FORBIDDEN (requireSessionWriteAccess semantics)", async () => {
    await expectCode(record(ctx(admin.id), { sessionRef: contribSession.id }), 'FORBIDDEN');
  });

  it("a session of a DIFFERENT App → SESSION_NOT_IN_APP", async () => {
    const foreign = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: null },
    });
    await expectCode(record(ctx(contrib.id), { sessionRef: foreign.id }), 'SESSION_NOT_IN_APP');
  });

  it('an ENDED session is ACCEPTED — late attribution is the point', async () => {
    await M.endSession({}, { id: contribSession.id }, ctx(contrib.id));
    const item = await record(ctx(contrib.id), { action: 'merged' });
    expect(item.action).toBe('merged');
  });

  it('a session bound to an agent NOT installed in the App → SESSION_AGENT_NOT_IN_APP', async () => {
    const foreignAgent = await M.createAgent(
      {},
      { orgId: org.id, name: 'Uninstalled Agent' },
      ctx(admin.id),
    );
    const s = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: app.id, agentId: foreignAgent.id },
    });
    await expectCode(record(ctx(contrib.id), { sessionRef: s.id }), 'SESSION_AGENT_NOT_IN_APP');
  });

  it('a persona-bound session records under the persona name', async () => {
    const persona = await M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id));
    const s = await M.startSession(
      {},
      { input: { id: generateId(), appRef: app.id, agentRef: persona.id } },
      ctx(contrib.id),
    );
    const item = await record(ctx(contrib.id), { sessionRef: s.id });
    expect(item.personaName).toBe(persona.personaName);
  });

  it('an unbound session records under the attributed user handle', async () => {
    const s = await ownSession(appMember.id);
    const item = await record(ctx(appMember.id), { sessionRef: s.id });
    expect(item.personaName).toBe(appMember.handle);
  });
});

describe('recordTeamWork — input validation + ref normalization', () => {
  it('stores the ONE canonical spelling whatever the input spelling', async () => {
    const item = await record(ctx(contrib.id), {
      ref: 'https://github.com/O/R/pull/371?diff=split',
    });
    expect(item.ref).toBe('o/r#371');
    const node = await db.node.findUnique({ where: { id: item.nodeId } });
    expect((node!.properties as any).ref).toBe('o/r#371');
    expect(node!.objectType).toBe(WORKLOG_OBJECT_TYPE);
  });

  it('a bare number → WORK_REF_INVALID (the server never infers a repo)', async () => {
    await expectCode(record(ctx(contrib.id), { ref: '371' }), 'WORK_REF_INVALID');
  });

  it('a kind-contradicting spelling → WORK_REF_INVALID', async () => {
    await expectCode(
      record(ctx(contrib.id), { kind: 'commit', ref: 'o/r#371' }),
      'WORK_REF_INVALID',
    );
  });

  it('an unknown kind → BAD_USER_INPUT', async () => {
    await expectCode(record(ctx(contrib.id), { kind: 'gist' }), 'BAD_USER_INPUT');
  });

  it('empty tool / action → BAD_USER_INPUT', async () => {
    await expectCode(record(ctx(contrib.id), { tool: '  ' }), 'BAD_USER_INPUT');
    await expectCode(record(ctx(contrib.id), { action: '' }), 'BAD_USER_INPUT');
  });

  it('detail must be an object, and bounded', async () => {
    await expectCode(record(ctx(contrib.id), { detail: ['x'] }), 'BAD_USER_INPUT');
    await expectCode(
      record(ctx(contrib.id), { detail: { blob: 'x'.repeat(WORK_DETAIL_MAX_CHARS) } }),
      'BAD_USER_INPUT',
    );
    const item = await record(ctx(contrib.id), { detail: { title: 'Fix the thing' } });
    expect(item.detail).toEqual({ title: 'Fix the thing' });
  });

  it("a non-github tool's ref is stored verbatim (no grammar defined in v1)", async () => {
    const item = await record(ctx(contrib.id), {
      tool: 'Jira',
      kind: 'issue',
      ref: 'PROJ-123',
    });
    expect(item.tool).toBe('jira');
    expect(item.ref).toBe('PROJ-123');
  });

  it('tool and action are lowercased vocabulary tokens', async () => {
    const item = await record(ctx(contrib.id), { action: 'Opened' });
    expect(item.action).toBe('opened');
  });
});

describe('recordTeamWork — storage, governance, and races', () => {
  it('declaring the schema turns on #725 governance for the GENERIC write surface too', async () => {
    await record(ctx(contrib.id));
    const root = await findWorklogRoot();
    // A generic createNode writing a non-conforming worklog record is refused
    // by the shared enforcement seam — `team init`'s client-side schema job
    // retires because the server holds the line.
    await expectCode(
      M.createNode(
        {},
        {
          input: {
            memoryId: root!.memoryId,
            loc: 'worklog:offroad',
            name: 'off-road',
            objectType: WORKLOG_OBJECT_TYPE,
            properties: { ref: 'o/r#1' }, // missing required fields
          },
        },
        ctx(admin.id),
      ),
      'BAD_USER_INPUT',
    );
  });

  it('an already-declared worklog collection is left untouched (deployment governance wins)', async () => {
    await record(ctx(contrib.id));
    const root = await findWorklogRoot();
    const before = await db.memory.findUnique({ where: { id: root!.memoryId }, select: { schema: true } });
    const tightened = JSON.parse(JSON.stringify(before!.schema));
    tightened.objectTypes[WORKLOG_OBJECT_TYPE].fields.action = {
      type: 'enum',
      required: true,
      values: ['opened'],
    };
    await db.memory.update({ where: { id: root!.memoryId }, data: { schema: tightened } });

    // The tightened declaration governs THIS surface too.
    await expectCode(record(ctx(contrib.id), { action: 'merged' }), 'BAD_USER_INPUT');
    const ok = await record(ctx(contrib.id), { action: 'opened' });
    expect(ok.action).toBe('opened');
  });

  it('a soft-deleted worklog root is restored, not P2002-bricked', async () => {
    await record(ctx(contrib.id));
    const root = await findWorklogRoot();
    await db.node.update({ where: { id: root!.id }, data: { deletedAt: new Date() } });
    const item = await record(ctx(contrib.id), { ref: 'o/r#2' });
    expect(item.ref).toBe('o/r#2');
    const restored = await db.node.findUnique({ where: { id: root!.id } });
    expect(restored!.deletedAt).toBeNull();
  });

  it('racing records BOTH persist (append-only — no uniqueness), racing first-writes leave ONE root', async () => {
    const [a, b] = await Promise.all([
      record(ctx(contrib.id), { ref: 'o/r#1' }),
      record(ctx(contrib.id), { ref: 'o/r#2' }),
    ]);
    expect(a.nodeId).not.toBe(b.nodeId);
    const roots = await db.node.findMany({
      // loc-scope-ok: deliberately spans the App's OWN app-class memories (#947)
      where: { loc: WORKLOG_LOC, deletedAt: null, memory: { appId: app.id, class: 'app' } },
    });
    expect(roots).toHaveLength(1);
    const page = await items(ctx(contrib.id));
    expect(page.total).toBe(2);
  });

  it('kind:pr denormalizes latest-wins Session.prNumber; other kinds do not touch it', async () => {
    await record(ctx(contrib.id), { ref: 'o/r#371' });
    let s = await db.session.findUnique({ where: { id: contribSession.id } });
    expect(s!.prNumber).toBe(371);

    await record(ctx(contrib.id), { ref: 'o/r#400', action: 'opened' });
    s = await db.session.findUnique({ where: { id: contribSession.id } });
    expect(s!.prNumber).toBe(400);

    await record(ctx(contrib.id), { kind: 'branch', ref: 'o/r:feat/x', action: 'pushed' });
    s = await db.session.findUnique({ where: { id: contribSession.id } });
    expect(s!.prNumber).toBe(400);
  });
});

describe('teamWorkItems — the provenance read surface', () => {
  it('acceptance: a pr record is found by EVERY accepted spelling and resolves to the session + transcript', async () => {
    await record(ctx(contrib.id), { ref: 'https://github.com/Acme/Widgets/pull/371', detail: { title: 'Add widgets' } });

    const spellings = [
      'acme/widgets#371',
      'Acme/Widgets#371',
      'https://github.com/acme/widgets/pull/371',
      'https://github.com/Acme/Widgets/pull/371/files',
      'github.com/acme/widgets/issues/371',
    ];
    for (const spelling of spellings) {
      const page = await items(ctx(contrib.id), { ref: spelling });
      expect(page.total, `spelling: ${spelling}`).toBe(1);
      expect(page.items[0].ref).toBe('acme/widgets#371');
      expect(page.items[0].detail).toEqual({ title: 'Add widgets' });

      // The epic's payoff: sessionIds resolve to sessions with transcripts.
      const session = await db.session.findUnique({ where: { id: page.items[0].sessionId } });
      expect(session!.transcriptPath).toBe('/tmp/tw-transcript.jsonl');
    }
  });

  it('filters by sessionRef / tool / kind, newest first', async () => {
    const other = await ownSession(appMember.id);
    await record(ctx(contrib.id), { ref: 'o/r#1' });
    await record(ctx(contrib.id), { kind: 'branch', ref: 'o/r:main', action: 'pushed' });
    await record(ctx(appMember.id), { sessionRef: other.id, tool: 'jira', kind: 'issue', ref: 'PROJ-9', action: 'closed' });

    const bySession = await items(ctx(contrib.id), { sessionRef: contribSession.id });
    expect(bySession.total).toBe(2);

    const byKind = await items(ctx(contrib.id), { kind: 'branch' });
    expect(byKind.total).toBe(1);
    expect(byKind.items[0].ref).toBe('o/r:main');

    const byTool = await items(ctx(contrib.id), { tool: 'Jira' });
    expect(byTool.total).toBe(1);
    expect(byTool.items[0].ref).toBe('PROJ-9');

    const all = await items(ctx(contrib.id));
    expect(all.total).toBe(3);
    // newest first
    const ats = all.items.map((i: { at: Date }) => i.at.getTime());
    expect([...ats].sort((x, y) => y - x)).toEqual(ats);
  });

  it('an unknown kind filter → BAD_USER_INPUT; a verbatim ref matches non-github records', async () => {
    await expectCode(items(ctx(contrib.id), { kind: 'gist' }), 'BAD_USER_INPUT');

    const s = await ownSession(appMember.id);
    await record(ctx(appMember.id), { sessionRef: s.id, tool: 'jira', kind: 'issue', ref: 'PROJ-42', action: 'closed' });
    const page = await items(ctx(appMember.id), { ref: 'PROJ-42' });
    expect(page.total).toBe(1);
  });

  it('limit 0 is count-only; an empty worklog reads as an empty page (reads never provision)', async () => {
    const empty = await items(ctx(contrib.id));
    expect(empty).toEqual({ items: [], total: 0 });
    const noRoot = await findWorklogRoot();
    expect(noRoot).toBeNull();

    await record(ctx(contrib.id));
    const countOnly = await items(ctx(contrib.id), { limit: 0 });
    expect(countOnly.items).toEqual([]);
    expect(countOnly.total).toBe(1);
  });
});
