/**
 * #4290 — hadron_whoami names the signed-in principal on a line AFTER the
 * `active memory:` line (cor:api:020:01 pins that line first): a user's own
 * handle and live orgs; a pure App-key caller its own App only; refusals name
 * no one.
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

const auth = (userId: string): AuthContext => ({ userId, roles: ['READER'], clientId: `user:${userId}` });

let me: { id: string; handle: string; email: string | null };
let stranger: { id: string; handle: string };
let sfx: string;

async function org(slug: string, name: string) {
  return db.organization.create({ data: { id: generateId(), urn: `wp-${sfx}-${slug}`, name } });
}

beforeEach(async () => {
  await cleanDb(db);
  sfx = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  me = await db.user.create({
    data: { id: generateId(), githubId: 98751, githubUsername: `wp-${sfx}`, handle: `meh${sfx}`.slice(0, 20), email: `me-${sfx}@example.test`, roles: ['READER'] },
    select: { id: true, handle: true, email: true },
  });
  stranger = await db.user.create({
    data: { id: generateId(), githubId: 98752, githubUsername: `wp-s-${sfx}`, handle: `str${sfx}`.slice(0, 20), roles: ['READER'] },
    select: { id: true, handle: true },
  });
});

describe('#4290 — hadron_whoami principal line', () => {
  it('names the caller handle after the active-memory line, with no sessions', async () => {
    const out = await createTestableMcpServer(auth(me.id)).callToolText('hadron_whoami', {});
    const lines = out.split('\n');
    expect(lines[0]).toBe('active memory: none');
    expect(lines[1]).toContain(`@${me.handle}`);
    expect(out).toContain('You have no open sessions');
  });

  it('lists only the caller\'s live orgs, never a stranger\'s or a revoked one', async () => {
    const mine = await org('mine', 'Mine Org');
    const revoked = await org('revoked', 'Revoked Org');
    const theirs = await org('theirs', 'Theirs Org');
    await db.orgMember.create({ data: { id: generateId(), organizationId: mine.id, userId: me.id, role: 'READER' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: revoked.id, userId: me.id, role: 'READER', deletedAt: new Date() } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: theirs.id, userId: stranger.id, role: 'READER' } });
    const out = await createTestableMcpServer(auth(me.id)).callToolText('hadron_whoami', {});
    expect(out).toContain(mine.urn);
    expect(out).not.toContain(revoked.urn);
    expect(out).not.toContain(theirs.urn);
    expect(out).not.toContain(stranger.handle);
  });

  it('keeps the principal line with sessions listed and a no-match filter', async () => {
    const sess = await db.session.create({ data: { id: generateId(), userId: me.id, type: 'DEVELOPER' }, select: { id: true } });
    const s = createTestableMcpServer(auth(me.id));
    const listed = await s.callToolText('hadron_whoami', {});
    expect(listed.split('\n')[0]).toMatch(/^active memory: /);
    expect(listed.split('\n')[1]).toContain(`@${me.handle}`);
    expect(listed).toContain(sess.id);
    const none = await s.callToolText('hadron_whoami', { workerRef: 'nobody-by-that-name' });
    expect(none.split('\n')[1]).toContain(`@${me.handle}`);
  });

  it('does not disclose the caller email', async () => {
    const out = await createTestableMcpServer(auth(me.id)).callToolText('hadron_whoami', {});
    expect(out).not.toContain(me.email as string);
  });

  it('names only its own App for a pure App-key caller, never another App or the creator', async () => {
    const o = await org('app', 'App Org');
    const mkApp = (slug: string, name: string) =>
      db.app.create({ data: { id: generateId(), organizationId: o.id, urn: `${o.urn}:${slug}`, name, createdBy: stranger.id } as never });
    const mine = await mkApp('mine', 'My App Name');
    const other = await mkApp('other', 'Other App Name');
    const out = await createTestableMcpServer({ appId: mine.id, roles: ['READER'], clientId: `app:${mine.id}` } as AuthContext)
      .callToolText('hadron_whoami', {});
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^active memory: /);
    expect(lines[1]).toContain('My App Name');
    expect(out).not.toContain('Other App Name');
    expect(out).not.toContain(stranger.handle);
  });

  it('names no one in an impersonation refusal or an unauthenticated refusal', async () => {
    const imp = await createTestableMcpServer({
      ...auth(me.id), impersonation: { adminUserId: stranger.id, targetUserId: me.id, orgId: 'x' },
    } as unknown as AuthContext).callToolText('hadron_whoami', {});
    expect(imp).not.toContain(me.handle);
    const anon = await createTestableMcpServer({ roles: ['READER'], clientId: 'anon' } as AuthContext).callToolText('hadron_whoami', {});
    expect(anon).not.toMatch(/signed in as/);
  });
});
