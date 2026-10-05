/**
 * #1617 — hadron_whoami shows each open session's liveness and when it lapses.
 * Nine workers learned their session had lapsed only when a post was refused;
 * this is the read that tells them first.
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

const H = 60 * 60 * 1000;
let user: { id: string };
const auth = (): AuthContext => ({ userId: user.id, roles: ['READER'], clientId: `user:${user.id}` });

async function session(at: { startedAt: Date; updatedAt?: Date; endedAt?: Date }) {
  const row = await db.session.create({
    data: { id: generateId(), userId: user.id, type: 'DEVELOPER', startedAt: at.startedAt, endedAt: at.endedAt ?? null },
    select: { id: true },
  });
  if (at.updatedAt) await db.session.update({ where: { id: row.id }, data: { updatedAt: at.updatedAt } });
  return row;
}

/** The whoami block for one session id. */
function block(out: string, id: string): string {
  const start = out.indexOf(`- session ${id}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = out.indexOf('\n- session ', start + 1);
  const end = out.indexOf('\n\n', start);
  return out.slice(start, [next, end].filter((i) => i > 0).reduce((a, b) => Math.min(a, b), out.length));
}

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: { id: generateId(), githubId: 16171, githubUsername: `wl-${Date.now()}`, roles: ['READER'] },
  });
});

describe('#1617 — hadron_whoami liveness', () => {
  it('a live session says LIVE with the instant it lapses; a lapsed one says LAPSED and the remedy', async () => {
    const now = Date.now();
    const live = await session({ startedAt: new Date(now - 30 * H), updatedAt: new Date(now - 2 * H) });
    const lapsed = await session({ startedAt: new Date(now - 40 * H), updatedAt: new Date(now - 36 * H) });

    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});

    const liveBlock = block(out, live.id);
    expect(liveBlock).toMatch(/liveness: LIVE — lapses at \S+ \(in 21h \d+m\)/);
    expect(liveBlock).toContain('any attributed read, post or mark-read through it renews it');

    const lapsedBlock = block(out, lapsed.id);
    expect(lapsedBlock).toMatch(/liveness: LAPSED at \S+ \(12h \d+m ago\)/);
    expect(lapsedBlock).toContain('can no longer author in team chat');
  });

  it('an ended session carries no liveness line', async () => {
    const ended = await session({ startedAt: new Date(Date.now() - 2 * H), endedAt: new Date(Date.now() - 1 * H) });
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', { includeEnded: true });
    expect(block(out, ended.id)).toContain('[ENDED]');
    expect(block(out, ended.id)).not.toContain('liveness:');
  });
});
