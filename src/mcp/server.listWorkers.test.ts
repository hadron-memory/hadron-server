import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #997 — hadron_list_workers: the MCP roster read.
 *
 * The gap this closes: #990 made the PICKUP work (`workerRef: "Iris"`), but a
 * user who doesn't already know the name had no way to find one — MCP had no
 * worker read at all. This is a thin delegation to the `workers` resolver, so
 * the staff read gate is literally GraphQL's and cannot drift.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let user: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'lw-org', urn: `lw-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 97610, githubUsername: `lw-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 97611, githubUsername: `lw-out-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
  });
  agent = await db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:backend`,
      name: 'Backend', visibility: 'ORGANIZATION',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
});

function hybridAuth(userId = user.id): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}

const worker = (name: string, slug: string, extra: Record<string, unknown> = {}) =>
  db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug, role: 'backend-engineer', ...extra },
  });

describe('#997 — hadron_list_workers', () => {
  it('lists the active roster with names, roles, and URNs', async () => {
    await worker('Iris', 'iris');
    await worker('Alex', 'alex');
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_list_workers', {});
    expect(out).toContain('Iris');
    expect(out).toContain('Alex');
    expect(out).toContain('backend-engineer');
    expect(out).toContain(`hrn:worker:${org.urn}:team:iris`);
    // …and tells the model what to do next, since that is the whole point.
    expect(out).toContain('hadron_start_session');
  });

  it('marks a worker TAKEN when someone is driving it', async () => {
    const iris = await worker('Iris', 'iris');
    await worker('Alex', 'alex');
    await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    // #1050: 'taken' split into HOLDING (whose name) and liveness (is a
    // session running) — the conflation hadron-cli#487 is about.
    expect(out).toMatch(/Iris.*session live/s);
    expect(out).toMatch(/Alex.*no live session/s);
  });

  it('flags a worker NEVER DRIVEN, and drops the flag once one has been', async () => {
    // hadron-cli#487: a casting nobody picked up rendered exactly like one
    // worked yesterday, so a coordinator dispatched ten issues into a name
    // whose whole history was two sessions under three minutes.
    const iris = await worker('Iris', 'iris');
    await worker('Alex', 'alex');
    await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id,
        endedAt: new Date() },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    // Asserted PER LINE, not with a dot-all regex over the whole roster: `/s`
    // spans rows, so `Iris.*never driven` matches Alex's flag two lines down
    // and the negative case passes whatever Iris says. That is the loose
    // assertion @Jonas hit twice on hadron-cli#521 the same week.
    const lineFor = (name: string) =>
      out.split('\n').find((l) => l.trimStart().startsWith(`- ${name} `)) ?? '';
    // Iris was driven and is now idle; Alex has never been bound at all.
    expect(lineFor('Alex')).toContain('never driven');
    expect(lineFor('Iris')).not.toContain('never driven');
    // …and the ended session is not liveness.
    expect(lineFor('Iris')).toContain('no live session');
  });

  it('renders HOW LONG AGO an idle worker had recorded activity', async () => {
    // Ada's worker: two brief sessions weeks ago. Without the age it reads
    // exactly like one driven an hour ago, which is the whole complaint —
    // and the timestamp was already computed (PR #1086 review, Codex P2).
    const iris = await worker('Iris', 'iris');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id,
        startedAt: threeDaysAgo, updatedAt: threeDaysAgo, endedAt: threeDaysAgo },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    const line = out.split('\n').find((l) => l.trimStart().startsWith('- Iris ')) ?? '';
    expect(line).toContain('last recorded activity 3d ago');
  });

  it('does NOT print an age beside a LIVE session', async () => {
    // "live" is the answer during a session; an age next to it invites
    // reading the age as presence, which is the #1034 confusion again.
    const iris = await worker('Iris', 'iris');
    await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    const line = out.split('\n').find((l) => l.trimStart().startsWith('- Iris ')) ?? '';
    expect(line).toContain('session live');
    expect(line).not.toContain('last recorded activity');
  });

  it('does not name the driver — that stays behind the takeover refusal', async () => {
    const iris = await worker('Iris', 'iris');
    await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    expect(out).not.toContain(user.id);
  });

  it('an ENDED session does not hold a worker taken', async () => {
    const iris = await worker('Iris', 'iris');
    await db.session.create({
      data: {
        id: generateId(), workerId: iris.id, appId: app.id, userId: user.id,
        endedAt: new Date(),
      },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    expect(out).toMatch(/Iris.*no live session/s);
  });

  it('hides retired workers by default and marks them under includeRetired', async () => {
    await worker('Iris', 'iris');
    await worker('Gone', 'gone', { retiredAt: new Date() });

    const plain = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    expect(plain).not.toContain('Gone');

    const full = await createTestableMcpServer(hybridAuth()).callToolText(
      'hadron_list_workers', { includeRetired: true },
    );
    expect(full).toContain('Gone');
    expect(full).toMatch(/Gone.*RETIRED/s);
  });

  it('says something useful when the App has no workers', async () => {
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    expect(out).toContain('no active workers');
    expect(out).toContain('hadron_cast_worker');
  });

  it('refuses a caller who is not a participant of the App', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(hybridAuth(outsider.id)).callToolText(
      'hadron_list_workers', {},
    );
    expect(out).toContain('Error:');
    expect(out).not.toContain('Iris');
  });

  it('a soft-deleted session does not hold a worker taken', async () => {
    // Must match startSession's WORKER_TAKEN predicate exactly, or the roster
    // says "taken" for a worker that binds fine.
    const iris = await worker('Iris', 'iris');
    await db.session.create({
      data: {
        id: generateId(), workerId: iris.id, appId: app.id, userId: user.id,
        deletedAt: new Date(),
      },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    expect(out).toMatch(/Iris.*no live session/s);
  });

  it('distinguishes an empty PAGE from an empty ROSTER', async () => {
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());

    // Offset past the end: the roster is not empty, so don't say it is.
    const past = await srv.callToolText('hadron_list_workers', { offset: 50 });
    expect(past).not.toContain('no active workers');
    expect(past).toContain('1 worker(s)');

    // limit: 0 is the resolver's count-only mode.
    const countOnly = await srv.callToolText('hadron_list_workers', { limit: 0 });
    expect(countOnly).not.toContain('no active workers');
    expect(countOnly).toContain('1 worker(s)');
  });

  it('shows the role agent\'s name', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_list_workers', {});
    expect(out).toContain('agent: Backend');
  });

  it('reports RETIRED and taken/free INDEPENDENTLY', async () => {
    // retireWorker only stamps retiredAt, so a retired worker can still hold an
    // unended session. Collapsing the two into one flag dropped the liveness
    // state that includeRetired promises.
    const gone = await worker('Gone', 'gone', { retiredAt: new Date() });
    await db.session.create({
      data: { id: generateId(), workerId: gone.id, appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText(
      'hadron_list_workers', { includeRetired: true },
    );
    expect(out).toMatch(/Gone.*RETIRED.*session live/s);
  });

  it('accepts an explicit app argument', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(hybridAuth()).callToolText(
      'hadron_list_workers', { app: app.urn },
    );
    expect(out).toContain('Iris');
  });
});
