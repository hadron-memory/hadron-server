/**
 * #1640: the same caller, token and memory get the same WRITE answer on both
 * surfaces. GraphQL (CLI/portal) lets a live org CONTRIBUTOR+ write a
 * free-standing org `knowledge` memory, and a MemoryMember writer/owner write a
 * `group` one; the MCP gate answered "Write access denied" and labelled the
 * memory (read-only) for the same caller. Ruling DR = A: an App narrows scope,
 * it never takes away an existing grant, so the arm holds with or without an
 * active App. Refusals stay: READER, a foreign org (concealed), app-scoped rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestableMcpServer } from './server.js';
import { canWriteToMemory, getMemoryAccess } from './access-control.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { requireMemoryWriteAccess } from '../api/graphql/schema/resolvers.helpers.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

type Role = 'READER' | 'CONTRIBUTOR' | 'ADMIN';
let org: { id: string; urn: string };
let appId: string;
const users: Record<string, string> = {};
const mem: Record<string, { id: string; urn: string }> = {};

async function user(name: string, orgRole?: Role, inOrg = org) {
  const u = await db.user.create({
    data: { id: generateId(), githubId: 164000 + Object.keys(users).length, githubUsername: `w1640-${name}`, handle: `w1640-${name}`, roles: ['READER'] },
  });
  if (orgRole) await db.orgMember.create({ data: { organizationId: inOrg.id, userId: u.id, role: orgRole } });
  users[name] = u.id;
}

beforeEach(async () => {
  await cleanDb(db);
  for (const k of Object.keys(users)) delete users[k];
  org = await db.organization.create({ data: { id: generateId(), name: 'w1640', urn: 'w1640.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other1640.example' } });
  const app = await db.app.create({ data: { id: generateId(), name: 'App', urn: 'w1640.example:app', organizationId: org.id } });
  appId = app.id;
  const make = async (key: string, cls: 'knowledge' | 'group', extra: Record<string, unknown> = {}) => {
    mem[key] = await db.memory.create({
      data: { id: generateId(), urn: `w1640.example:${key}`, name: key, class: cls, organizationId: org.id,
        visibility: cls === 'group' ? 'GROUP' : 'ORGANIZATION', ...extra },
    });
  };
  await make('km', 'knowledge');
  await make('grp', 'group');
  await make('scoped', 'knowledge', { appId });
  await user('contrib', 'CONTRIBUTOR');
  await user('reader', 'READER');
  await user('outsider', 'CONTRIBUTOR', other);
  await user('writer', 'READER');
  await db.memoryMember.create({ data: { memoryId: mem.grp.id, userId: users.writer, role: 'writer' } });
  await db.appMember.create({ data: { appId, userId: users.contrib, role: 'member' } });
});

const gql = async (userId: string, memoryId: string, withApp: boolean) =>
  requireMemoryWriteAccess({ db, userId, roles: ['READER'], ...(withApp ? { appId } : {}) } as never, memoryId)
    .then(() => true, () => false);

const mcpCreate = async (userId: string, key: string, withApp: boolean) => {
  const server = createTestableMcpServer({ userId, roles: ['READER'], ...(withApp ? { appId } : {}) });
  return server.callToolText('hadron_create_node', { urn: `hrn:node:${mem[key].urn}:probe:${generateId().slice(0, 6)}`, name: 'probe' });
};

describe.each([[false], [true]])('#1640 both surfaces agree (active App: %s)', (withApp) => {
  it.each([
    ['contrib', 'km', true],
    ['reader', 'km', false],
    ['contrib', 'grp', false],
    ['writer', 'grp', true],
    ['contrib', 'scoped', false],
  ] as const)('%s on %s: write allowed = %s on GraphQL and MCP', async (who, key, allowed) => {
    expect(await gql(users[who], mem[key].id, withApp)).toBe(allowed);
    const text = await mcpCreate(users[who], key, withApp);
    if (allowed) expect(text).toMatch(/Node saved/);
    else expect(text).toMatch(/denied|not found|read-only|Forbidden/i);
  });

  it('a foreign-org caller learns nothing: not-found on MCP, refused on GraphQL', async () => {
    expect(await gql(users.outsider, mem.km.id, withApp)).toBe(false);
    expect(await mcpCreate(users.outsider, 'km', withApp)).toMatch(/Memory not found/);
  });

  it('hadron_list_memories labels the memory read-write exactly when writes are allowed', async () => {
    const server = createTestableMcpServer({ userId: users.contrib, roles: ['READER'], ...(withApp ? { appId } : {}) });
    const text = await server.callToolText('hadron_list_memories', {});
    expect(text).toMatch(new RegExp(`${mem.km.urn}[^\\n]*read-write`));
  });
});

describe('#1640 the arm stays closed to everything it must not admit', () => {
  const auth = (who: string) => ({ userId: users[who], roles: ['READER'] }) as never;

  it('a revoked CONTRIBUTOR does not write org knowledge', async () => {
    await user('revoked', 'CONTRIBUTOR');
    await db.orgMember.updateMany({ where: { userId: users.revoked }, data: { deletedAt: new Date() } });
    expect(await canWriteToMemory(db, auth('revoked'), mem.km.id)).toBe(false);
  });

  it('a CONTRIBUTOR of a soft-deleted org does not write its knowledge', async () => {
    const dead = await db.organization.create({ data: { id: generateId(), name: 'dead', urn: 'dead1640.example', deletedAt: new Date() } });
    const deadKm = await db.memory.create({
      data: { id: generateId(), urn: 'dead1640.example:km', name: 'km', class: 'knowledge', organizationId: dead.id, visibility: 'ORGANIZATION' },
    });
    await user('deadmember', 'CONTRIBUTOR', dead);
    expect(await canWriteToMemory(db, auth('deadmember'), deadKm.id)).toBe(false);
  });

  it('an AppRun acting for a CONTRIBUTOR does not write org knowledge', async () => {
    const run = runAuthContext({ id: generateId(), appId, userId: users.contrib, organizationId: org.id });
    expect(await canWriteToMemory(db, run, mem.km.id)).toBe(false);
    expect((await getMemoryAccess(db, run)).get(mem.km.id)).not.toBe('READ_WRITE');
  });

  it('an impersonation session does not write org knowledge', async () => {
    const impersonated = { userId: users.contrib, roles: ['READER'], impersonation: { orgId: org.id } } as never;
    expect(await canWriteToMemory(db, impersonated, mem.km.id)).toBe(false);
  });

  it("another user's per-user knowledge holding is not writable by an org CONTRIBUTOR", async () => {
    const agent = await db.agent.create({ data: { id: generateId(), urn: 'w1640.example:holder', name: 'holder', organizationId: org.id } });
    const holding = await db.memory.create({
      data: { id: generateId(), urn: 'w1640.example:holding', name: 'holding', class: 'knowledge', organizationId: org.id,
        visibility: 'ORGANIZATION', userMemoryOfAgentId: agent.id },
    });
    expect(await canWriteToMemory(db, auth('contrib'), holding.id)).toBe(false);
  });

  it('a group MemoryMember reader does not write the group, and an owner does', async () => {
    await user('greader', 'CONTRIBUTOR');
    await db.memoryMember.create({ data: { memoryId: mem.grp.id, userId: users.greader, role: 'reader' } });
    expect(await canWriteToMemory(db, auth('greader'), mem.grp.id)).toBe(false);
    await user('gowner', 'READER');
    await db.memoryMember.create({ data: { memoryId: mem.grp.id, userId: users.gowner, role: 'owner' } });
    expect(await canWriteToMemory(db, auth('gowner'), mem.grp.id)).toBe(true);
  });
});
