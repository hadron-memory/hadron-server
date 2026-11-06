/**
 * #2515 — hadron_whoami reports this connection's active memory, re-authorized
 * at call time: unset or no-longer-readable answers `none` with no stale URN,
 * name or existence hint, and the report is per connection.
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
let other: { id: string };
let memA: { id: string; urn: string; name: string };
let memB: { id: string; urn: string; name: string };

const auth = (userId: string): AuthContext => ({ userId, roles: ['READER'], clientId: `user:${userId}` });

async function privateMem(userId: string, slug: string, name: string) {
  const org = await db.organization.create({ data: { id: generateId(), urn: `wam-${slug}`, name: `Org ${slug}` } });
  return db.memory.create({
    data: { id: generateId(), organizationId: org.id, userId, class: 'private', urn: `wam-${slug}:m`, name },
    select: { id: true, urn: true, name: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  user = await db.user.create({ data: { id: generateId(), githubId: 98741, githubUsername: `wam-${suffix}`, roles: ['READER'] } });
  other = await db.user.create({ data: { id: generateId(), githubId: 98742, githubUsername: `wam-o-${suffix}`, roles: ['READER'] } });
  memA = await privateMem(user.id, `a-${suffix}`, 'Alpha Memory');
  memB = await privateMem(user.id, `b-${suffix}`, 'Beta Memory');
});

describe('#2515 — hadron_whoami active memory report', () => {
  it('says none when nothing is selected, even with no open sessions', async () => {
    const out = await createTestableMcpServer(auth(user.id)).callToolText('hadron_whoami', {});
    expect(out).toContain('active memory: none');
    expect(out).toContain('You have no open sessions');
  });

  it('names the canonical URN and name of a readable selection, with no sessions', async () => {
    const s = createTestableMcpServer(auth(user.id));
    await s.callToolText('hadron_set_active_memory', { memoryUrn: memA.urn });
    const out = await s.callToolText('hadron_whoami', {});
    expect(out).toContain(`active memory: hrn:mem:${memA.urn} (Alpha Memory)`);
  });

  it('reports it with sessions listed and when a filter matches nothing', async () => {
    const s = createTestableMcpServer(auth(user.id));
    await s.callToolText('hadron_set_active_memory', { memoryUrn: memA.urn });
    const sess = await db.session.create({ data: { id: generateId(), userId: user.id, type: 'DEVELOPER' }, select: { id: true } });
    const listed = await s.callToolText('hadron_whoami', {});
    expect(listed).toContain('active memory: hrn:mem:');
    expect(listed).toContain(sess.id);
    const none = await s.callToolText('hadron_whoami', { workerRef: 'nobody-by-that-name' });
    expect(none).toContain('active memory: hrn:mem:');
    expect(none).toContain('No matching session.');
  });

  it('answers none, with no stale URN or name, once the selection is deleted or unreadable', async () => {
    const s = createTestableMcpServer(auth(user.id));
    await s.callToolText('hadron_set_active_memory', { memoryUrn: memA.urn });
    await db.memory.update({ where: { id: memA.id }, data: { deletedAt: new Date() } });
    const deleted = await s.callToolText('hadron_whoami', {});
    expect(deleted).toContain('active memory: none');
    expect(deleted).not.toContain('Alpha Memory');
    expect(deleted).not.toContain(memA.urn);

    await s.callToolText('hadron_set_active_memory', { memoryUrn: memB.urn });
    await db.memory.update({ where: { id: memB.id }, data: { userId: other.id } });
    const revoked = await s.callToolText('hadron_whoami', {});
    expect(revoked).toContain('active memory: none');
    expect(revoked).not.toContain('Beta Memory');
    expect(revoked).not.toContain(memB.urn);
    // Same bytes as a selection that never existed: no hidden sentinel.
    const never = await createTestableMcpServer(auth(user.id)).callToolText('hadron_whoami', {});
    expect(revoked.split('\n')[0]).toBe(never.split('\n')[0]);
  });

  it('does not clear or rewrite the selection: it reappears when readable again', async () => {
    const s = createTestableMcpServer(auth(user.id));
    await s.callToolText('hadron_set_active_memory', { memoryUrn: memA.urn });
    await db.memory.update({ where: { id: memA.id }, data: { deletedAt: new Date() } });
    expect(await s.callToolText('hadron_whoami', {})).toContain('active memory: none');
    await db.memory.update({ where: { id: memA.id }, data: { deletedAt: null } });
    expect(await s.callToolText('hadron_whoami', {})).toContain('hrn:mem:' + memA.urn);
  });

  it('is per connection: two connections keep distinct selections', async () => {
    const s1 = createTestableMcpServer(auth(user.id));
    const s2 = createTestableMcpServer(auth(user.id));
    await s1.callToolText('hadron_set_active_memory', { memoryUrn: memA.urn });
    await s2.callToolText('hadron_set_active_memory', { memoryUrn: memB.urn });
    expect(await s1.callToolText('hadron_whoami', {})).toContain('Alpha Memory');
    expect(await s2.callToolText('hadron_whoami', {})).toContain('Beta Memory');
    expect(await s1.callToolText('hadron_whoami', {})).not.toContain('Beta Memory');
  });

  it('leaves the refusals alone: no report on impersonation or unauthenticated', async () => {
    const out = await createTestableMcpServer({ roles: [], clientId: 'anon' } as AuthContext).callToolText('hadron_whoami', {});
    expect(out).not.toContain('active memory:');
  });

  it('keeps hadron_server_info free of the selection', async () => {
    const s = createTestableMcpServer(auth(user.id));
    await s.callToolText('hadron_set_active_memory', { memoryUrn: memA.urn });
    expect(await s.callToolText('hadron_server_info', {})).not.toContain('Alpha Memory');
  });
});
