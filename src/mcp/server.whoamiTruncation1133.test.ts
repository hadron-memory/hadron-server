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
