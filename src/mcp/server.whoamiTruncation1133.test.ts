/**
 * #1133 — hadron_whoami must SAY when it truncated, and its total must be
 * scoped exactly like its rows. Absence from the default list was readable as
 * "the session is gone" — and tasks:end-worker-session reads exactly that as
 * "reaped", which skips the handoff (#1029). These tests pin the disclosure,
 * the truthful recovery guidance (limit caps at 50 — never promise a call
 * that cannot return the rows), and the identical row/count scope.
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

let user: { id: string };
let outsider: { id: string };

function auth(userId = user.id): AuthContext {
  return { userId, roles: ['READER'], clientId: `user:${userId}` };
}

/** n sessions for `userId`, started one minute apart, OLDEST first in the array. */
async function makeSessions(userId: string, n: number, opts: { ended?: number } = {}) {
  const base = Date.now() - n * 60_000;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(
      await db.session.create({
        data: {
          id: generateId(),
          userId,
          type: 'DEVELOPER',
          startedAt: new Date(base + i * 60_000),
          ...(opts.ended && i >= n - opts.ended ? { endedAt: new Date(base + i * 60_000 + 30_000) } : {}),
        },
        select: { id: true },
      }),
    );
  }
  return rows;
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  user = await db.user.create({
    data: { id: generateId(), githubId: 98731, githubUsername: `wtr-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 98732, githubUsername: `wtr-out-${suffix}`, roles: ['READER'] },
  });
});

describe('#1133 — hadron_whoami truncation disclosure', () => {
  it('#1645 filters strict-bound App sessions before paging and counting, with only its own binding exempt', async () => {
    const org = await db.organization.create({ data: { id: generateId(), urn: 'whoami-privacy', name: 'Privacy' } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: 'whoami-privacy:app', name: 'App' } });
    const foreignApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: 'whoami-privacy:foreign', name: 'Foreign' } });
    const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, class: 'private', urn: 'whoami-privacy:private', name: 'Private' } });
    const unbound = await db.session.create({ data: { id: generateId(), appId: app.id, startedAt: new Date(Date.now() - 5000) } });
    const strict = await db.session.create({ data: { id: generateId(), appId: app.id, memoryId: memory.id } });
    const sibling = await db.session.create({ data: { id: generateId(), appId: app.id, memoryId: memory.id } });
    const foreign = await db.session.create({ data: { id: generateId(), appId: foreignApp.id } });
    const appAuth: AuthContext = { appId: app.id, roles: [], clientId: 'app:privacy' };
    const out = await createTestableMcpServer(appAuth).callToolText('hadron_whoami', { limit: 1 });
    expect(out).toContain('1 session(s):');
    expect(out).toContain(unbound.id);
    for (const id of [strict.id, sibling.id, foreign.id]) expect(out).not.toContain(id);
    const bound = await createTestableMcpServer({ ...appAuth, sessionId: strict.id }).callToolText('hadron_whoami', { limit: 1 });
    expect(bound).toContain('newest 1 of 2');
    expect(bound).toContain(strict.id);
    expect(bound).not.toContain(sibling.id);
    expect(bound).not.toContain(foreign.id);
  });
  it('no sessions keeps the existing empty answers', async () => {
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(out).toContain('You have no open sessions');
    expect(out).not.toContain('TRUNCATED');
  });

  it('under the limit: exact count, no truncation marker', async () => {
    await makeSessions(user.id, 3);
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(out).toContain('3 session(s):');
    expect(out).not.toContain('TRUNCATED');
  });

  it('exactly at the default limit is NOT truncation (count === take boundary)', async () => {
    await makeSessions(user.id, 10);
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(out).toContain('10 session(s):');
    expect(out).not.toContain('TRUNCATED');
  });

  it('over the limit within the cap: discloses the total and true recovery guidance', async () => {
    const rows = await makeSessions(user.id, 12); // rows[0] is the OLDEST
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(out).toContain('10 session(s) — TRUNCATED');
    expect(out).toContain('newest 10 of 12');
    expect(out).toContain('pass limit: 12 to see them all');
    // The two oldest rows exist but are not on the page — and the TRUNCATION
    // line never suggests they were reaped or gone. (The pre-existing footer
    // discusses reaping for other reasons, so the scope is the header itself.)
    expect(out).not.toContain(rows[0].id);
    expect(out).not.toContain(rows[1].id);
    expect(out.split('\n')[0]).not.toMatch(/reap/i);
    // …and following the guidance actually retrieves them.
    const full = await createTestableMcpServer(auth()).callToolText('hadron_whoami', { limit: 12 });
    expect(full).toContain(rows[0].id);
    expect(full).toContain('12 session(s):');
  });

  it('beyond the cap: guidance never promises a call that cannot return the rows', async () => {
    const rows = await makeSessions(user.id, 60);
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(out).toContain('newest 10 of 60');
    expect(out).toContain('limit caps at 50');
    expect(out).toContain('10 older session(s) lie beyond any single call');
    expect(out).not.toContain('pass limit: 60');
    // The cap itself stays honest: limit 50 still discloses the beyond-cap rows.
    const capped = await createTestableMcpServer(auth()).callToolText('hadron_whoami', { limit: 50 });
    expect(capped).toContain('newest 50 of 60');
  });

  it('an explicit small limit truncates with the same disclosure', async () => {
    await makeSessions(user.id, 5);
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', { limit: 3 });
    expect(out).toContain('newest 3 of 5');
    expect(out).toContain('pass limit: 5 to see them all');
  });

  it('foreign sessions are excluded from BOTH the rows and the reported total', async () => {
    const mine = await makeSessions(user.id, 12);
    const foreign = await makeSessions(outsider.id, 40);
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(out).toContain('newest 10 of 12');
    for (const f of foreign) expect(out).not.toContain(f.id);
    // The other user's own view is scoped to theirs.
    const theirs = await createTestableMcpServer(auth(outsider.id)).callToolText('hadron_whoami', {});
    expect(theirs).toContain('newest 10 of 40');
    for (const m of mine) expect(theirs).not.toContain(m.id);
  });

  it('includeEnded counts under its own scope: ended rows inflate neither the default count nor its disclosure', async () => {
    // 8 open + 5 most-recent ended.
    await makeSessions(user.id, 13, { ended: 5 });
    const open = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(open).toContain('8 session(s):');
    expect(open).not.toContain('TRUNCATED');
    const withEnded = await createTestableMcpServer(auth()).callToolText('hadron_whoami', { includeEnded: true });
    expect(withEnded).toContain('newest 10 of 13');
    expect(withEnded).toContain('[ENDED]');
  });
});

describe('#1598 — caller-scoped whoami filters', () => {
  async function fixture() {
    const org = await db.organization.create({ data: { name: 'Whoami filters', urn: 'whoami-filters.example' } });
    const a = await db.app.create({ data: { organizationId: org.id, name: 'A', urn: 'whoami-filters.example:a' } });
    const b = await db.app.create({ data: { organizationId: org.id, name: 'B', urn: 'whoami-filters.example:b' } });
    const foreign = await db.app.create({ data: { organizationId: org.id, name: 'Foreign', urn: 'whoami-filters.example:foreign' } });
    const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Worker', urn: 'whoami-filters.example:agent' } });
    const { WORKER_SIGNATURE_DEFAULTS } = await import('../lib/workerSignature.js');
    const wa = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: a.id, agentId: agent.id, name: 'Anne', slug: 'anne' } });
    const wb = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: b.id, agentId: agent.id, name: 'Anne', slug: 'anne' } });
    const many = await makeSessions(user.id, 12);
    await db.session.updateMany({ where: { id: { in: many.map(s => s.id) } }, data: { appId: a.id, workerId: wa.id } });
    const old = await db.session.create({ data: { id: generateId(), userId: user.id, appId: b.id, workerId: wb.id, startedAt: new Date(Date.now() - 60 * 60_000) } });
    await db.session.create({ data: { id: generateId(), userId: outsider.id, appId: foreign.id } });
    return { a, b, foreign, wa, wb, many, old };
  }

  it('filters before the newest-10 page, including a qualified App URN, and counts only matching rows', async () => {
    const { a, b, old, many } = await fixture();
    const server = createTestableMcpServer(auth());
    for (const app of [b.id, `hrn:app:${b.urn}`]) {
      const out = await server.callToolText('hadron_whoami', { app });
      expect(out).toContain('1 session(s):');
      expect(out).toContain(old.id);
      expect(out).not.toContain('TRUNCATED');
      for (const row of many) expect(out).not.toContain(row.id);
    }
    const aOnly = await server.callToolText('hadron_whoami', { app: a.id });
    expect(aOnly).toContain('newest 10 of 12');
    expect(aOnly).not.toContain(old.id);
  });

  it('accepts Worker ID/URN, and requires qualification for an ambiguous name or slug', async () => {
    const { a, b, wb, old } = await fixture();
    const server = createTestableMcpServer(auth());
    for (const workerRef of [wb.id, `hrn:worker:whoami-filters.example:b:anne`]) {
      const out = await server.callToolText('hadron_whoami', { workerRef });
      expect(out).toContain('1 session(s):');
      expect(out).toContain(old.id);
    }
    const ambiguous = await server.callTool('hadron_whoami', { workerRef: 'anne' });
    expect(ambiguous).toMatchObject({ isError: true });
    expect(JSON.stringify(ambiguous)).toContain('ambiguous_ref');
    const selected = await server.callToolText('hadron_whoami', { app: b.id, workerRef: 'Anne' });
    expect(selected).toContain(old.id);
    expect(selected).toContain('1 session(s):');
    const disjoint = await server.callToolText('hadron_whoami', { app: a.id, workerRef: wb.id });
    expect(disjoint).toContain('No matching session');
    expect(disjoint).not.toContain(old.id);
  });

  it('conceals foreign refs exactly as absent refs and preserves hybrid user scope and impersonation refusal', async () => {
    const { b, foreign, old } = await fixture();
    const server = createTestableMcpServer(auth());
    const hidden = await server.callToolText('hadron_whoami', { app: foreign.id });
    const absent = await server.callToolText('hadron_whoami', { app: generateId() });
    expect(hidden).toBe(absent);
    expect(hidden).toContain('No matching session');
    const hybrid = await createTestableMcpServer({ ...auth(), appId: foreign.id }).callToolText('hadron_whoami', { app: b.id });
    expect(hybrid).toContain(old.id);
    const impersonated = await createTestableMcpServer({ ...auth(), impersonation: { sessionId: 'support', actorUserId: outsider.id, orgId: 'support', expiresAt: new Date(Date.now() + 60_000) } })
      .callToolText('hadron_whoami', { app: b.id });
    expect(impersonated).toContain('Not available in an impersonation');
    expect(impersonated).not.toContain(old.id);
  });

  it('retains includeEnded and pure-App privacy filters before both resolution and count', async () => {
    const { b, old } = await fixture();
    await db.session.update({ where: { id: old.id }, data: { endedAt: new Date() } });
    const server = createTestableMcpServer(auth());
    expect(await server.callToolText('hadron_whoami', { app: b.id })).toContain('No matching session');
    expect(await server.callToolText('hadron_whoami', { app: b.id, includeEnded: true })).toContain(old.id);
    const own = await db.session.create({ data: { id: generateId(), appId: b.id } });
    const privateMemory = await db.memory.create({ data: { organizationId: b.organizationId, userId: user.id, class: 'private', name: 'Private', urn: 'whoami-filters.example:private' } });
    const hidden = await db.session.create({ data: { id: generateId(), appId: b.id, memoryId: privateMemory.id } });
    const appAuth: AuthContext = { appId: b.id, roles: [], clientId: 'app:whoami-filter' };
    const appOnly = await createTestableMcpServer(appAuth).callToolText('hadron_whoami', { app: b.id, limit: 1 });
    expect(appOnly).toContain('1 session(s):');
    expect(appOnly).toContain(own.id);
    expect(appOnly).not.toContain(hidden.id);
    expect(appOnly).not.toContain(old.id);
    const { WORKER_SIGNATURE_DEFAULTS } = await import('../lib/workerSignature.js');
    const template = await db.worker.findFirstOrThrow({ where: { appId: b.id } });
    const visibleWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: b.id, agentId: template.agentId, name: 'Visible', slug: 'needle' } });
    const hiddenWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: b.id, agentId: template.agentId, name: 'Needle', slug: 'hidden' } });
    await db.session.update({ where: { id: own.id }, data: { workerId: visibleWorker.id } });
    await db.session.update({ where: { id: hidden.id }, data: { workerId: hiddenWorker.id } });
    // An inaccessible name claimant must not turn the visible slug into ambiguity.
    const resolved = await createTestableMcpServer(appAuth).callToolText('hadron_whoami', { workerRef: 'needle' });
    expect(resolved).toContain(own.id);
    expect(resolved).not.toContain('ambiguous_ref');
    const hiddenResult = await createTestableMcpServer(appAuth).callToolText('hadron_whoami', { workerRef: hiddenWorker.id });
    expect(hiddenResult).toBe(await createTestableMcpServer(appAuth).callToolText('hadron_whoami', { workerRef: generateId() }));
    const bound = await createTestableMcpServer({ ...appAuth, sessionId: hidden.id }).callToolText('hadron_whoami', { workerRef: hiddenWorker.id });
    expect(bound).toContain(hidden.id);
    expect(bound).not.toContain(own.id);
  });
});

// Additional controls for the complete-set resolver and canonical alias paths.
describe('#1598 — filters do not resolve from a capped page', () => {
  it('finds an older App and worker beyond fifty newer authorized sessions', async () => {
    const org = await db.organization.create({ data: { name: 'Complete', urn: 'whoami-complete.example' } });
    const a = await db.app.create({ data: { organizationId: org.id, name: 'A', urn: 'whoami-complete.example:a' } });
    const b = await db.app.create({ data: { organizationId: org.id, name: 'B', urn: 'whoami-complete.example:b' } });
    const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Worker', urn: 'whoami-complete.example:agent' } });
    const { WORKER_SIGNATURE_DEFAULTS } = await import('../lib/workerSignature.js');
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: b.id, agentId: agent.id, name: 'Older worker', slug: 'older-worker' } });
    const recent = await makeSessions(user.id, 55);
    await db.session.updateMany({ where: { id: { in: recent.map(s => s.id) } }, data: { appId: a.id } });
    const old = await db.session.create({ data: { id: generateId(), userId: user.id, appId: b.id, workerId: worker.id, startedAt: new Date(Date.now() - 120 * 60_000) } });
    const server = createTestableMcpServer(auth());
    for (const filter of [{ app: b.id }, { workerRef: worker.id }, { workerRef: 'older-worker' }]) {
      const out = await server.callToolText('hadron_whoami', { ...filter, limit: 50 });
      expect(out).toContain(old.id);
      expect(out).toContain('1 session(s):');
      expect(out).not.toContain('TRUNCATED');
    }
    const foreign = await db.app.create({ data: { organizationId: org.id, name: 'Foreign', urn: 'whoami-complete.example:foreign' } });
    await db.urnAlias.create({ data: { reason: 'RENAME', entityType: 'APP', entityId: foreign.id, urn: 'whoami-complete.example:old' } });
    await db.urnAlias.create({ data: { reason: 'RENAME', entityType: 'APP', entityId: b.id, urn: 'whoami-complete.example:old' } });
    for (const filter of [{ app: 'hrn:app:whoami-complete.example:old' }, { workerRef: 'hrn:worker:whoami-complete.example:old:older-worker' }]) {
      expect(await server.callToolText('hadron_whoami', filter)).toContain(old.id);
    }
    await db.urnAlias.create({ data: { reason: 'RENAME', entityType: 'APP', entityId: a.id, urn: 'whoami-complete.example:old' } });
    expect(await server.callTool('hadron_whoami', { app: 'hrn:app:whoami-complete.example:old' })).toMatchObject({ isError: true });
  });
});
