import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
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
 *
 * #974 (Worker re-cut): the named identity is a Worker row bound via
 * Session.workerId — records carry workerName (+ workerId when worker-bound),
 * and the session conditions test the worker-App pin (SESSION_WORKER_NOT_IN_APP
 * / WORKER_RETIRED) instead of the retired agent-roster checks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
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
  await serveEveryAgent(db); // #2712: binds need a served prompt
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
    expect(item.workerName).toBe(appMember.handle);
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

  it('a session bound to a worker of a DIFFERENT App → SESSION_WORKER_NOT_IN_APP, never handle fall-through', async () => {
    // PR #948 review (Codex P2 + Copilot), re-keyed by #974: a claimed
    // identity that is not THIS App's must refuse, not silently relabel its
    // work as the human driver's.
    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other Team', urn: `${org.urn}:other-team` },
    });
    const foreignWorker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId: teamAgent.id, name: 'Iris', slug: 'iris' },
    });
    const s = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: app.id, workerId: foreignWorker.id },
    });
    await expectCode(record(ctx(contrib.id), { sessionRef: s.id }), 'SESSION_WORKER_NOT_IN_APP');
  });

  it('a session bound to a RETIRED worker → WORKER_RETIRED (a retired identity takes no new records)', async () => {
    // cor:agt:020:05 — retirement AFTER the bind still refuses: the check
    // runs at record time, unlike the ended-session case (late attribution).
    const worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'Henry', slug: 'henry' },
    });
    const s = await M.startSession(
      {},
      { input: { id: generateId(), appRef: app.id, workerRef: worker.id } },
      ctx(contrib.id),
    );
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    await expectCode(record(ctx(contrib.id), { sessionRef: s.id }), 'WORKER_RETIRED');
  });

  it('a worker-bound session records under the worker name, with workerId stamped', async () => {
    const worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'Iris', slug: 'iris' },
    });
    const s = await M.startSession(
      {},
      { input: { id: generateId(), appRef: app.id, workerRef: worker.id } },
      ctx(contrib.id),
    );
    const item = await record(ctx(contrib.id), { sessionRef: s.id });
    expect(item.workerName).toBe('Iris');
    expect(item.workerId).toBe(worker.id);
    // The opportunistic workerId stamp lands on the stored properties too.
    const node = await db.node.findUnique({ where: { id: item.nodeId } });
    expect((node!.properties as any).workerId).toBe(worker.id);
  });

  it('an unbound session records under the attributed user handle (workerId null)', async () => {
    const s = await ownSession(appMember.id);
    const item = await record(ctx(appMember.id), { sessionRef: s.id });
    expect(item.workerName).toBe(appMember.handle);
    expect(item.workerId).toBeNull();
    const node = await db.node.findUnique({ where: { id: item.nodeId } });
    expect((node!.properties as any).workerId).toBeUndefined();
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

  it('a CLI-shipped stale declaration makes a supported kind unwritable (the hadron-cli#401 symptom)', async () => {
    await record(ctx(contrib.id));
    const root = await findWorklogRoot();
    // Exactly what `hadron team init` writes today: the same collection, with
    // a `kind` enum that predates the `repo` kind.
    const stale = JSON.parse(JSON.stringify((await db.memory.findUnique({
      where: { id: root!.memoryId }, select: { schema: true },
    }))!.schema));
    stale.objectTypes[WORKLOG_OBJECT_TYPE].fields.kind = {
      type: 'enum',
      required: true,
      values: ['pr', 'issue', 'commit', 'branch'],
    };
    await db.memory.update({ where: { id: root!.memoryId }, data: { schema: stale } });

    // The server accepts kind:'repo' (WORK_KINDS) but the declaration refuses
    // it — a rule nobody chose, on a memory the CLI bootstrapped.
    await expectCode(
      record(ctx(contrib.id), { kind: 'repo', ref: 'o/r', action: 'claimed' }),
      'BAD_USER_INPUT',
    );
    // First-write ensure does NOT rescue it: declare-if-absent by design.
    await record(ctx(contrib.id));
    await expectCode(
      record(ctx(contrib.id), { kind: 'repo', ref: 'o/r', action: 'claimed' }),
      'BAD_USER_INPUT',
    );

    // Convergence is the explicit fix.
    const res = await M.updateTeamCollections({}, { appRef: app.id }, ctx(admin.id));
    expect(res.changed).toBe(true);
    expect(res.collections).toEqual([WORKLOG_OBJECT_TYPE]);
    const ok = await record(ctx(contrib.id), { kind: 'repo', ref: 'o/r', action: 'claimed' });
    expect(ok.kind).toBe('repo');
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
  it('ownerless repo-number refs find every matching owner without changing qualified lookups', async () => {
    await record(ctx(contrib.id), { ref: 'hadron-memory/hadron-cli#793' });
    await record(ctx(contrib.id), { ref: 'other/cli#793' });
    await record(ctx(contrib.id), { ref: 'other/clip#793' });
    await record(ctx(contrib.id), { ref: 'other/cli#1793' });
    await record(ctx(contrib.id), { kind: 'repo', ref: 'hadron-memory/hadron-cli' });

    const tail = await items(ctx(contrib.id), { ref: 'cli#793' });
    expect(tail.total).toBe(2);
    expect(new Set(tail.items.map((item: { ref: string }) => item.ref))).toEqual(
      new Set(['hadron-memory/hadron-cli#793', 'other/cli#793']),
    );
    expect((await items(ctx(contrib.id), { ref: 'hadron-cli#793' })).total).toBe(1);
    expect((await items(ctx(contrib.id), { ref: 'other/cli#793' })).total).toBe(1);
    expect((await items(ctx(contrib.id), { ref: '#793' })).total).toBe(0);
    expect((await items(ctx(contrib.id), { ref: '793' })).total).toBe(0);
    expect((await items(ctx(contrib.id), { ref: 'cli', kind: 'repo' })).total).toBe(1);

    const page = await items(ctx(contrib.id), { ref: 'cli#793', limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(await items(ctx(contrib.id), { ref: 'cli#793', limit: 0 })).toEqual({ items: [], total: 2 });
  });

  it('ownerless suffixes are literal, tool-aware, and limited to the canonical worklog', async () => {
    await record(ctx(contrib.id), { ref: 'one/cli_#793' });
    await record(ctx(contrib.id), { ref: 'two/cliX#793' });
    await record(ctx(contrib.id), { tool: 'jira', kind: 'issue', ref: 'cli_#793' });

    expect((await items(ctx(contrib.id), { ref: 'cli_#793', tool: 'github' })).total).toBe(1);
    expect((await items(ctx(contrib.id), { ref: 'cli_#793', tool: 'jira' })).total).toBe(1);
    expect((await items(ctx(contrib.id), { ref: 'cli_#793' })).total).toBe(2);
    expect((await items(ctx(contrib.id), { ref: 'cli_#793', kind: 'repo' })).total).toBe(0);

    const otherMemory = await db.memory.create({
      data: {
        id: generateId(),
        name: 'other shared',
        urn: `${org.urn}:other-shared-${generateId().slice(-6)}`,
        class: 'app',
        appId: app.id,
        organizationId: org.id,
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: otherMemory.id,
        loc: `worklog:stray-${generateId().slice(-6)}`,
        name: 'stray',
        nodeType: 'record',
        objectType: WORKLOG_OBJECT_TYPE,
        properties: {
          sessionId: contribSession.id,
          workerName: 'stray',
          tool: 'github',
          kind: 'pr',
          ref: 'outside/cli_#793',
          action: 'opened',
          at: new Date().toISOString(),
        },
      },
    });
    expect((await items(ctx(contrib.id), { ref: 'cli_#793', tool: 'github' })).total).toBe(1);
  });

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

  it("ref matching is tool-aware: a non-github ref that PARSES as a github form still matches verbatim", async () => {
    // PR #948 review (Codex P2 + Copilot): jira "Acme/Proj#12" parses as the
    // github short form — canonicalizing the filter would lowercase it into
    // never matching the verbatim stored ref.
    const s = await ownSession(appMember.id);
    await record(ctx(appMember.id), { sessionRef: s.id, tool: 'jira', kind: 'issue', ref: 'Acme/Proj#12', action: 'closed' });

    // With the tool named: verbatim match.
    const withTool = await items(ctx(appMember.id), { tool: 'jira', ref: 'Acme/Proj#12' });
    expect(withTool.total).toBe(1);
    // Without a tool: either spelling matches (canonical OR verbatim).
    const noTool = await items(ctx(appMember.id), { ref: 'Acme/Proj#12' });
    expect(noTool.total).toBe(1);
    // The canonicalized spelling does NOT claim the jira record when the tool
    // filter says github.
    const asGithub = await items(ctx(appMember.id), { tool: 'github', ref: 'Acme/Proj#12' });
    expect(asGithub.total).toBe(0);
  });

  it('reads are scoped to the canonical worklog root — a worklog-typed node in ANOTHER app-class memory is not this ledger', async () => {
    // PR #948 review (Copilot): writes select one root; reads must read
    // exactly that worklog.
    await record(ctx(contrib.id));
    const otherMemory = await db.memory.create({
      data: {
        id: generateId(),
        name: 'other shared',
        urn: `${org.urn}:other-shared-${generateId().slice(-6)}`,
        class: 'app',
        appId: app.id,
        organizationId: org.id,
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: otherMemory.id,
        loc: `worklog:stray-${generateId().slice(-6)}`,
        name: 'stray',
        nodeType: 'record',
        objectType: WORKLOG_OBJECT_TYPE,
        properties: {
          sessionId: contribSession.id,
          workerName: 'stray',
          tool: 'github',
          kind: 'pr',
          ref: 'o/r#371',
          action: 'opened',
          at: new Date().toISOString(),
        },
      },
    });
    const page = await items(ctx(contrib.id));
    expect(page.total).toBe(1);
    expect(page.items[0].workerName).not.toBe('stray');
  });

  it('a pre-#974 record carrying personaName projects it as workerName (no data migration)', async () => {
    await record(ctx(contrib.id));
    const root = await findWorklogRoot();
    // Exactly what the persona-era write path stored: personaName, no
    // workerName / workerId.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: root!.memoryId,
        loc: `worklog:legacy-${generateId().slice(-6)}`,
        name: 'legacy',
        nodeType: 'record',
        objectType: WORKLOG_OBJECT_TYPE,
        properties: {
          sessionId: contribSession.id,
          personaName: 'Old Iris',
          tool: 'github',
          kind: 'pr',
          ref: 'o/r#9',
          action: 'opened',
          at: new Date().toISOString(),
        },
      },
    });
    const page = await items(ctx(contrib.id), { ref: 'o/r#9' });
    expect(page.total).toBe(1);
    expect(page.items[0].workerName).toBe('Old Iris');
    expect(page.items[0].workerId).toBeNull();
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

describe('#1053 — an ENDED session may still be recorded against', () => {
  /**
   * @Gil observed `record_work` accepting a reaped session twelve minutes after
   * it expired, while `chat_post` refused the same id, and flagged two things
   * nobody had checked — deliberately not probing them against the live App,
   * because the probe writes a row into an append-only log.
   *
   * Both are answered here instead, in a throwaway database. And the answer to
   * the headline is that the acceptance is CORRECT: cor:agt:020:05 makes late
   * attribution durable law, in the Rule and again in Durable-vs-tunable —
   * "an ended session may be recorded against ... a merge lands after the
   * session ends". The two writers SHOULD differ: the chat is worker SPEECH
   * (cor:agt:020:04 requires an active session, because a closed session cannot
   * speak) and the worklog is RECORD-KEEPING.
   */
  it("accepts a session ended DELIBERATELY, not just one that was reaped (@Gil's Q1)", async () => {
    await M.endSession({}, { id: contribSession.id }, ctx(contrib.id));
    const ended = await db.session.findUniqueOrThrow({ where: { id: contribSession.id } });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.autoExpiredAt).toBeNull(); // deliberate, not a reap

    const item = await record(ctx(contrib.id), { ref: 'o/r#1' });
    expect(item.ref).toBe('o/r#1');
  });

  it('accepts a REAPED session too — the observed case', async () => {
    const now = new Date();
    await db.session.update({
      where: { id: contribSession.id },
      data: { endedAt: now, autoExpiredAt: now },
    });
    const item = await record(ctx(contrib.id), { ref: 'o/r#2' });
    expect(item.ref).toBe('o/r#2');
  });

  it("validates the session well beyond ownership (@Gil's Q2)", async () => {
    // Everything except liveness is checked, which is the point: the omission
    // is deliberate and narrow, not a gap in the gate.
    await expectCode(record(ctx(contrib.id), { sessionRef: 'nope' }), 'SESSION_NOT_FOUND');
    await expectCode(record(ctx(admin.id), { sessionRef: contribSession.id }), 'FORBIDDEN');

    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:o-${Date.now()}` },
    });
    const foreign = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: otherApp.id },
    });
    await expectCode(record(ctx(contrib.id), { sessionRef: foreign.id }), 'SESSION_NOT_IN_APP');

    // And a soft-deleted session is not a session at all.
    const gone = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: app.id, deletedAt: new Date() },
    });
    await expectCode(record(ctx(contrib.id), { sessionRef: gone.id }), 'SESSION_NOT_FOUND');
  });

  it('the chat refuses the very session the worklog accepts — the divergence is by design', async () => {
    // Same id, two writers, opposite answers, and both correct. Asserted
    // together so the pair cannot drift into agreement by accident: making the
    // worklog refuse would invalidate cor:agt:020:05's durable late-attribution
    // clause, and making the chat accept would invalidate cor:agt:020:04's
    // authorship condition (c).
    const worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'Iris', slug: 'iris' },
    });
    const s = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: app.id, agentId: teamAgent.id, workerId: worker.id },
    });
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });

    const item = await record(ctx(contrib.id), { sessionRef: s.id, ref: 'o/r#7' });
    expect(item.workerName).toBe('Iris');

    await expectCode(
      M.createTeamChatMessage(
        {}, { appRef: app.id, body: 'speaking from the grave', sessionRef: s.id }, ctx(contrib.id),
      ),
      'SESSION_ENDED',
    );
  });
});

describe('teamWorkItems — the workerRef filter (#1035)', () => {
  /**
   * "What has this worker done" had no direct read path: a client had to fan
   * out over sessions(workerRef:) and merge, which cannot reproduce this
   * operation's `total` or a stable offset — on the one surface whose whole
   * point is completeness. Blocks the worklog section of hadron-portal#737.
   */
  async function workerWithRecords(name: string, slug: string, refs: string[]) {
    const worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name, slug },
    });
    const session = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: app.id, agentId: teamAgent.id, workerId: worker.id },
    });
    for (const ref of refs) {
      await record(ctx(contrib.id), { sessionRef: session.id, ref });
    }
    return { worker, session };
  }

  it('composes ownerless suffix paging with worker, session, tool, and kind filters', async () => {
    const iris = await workerWithRecords('Iris', 'iris', ['one/hadron-cli#793', 'two/cli#793']);
    await workerWithRecords('Henry', 'henry', ['three/cli#793']);

    const page = await items(ctx(contrib.id), {
      ref: 'cli#793', workerRef: iris.worker.id, sessionRef: iris.session.id,
      tool: 'github', kind: 'pr', limit: 1, offset: 1,
    });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(['one/hadron-cli#793', 'two/cli#793']).toContain(page.items[0].ref);
  });

  it('returns only that worker\'s records — across ALL their sessions, with a correct total', async () => {
    const iris = await workerWithRecords('Iris', 'iris', ['o/r#1', 'o/r#2']);
    await workerWithRecords('Henry', 'henry', ['o/r#3']);
    // A SECOND session for Iris: the fan-out this filter replaces is exactly
    // the client-side merge over these.
    const second = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: app.id, agentId: teamAgent.id, workerId: iris.worker.id },
    });
    await record(ctx(contrib.id), { sessionRef: second.id, ref: 'o/r#4' });

    const page = await items(ctx(contrib.id), { workerRef: iris.worker.id });
    expect(page.total).toBe(3);
    expect(page.items.map((i: { ref: string }) => i.ref).sort()).toEqual(['o/r#1', 'o/r#2', 'o/r#4']);
  });

  it('accepts a NAME and a URN, not just an id', async () => {
    const { worker } = await workerWithRecords('Iris', 'iris', ['o/r#1']);
    expect((await items(ctx(contrib.id), { workerRef: 'Iris' })).total).toBe(1);
    // Case-insensitively, the way a human types it.
    expect((await items(ctx(contrib.id), { workerRef: 'iris' })).total).toBe(1);
    const urn = `hrn:worker:${app.urn}:${worker.slug}`;
    expect((await items(ctx(contrib.id), { workerRef: urn })).total).toBe(1);
  });

  it('a RETIRED worker still resolves — retirement ends the casting, not the history', async () => {
    const { worker } = await workerWithRecords('Iris', 'iris', ['o/r#1', 'o/r#2']);
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    // The record path refuses a retired worker; the READ must not, or a worker
    // page for a retired teammate goes blank and their merged PRs stop tracing.
    expect((await items(ctx(contrib.id), { workerRef: 'Iris' })).total).toBe(2);
    expect((await items(ctx(contrib.id), { workerRef: worker.id })).total).toBe(2);
  });

  it('records from a session that was never worker-bound do not match', async () => {
    await workerWithRecords('Iris', 'iris', ['o/r#1']);
    await record(ctx(contrib.id), { ref: 'o/r#99' }); // contribSession: no worker
    expect((await items(ctx(contrib.id))).total).toBe(2);
    expect((await items(ctx(contrib.id), { workerRef: 'Iris' })).total).toBe(1);
  });

  it('composes with the other filters rather than replacing them', async () => {
    const { worker } = await workerWithRecords('Iris', 'iris', ['o/r#1']);
    const session = await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: app.id, agentId: teamAgent.id, workerId: worker.id },
    });
    await record(ctx(contrib.id), { sessionRef: session.id, kind: 'branch', ref: 'o/r:main', action: 'pushed' });

    expect((await items(ctx(contrib.id), { workerRef: 'Iris' })).total).toBe(2);
    const narrowed = await items(ctx(contrib.id), { workerRef: 'Iris', kind: 'branch' });
    expect(narrowed.total).toBe(1);
    expect(narrowed.items[0].ref).toBe('o/r:main');
  });

  it('an unknown ref, and another App\'s worker, both yield an EMPTY page — never an error', async () => {
    await workerWithRecords('Iris', 'iris', ['o/r#1']);
    // Erroring here would make this surface an existence oracle for another
    // App's roster (cor:agt:020:08), and a read filter that names nothing is a
    // filter that matches nothing.
    expect((await items(ctx(contrib.id), { workerRef: 'Nobody' })).total).toBe(0);
    const elsewhere = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other-${Date.now()}` },
    });
    const foreign = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: elsewhere.id, agentId: teamAgent.id, name: 'Iris', slug: 'iris' },
    });
    expect((await items(ctx(contrib.id), { workerRef: foreign.id })).total).toBe(0);
  });

  it('a DATABASE failure during ref resolution propagates — an outage is not an empty page', async () => {
    // review:narrow-catch-blocks. The blanket catch this replaces reported an
    // outage as "no matching worklog records", which a caller has every reason
    // to believe — the one surface whose empty page is a legitimate answer.
    // Driven by a db whose WORKER lookup fails while everything else works, so
    // the failure lands exactly where resolveWorkerRef reaches the database.
    await workerWithRecords('Iris', 'iris', ['o/r#1']);
    const boom = new Error('connection terminated unexpectedly');
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'worker') {
          return {
            ...Reflect.get(target, prop, receiver),
            findUnique: async () => { throw boom; },
            findFirst: async () => { throw boom; },
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const brokenCtx = { ...ctx(contrib.id), db: brokenDb } as Context;

    await expect(
      Q.teamWorkItems({}, { appRef: app.id, workerRef: generateId() }, brokenCtx),
    ).rejects.toThrow(/connection terminated/);
  });

  it("an OFF-ROAD record naming another App's worker is still not returned (Codex P2)", async () => {
    // The case that proves the same-App check is load-bearing, and that my
    // first mutation of it was too weak to reach. Root scoping constrains the
    // node's MEMORY, not its denormalized properties.workerId — and off-road
    // writes into this collection are legal by design, while `workerId` is not
    // in the declared collection schema, so nothing validates it.
    const { worker } = await workerWithRecords('Iris', 'iris', ['o/r#1']);
    const elsewhere = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other2-${Date.now()}` },
    });
    const foreign = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: elsewhere.id, agentId: teamAgent.id, name: 'Nadia', slug: 'nadia' },
    });
    const root = await db.node.findFirstOrThrow({
      // loc-scope-ok: scoped to the fixture App's worklog root by memory.
      where: { loc: WORKLOG_LOC, memory: { appId: app.id, class: 'app' } },
      select: { memoryId: true },
    });
    await db.session.create({ data: { id: 'someone-elses', workerId: foreign.id, appId: elsewhere.id, userId: contrib.id } });
    // A conforming worklog record written through the generic node surface,
    // carrying a FOREIGN workerId.
    await db.node.create({
      data: {
        id: generateId(), memoryId: root.memoryId, loc: `${WORKLOG_LOC}:off-road-1`,
        name: 'off-road-1', objectType: WORKLOG_OBJECT_TYPE,
        properties: {
          sessionId: 'someone-elses', workerName: 'Nadia', workerId: foreign.id,
          tool: 'github', kind: 'pr', ref: 'o/r#500', action: 'opened',
          at: new Date().toISOString(),
        },
      },
    });

    // It IS in this App's worklog — visible unfiltered, which is correct: an
    // App member may read their own App's worklog whatever is in it.
    expect((await items(ctx(contrib.id))).total).toBe(2);
    // But filtering BY that foreign worker must still answer nothing, or the
    // filter's meaning becomes "records that happen to name them".
    expect((await items(ctx(contrib.id), { workerRef: foreign.id })).total).toBe(0);
    // And the real worker's filter is unaffected.
    expect((await items(ctx(contrib.id), { workerRef: worker.id })).total).toBe(1);
  });
});

describe('updateTeamCollections — explicit convergence (hadron-cli#401)', () => {
  it('is idempotent — a matching declaration reports changed:false', async () => {
    await record(ctx(contrib.id));
    const first = await M.updateTeamCollections({}, { appRef: app.id }, ctx(admin.id));
    expect(first.changed).toBe(false); // ensureWorklogSchema already wrote canonical
    const second = await M.updateTeamCollections({}, { appRef: app.id }, ctx(admin.id));
    expect(second.changed).toBe(false);
  });

  it('preserves every other collection on the memory', async () => {
    await record(ctx(contrib.id));
    const root = await findWorklogRoot();
    const withExtra = JSON.parse(JSON.stringify((await db.memory.findUnique({
      where: { id: root!.memoryId }, select: { schema: true },
    }))!.schema));
    withExtra.objectTypes.competitor = { fields: { name: { type: 'text', required: true } } };
    withExtra.objectTypes[WORKLOG_OBJECT_TYPE].fields.kind = {
      type: 'enum', required: true, values: ['pr'],
    };
    await db.memory.update({ where: { id: root!.memoryId }, data: { schema: withExtra } });

    await M.updateTeamCollections({}, { appRef: app.id }, ctx(admin.id));
    const after = await db.memory.findUnique({
      where: { id: root!.memoryId }, select: { schema: true },
    });
    const schema = after!.schema as any;
    expect(schema.objectTypes.competitor).toEqual({
      fields: { name: { type: 'text', required: true } },
    });
    expect(schema.objectTypes[WORKLOG_OBJECT_TYPE].fields.kind.values).toContain('repo');
  });

  it('bootstraps the memory for an App that has never recorded work', async () => {
    // No record() first — the shared memory + worklog root are provisioned here.
    const res = await M.updateTeamCollections({}, { appRef: app.id }, ctx(admin.id));
    expect(res.changed).toBe(true);
    expect(res.memoryId).toBeTruthy();
    const root = await findWorklogRoot();
    expect(root).not.toBeNull();
  });

  it('authorizes BEFORE bootstrapping — an unauthorized caller writes nothing (Codex P1)', async () => {
    // No record() first: the App has no shared memory and no worklog root, so
    // the bootstrap path is live. A caller who cannot pass the gate must not
    // provision storage inside this tenant's App on the way to being refused.
    const memoriesBefore = await db.memory.count({ where: { appId: app.id } });
    for (const c of [ctx(outsider.id), ctx(appMember.id), ctx(contrib.id)]) {
      await expect(M.updateTeamCollections({}, { appRef: app.id }, c)).rejects.toThrow('Forbidden');
    }
    expect(await db.memory.count({ where: { appId: app.id } })).toBe(memoriesBefore);
    expect(await findWorklogRoot()).toBeNull();
  });

  it('is a schema edit, so team participation is not enough', async () => {
    await record(ctx(contrib.id));
    // A CONTRIBUTOR may record work but may not redefine what a record is.
    await expect(
      M.updateTeamCollections({}, { appRef: app.id }, ctx(contrib.id)),
    ).rejects.toThrow('Forbidden');
    // An AppMember likewise.
    await expect(
      M.updateTeamCollections({}, { appRef: app.id }, ctx(appMember.id)),
    ).rejects.toThrow('Forbidden');
    // An unauthenticated caller is refused before anything is resolved.
    await expectCode(M.updateTeamCollections({}, { appRef: app.id }, ctx()), 'UNAUTHENTICATED');
  });

  it('refuses an uninstalled App', async () => {
    await record(ctx(contrib.id));
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(
      M.updateTeamCollections({}, { appRef: app.id }, ctx(admin.id)),
      'APP_UNINSTALLED',
    );
  });
});
