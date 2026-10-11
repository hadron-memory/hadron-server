/**
 * #1774 (#1640 DR = A item 2): a refused MCP write names its cause.
 *
 * The bare "Write access denied for this memory." left an agent that could
 * read a memory guessing why it could not save to it. The sentence stays (it
 * is the established prose); the cause follows it, and only for a caller who
 * can READ the memory: anyone else keeps the bare text, so the refusal never
 * tells a caller about a memory they cannot see.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestableMcpServer } from './server.js';
import { explainWriteRefusal } from './access-control.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const BARE = 'Write access denied for this memory.';
let org: { id: string };
let appId: string;
const users: Record<string, string> = {};
const mem: Record<string, { id: string; urn: string }> = {};

async function user(name: string, orgRole?: 'READER' | 'CONTRIBUTOR', inOrg = org) {
  const u = await db.user.create({
    data: { id: generateId(), githubId: 177400 + Object.keys(users).length, githubUsername: `w1774-${name}`, handle: `w1774-${name}`, roles: ['READER'] },
  });
  if (orgRole) await db.orgMember.create({ data: { organizationId: inOrg.id, userId: u.id, role: orgRole } });
  users[name] = u.id;
}

beforeEach(async () => {
  await cleanDb(db);
  for (const k of Object.keys(users)) delete users[k];
  org = await db.organization.create({ data: { id: generateId(), name: 'w1774', urn: 'w1774.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'o', urn: 'o1774.example' } });
  appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: 'w1774.example:app', organizationId: org.id } })).id;
  const make = async (key: string, cls: 'knowledge' | 'group', extra: Record<string, unknown> = {}) => {
    mem[key] = await db.memory.create({
      data: { id: generateId(), urn: `w1774.example:${key}`, name: key, class: cls, organizationId: org.id,
        visibility: cls === 'group' ? 'GROUP' : 'ORGANIZATION', ...extra },
    });
  };
  await make('km', 'knowledge');
  await make('grp', 'group');
  await make('scoped', 'knowledge', { appId });
  await user('contrib', 'CONTRIBUTOR');
  await user('reader', 'READER');
  await user('outsider', 'CONTRIBUTOR', other);
  await db.memoryMember.create({ data: { memoryId: mem.grp.id, userId: users.reader, role: 'reader' } });
});

const auth = (who: string) => ({ userId: users[who], roles: ['READER'] }) as never;
const why = (a: never, key: string) => explainWriteRefusal(db, a, mem[key].id);

describe('#1774 explainWriteRefusal names the cause for a caller who can read', () => {
  it('app-scoped memory: says it belongs to an App and what to do', async () => {
    // A reader-only participant: the App's agent carries the memory with role "read".
    const agent = await db.agent.create({ data: { id: generateId(), urn: 'w1774.example:eng', name: 'eng', organizationId: org.id } });
    await db.appAgent.create({ data: { appId, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: mem.scoped.id, role: 'read' } });
    await db.appMember.create({ data: { appId, userId: users.reader, role: 'member' } });
    expect(await why(auth('reader'), 'scoped')).toMatch(/belongs to an App/i);
  });

  it('group memory: names the MemoryMember writer/owner grant', async () => {
    expect(await why(auth('reader'), 'grp')).toMatch(/MemoryMember writer or owner/);
  });

  it('org knowledge: names the CONTRIBUTOR role the caller lacks', async () => {
    expect(await why(auth('reader'), 'km')).toMatch(/CONTRIBUTOR/);
  });

  it('an impersonation session says it is read-only', async () => {
    const imp = { userId: users.contrib, roles: ['READER'], impersonation: { orgId: org.id } } as never;
    expect(await why(imp, 'km')).toMatch(/impersonation/i);
  });

  it('an AppRun says it writes only within its own App', async () => {
    const run = runAuthContext({ id: generateId(), appId, userId: users.contrib, organizationId: org.id });
    expect(await why(run as never, 'km')).toMatch(/App run/i);
  });
});

describe('#1774 concealment holds: a caller who cannot read learns nothing new', () => {
  it('a foreign-org caller gets no cause (empty suffix)', async () => {
    expect(await why(auth('outsider'), 'km')).toBe('');
    expect(await why(auth('outsider'), 'grp')).toBe('');
  });

  it('the group reader sees no cause for an app-scoped memory they cannot read', async () => {
    expect(await why(auth('reader'), 'scoped')).toBe('');
  });
});

describe('#1774 the MCP door appends the cause to the established sentence', () => {
  const create = (who: string, key: string) =>
    createTestableMcpServer({ userId: users[who], roles: ['READER'] })
      .callToolText('hadron_create_node', { urn: `hrn:node:${mem[key].urn}:probe:x`, name: 'probe' });

  it('a READER on org knowledge: bare sentence first, then the cause', async () => {
    const text = await create('reader', 'km');
    expect(text.startsWith(BARE)).toBe(true);
    expect(text).toMatch(/CONTRIBUTOR/);
  });

  it('a group MemoryMember reader is told which grant is needed', async () => {
    expect(await create('reader', 'grp')).toMatch(/MemoryMember writer or owner/);
  });

  it('a foreign-org caller still gets Memory not found, nothing more', async () => {
    expect(await create('outsider', 'km')).toMatch(/Memory not found/);
  });
});
