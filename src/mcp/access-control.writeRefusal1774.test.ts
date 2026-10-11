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
import { canReadMemory, canWriteToMemory, explainWriteRefusal } from './access-control.js';
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
  it('app-scoped memory, caller already in the App with a read grant: says the missing piece is a write grant', async () => {
    // A reader-only participant: the App's agent carries the memory with role "read".
    const agent = await db.agent.create({ data: { id: generateId(), urn: 'w1774.example:eng', name: 'eng', organizationId: org.id } });
    await db.appAgent.create({ data: { appId, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: mem.scoped.id, role: 'read' } });
    await db.appMember.create({ data: { appId, userId: users.reader, role: 'member' } });
    expect(await why(auth('reader'), 'scoped')).toMatch(/participate in this memory's App but hold only a read grant[^.]*write grant/);
    expect(await why(auth('reader'), 'scoped')).not.toMatch(/needs participation/);
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

describe('#1774 bound App key', () => {
  it("a session-bound App key reading its agent's system memory is told it writes only session memory", async () => {
    const agent = await db.agent.create({ data: { id: generateId(), urn: 'w1774.example:bound', name: 'bound', organizationId: org.id } });
    const sys = await db.memory.create({
      data: { id: generateId(), urn: 'w1774.example:bound-system', name: 'sys', class: 'system', visibility: null, organizationId: org.id },
    });
    await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: sys.id } });
    await db.appAgent.create({ data: { appId, agentId: agent.id } });
    const session = await db.session.create({
      data: { id: generateId(), appId, agentId: agent.id, userId: users.contrib, type: 'DEVELOPER', startedAt: new Date() },
    });
    const key = { appId, sessionId: session.id, roles: [] } as never;
    expect(await canReadMemory(db, key, sys.id)).toBe(true);
    expect(await canWriteToMemory(db, key, sys.id)).toBe(false);
    expect(await explainWriteRefusal(db, key, sys.id)).toMatch(/session-bound App key/);
  });
});

describe('#1774 a state-based refusal is not given a capability cause', () => {
  it('a caller who can write the memory is told nothing, whatever refused them a moment ago', async () => {
    expect(await why(auth('contrib'), 'km')).toBe('');
    await user('gwriter', 'READER');
    await db.memoryMember.create({ data: { memoryId: mem.grp.id, userId: users.gwriter, role: 'writer' } });
    expect(await why(auth('gwriter'), 'grp')).toBe('');
  });
});

describe('#1774 revoked membership', () => {
  it('a revoked reader can no longer read the memory, so is told nothing, not their old role', async () => {
    await db.orgMember.updateMany({ where: { userId: users.reader }, data: { deletedAt: new Date() } });
    expect(await why(auth('reader'), 'km')).toBe('');
  });
});

describe('#1774 every refusal site appends the cause', () => {
  let other: { id: string };
  beforeEach(async () => {
    other = await db.organization.create({ data: { id: generateId(), name: 'r2', urn: 'r21774.example' } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: users.contrib, role: 'READER' } });
    mem.km2 = await db.memory.create({
      data: { id: generateId(), urn: 'r21774.example:km', name: 'km', class: 'knowledge', organizationId: other.id, visibility: 'ORGANIZATION' },
    });
  });

  const as = (who: string) => createTestableMcpServer({ userId: users[who], roles: ['READER'] });
  const node = (key: string, loc: string) => `hrn:node:${mem[key].urn}:${loc}`;
  const seed = async (key: string, loc: string) =>
    db.node.create({ data: { id: generateId(), memoryId: mem[key].id, loc, name: loc } });

  // [site, tool, build args as a caller who can read but not write mem.km (or km2 for the target)]
  it.each([
    ['create_parent_node', 'hadron_create_parent_node', 'this memory'],
    ['create_node', 'hadron_create_node', 'this memory'],
    ['update_node', 'hadron_update_node', 'this memory'],
    ['move_node source', 'hadron_move_node', 'source memory'],
    ['move_node target', 'hadron_move_node', 'target memory'],
    ['create_edge', 'hadron_create_edge', 'source memory'],
  ] as const)('%s', async (site, tool, noun) => {
    await seed('km', 'a');
    await seed('km', 'b');
    await seed('km2', 'c');
    let who = 'reader';
    let args: Record<string, unknown>;
    switch (site) {
      case 'create_parent_node': case 'create_node': args = { urn: node('km', 'fresh'), name: 'x' }; break;
      case 'update_node': args = { urn: node('km', 'a'), content: 'x' }; break;
      case 'move_node source': args = { urn: node('km', 'a'), targetUrn: node('km', 'moved') }; break;
      case 'move_node target': who = 'contrib'; args = { urn: node('km', 'a'), targetUrn: node('km2', 'moved') }; break;
      default: args = { sourceUrn: node('km', 'a'), targetUrn: node('km', 'b'), name: 'rel' };
    }
    const text = await as(who).callToolText(tool, args);
    expect(text).toContain(`Write access denied for ${noun}.`);
    expect(text).toMatch(/Your org role is READER; writing org memories needs CONTRIBUTOR or above\./);
  });
});
