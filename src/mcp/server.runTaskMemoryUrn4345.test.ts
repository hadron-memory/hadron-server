/**
 * #4345 — hadron_run_task's `memory` hint accepts the memory URN forms its tool
 * description and cor:api:020:01 promise ("loose name or URN"). The match goes
 * through the shared URN parser against the readable candidate set only, so an
 * unreadable URN and a non-existent URN get the same answer (cor:api:140:03).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Mem {
  id: string;
  urn: string;
  name: string;
}

let admin: { id: string };
let outsider: { id: string };
let alpha: Mem;
let foreign: Mem;

const asAdmin = (): AuthContext => ({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
// A plain user with no membership anywhere: readable set is empty-ish.
const asOutsider = (): AuthContext => ({ userId: outsider.id, roles: [], clientId: `user:${outsider.id}` });

async function mkOrgMem(orgName: string, memName: string, adminId: string): Promise<Mem> {
  const org = await db.organization.create({ data: { id: generateId(), name: orgName, urn: orgName } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
  const ctx: Context = { db, roles: ['ADMIN'], userId: adminId };
  const created = (await resolvers.Mutation.createMemory({}, { orgId: org.id, name: memName }, ctx)) as {
    id: string;
  };
  const mem = await db.memory.findUniqueOrThrow({
    where: { id: created.id },
    select: { id: true, urn: true, name: true },
  });
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: mem.id,
      loc: 'tasks:go',
      name: 'Go',
      nodeType: 'task',
      content: `Body of ${memName}`,
      isRunnable: true,
      tags: [],
    },
  });
  return mem;
}

beforeEach(async () => {
  await cleanDb(db);
  admin = await db.user.create({ data: { githubId: 4345, githubUsername: 'urn-admin', roles: ['ADMIN'] } });
  outsider = await db.user.create({ data: { githubId: 4346, githubUsername: 'urn-outsider', roles: [] } });
  alpha = await mkOrgMem('urn-org-a', 'Alpha', admin.id);
  const other = await db.user.create({ data: { githubId: 4347, githubUsername: 'urn-other', roles: [] } });
  foreign = await mkOrgMem('urn-org-b', 'Foreign', other.id);
  // The outsider reads exactly one memory of their own, so a miss answers
  // `No memory matching` (an empty readable set has its own, older message).
  await mkOrgMem('urn-org-c', 'Mine', outsider.id);
});

async function run(auth: AuthContext, memory: string): Promise<string> {
  return createTestableMcpServer(auth).callToolText('hadron_run_task', { task: 'Go', memory });
}

describe('hadron_run_task memory hint — URN forms (#4345)', () => {
  it('accepts the canonical hrn:mem: URN', async () => {
    const text = await run(asAdmin(), `hrn:mem:${alpha.urn.replace('::', ':')}`);
    expect(text).toContain('Body of Alpha');
  });

  it('accepts the legacy urn:memory: prefix, single or double colon', async () => {
    const flat = alpha.urn.replace('::', ':');
    const canon = flat.replace(':', '::');
    expect(await run(asAdmin(), `urn:memory:${flat}`)).toContain('Body of Alpha');
    expect(await run(asAdmin(), `urn:memory:${canon}`)).toContain('Body of Alpha');
  });

  it('still accepts the bare root:slug, the slug and the display name', async () => {
    expect(await run(asAdmin(), alpha.urn.replace('::', ':'))).toContain('Body of Alpha');
    expect(await run(asAdmin(), 'Alpha')).toContain('Body of Alpha');
  });

  it('resolves a legacy URN through the stored legacy_urn alias, inside the readable set', async () => {
    await db.memory.update({ where: { id: alpha.id }, data: { legacyUrn: 'old-org:old-alpha' } });
    expect(await run(asAdmin(), 'urn:memory:old-org:old-alpha')).toContain('Body of Alpha');
  });

  it('answers an unreadable memory URN and a non-existent URN with the same text (cor:api:140:03)', async () => {
    const foreignUrn = `hrn:mem:${foreign.urn.replace('::', ':')}`;
    const missingUrn = 'hrn:mem:no-such-org:no-such-mem';
    const a = await run(asOutsider(), foreignUrn);
    const b = await run(asOutsider(), missingUrn);
    expect(a).toContain(`No memory matching "${foreignUrn}"`);
    expect(a.replace(foreignUrn, '<H>')).toBe(b.replace(missingUrn, '<H>'));
    expect(a).not.toContain('Body of Foreign');
  });

  it('does not resolve an unreadable memory through its legacy_urn either', async () => {
    await db.memory.update({ where: { id: foreign.id }, data: { legacyUrn: 'old-b:old-foreign' } });
    const legacy = 'urn:memory:old-b:old-foreign';
    const missing = 'urn:memory:old-b:nothing-here';
    const a = await run(asOutsider(), legacy);
    const b = await run(asOutsider(), missing);
    expect(a).not.toContain('Body of Foreign');
    expect(a.replace(legacy, '<H>')).toBe(b.replace(missing, '<H>'));
  });
});
