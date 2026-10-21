/** #2040 S1 — the MCP inline writers (hadron_create_node / hadron_update_node / hadron_create_parent_node). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../../mcp/server.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let memoryId: string;
let memoryUrn: string;
let admin: { id: string };
const gql = (): Context => ({ db, userId: admin.id, roles: [] });
const mcp = () => createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
const edgesOf = (loc: string) => db.edge.findMany({
  where: { source: { memoryId, loc }, governedKind: 'INCLUDE' }, include: { target: true },
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Inc Org', urn: 'inc.example' } });
  admin = await db.user.create({ data: { githubId: 204003, githubUsername: 'inc-admin3', handle: 'inc-admin3', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'inc' }, gql());
  memoryId = m.id; memoryUrn = m.urn;
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'b', name: 'b', content: 'B' } });
});

describe('include tags through the MCP writers (#2040)', () => {
  it('hadron_create_node: derives the edge; a malformed tag creates nothing', async () => {
    expect(await mcp().callToolText('hadron_create_node', { urn: urn('a'), name: 'a', content: '{{> b}}' })).not.toMatch(/invalid_include/);
    expect((await edgesOf('a')).map(e => e.target.loc)).toEqual(['b']);
    const refused = await mcp().callToolText('hadron_create_node', { urn: urn('n'), name: 'n', content: '{{> b nope}}' });
    expect(refused).toContain('[invalid_include]');
    expect(await db.node.count({ where: { memoryId, loc: 'n' } })).toBe(0);
  });

  it('hadron_update_node: cycle refused with no residue; retarget and inline edges keep derived rows', async () => {
    await mcp().callToolText('hadron_create_node', { urn: urn('a'), name: 'a', content: '{{> b}}' });
    const before = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'b' } });
    const refused = await mcp().callToolText('hadron_update_node', { urn: urn('b'), content: '{{> a}}' });
    expect(refused).toContain('[include_cycle]');
    const after = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'b' } });
    expect(after.content).toBe('B');
    expect(after.revSeq).toBe(before.revSeq);
    expect(await edgesOf('b')).toEqual([]);

    await mcp().callToolText('hadron_update_node', { urn: urn('a'), content: '{{> b}}', edges: [{ targetUrn: before.id, name: 'cites' }] });
    expect((await edgesOf('a')).map(e => e.target.loc)).toEqual(['b']);
    await mcp().callToolText('hadron_update_node', { urn: urn('a'), content: 'none' });
    expect(await edgesOf('a')).toEqual([]);
  });

  it('an over-depth chain saves on create and on update (#2134, cor:dmo:150:06)', async () => {
    for (let i = 1; i <= 10; i++) {
      await mcp().callToolText('hadron_create_node', { urn: urn(`n${i}`), name: `n${i}`, content: `{{> ${i === 1 ? 'b' : `n${i - 1}`}}}` });
    }
    const created = await mcp().callToolText('hadron_create_node', { urn: urn('top'), name: 'top', content: '{{> n10}}' });
    expect(created).not.toMatch(/\[include_/);
    expect((await edgesOf('top')).map(e => e.target.loc)).toEqual(['n10']);
    await mcp().callToolText('hadron_create_node', { urn: urn('later'), name: 'later', content: 'plain' });
    const updated = await mcp().callToolText('hadron_update_node', { urn: urn('later'), content: '{{> n10}}' });
    expect(updated).not.toMatch(/\[include_/);
    expect((await edgesOf('later')).map(e => e.target.loc)).toEqual(['n10']);
  });

  it('hadron_create_parent_node: a tag in the description is checked', async () => {
    const refused = await mcp().callToolText('hadron_create_parent_node', { urn: urn('p'), name: 'p', description: '{{> b nope}}' });
    expect(refused).toContain('[invalid_include]');
    expect(await db.node.count({ where: { memoryId, loc: 'p' } })).toBe(0);
  });
});
