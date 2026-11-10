/**
 * #437 — the MCP wire contract of `hadron_find_nodes.limit`: an integer on the
 * wire (z.number().int(), pinned through the registered zod schema because
 * createTestableMcpServer bypasses zod), silently clamped to [1, 200] by the
 * findNodes core it delegates to (never a protocol reject, never a raw
 * negative-LIMIT database error), with the query/survey defaults (10/20)
 * preserved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let memory: { id: string; urn: string };
const as = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });
const N = 205; // one past the cap

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Clamp MCP Org', urn: 'clampmcp437.example' } });
  admin = await db.user.create({ data: { id: generateId(), handle: 'clamp-mcp-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'clamp' }, as());
  await db.node.createMany({
    data: Array.from({ length: N }, (_, i) => ({
      id: generateId(), memoryId: memory.id, loc: `doc:${String(i).padStart(4, '0')}`,
      name: `Corridor doc ${i}`, abstract: 'corridor policy', content: 'corridor policy text',
    })),
  });
});

const mcp = () => createTestableMcpServer({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
const urn = () => (memory.urn.startsWith('hrn:') ? memory.urn : `hrn:mem:${memory.urn}`);
// Every default-view hit renders one `- **<urn>** …` header line.
const hitCount = (out: string) => (out.match(/^- \*\*/gm) ?? []).length;

describe('#437 hadron_find_nodes limit wire contract', () => {
  it('limit is an integer on the wire: the registered schema rejects 2.5', async () => {
    const schema = mcp().toolParamSchema('hadron_find_nodes', 'limit');
    expect(() => schema.parse(2.5)).toThrow();
    expect(() => schema.parse(NaN)).toThrow();
  });

  it('out-of-range integers are ACCEPTED on the wire and clamped by the core, not rejected', async () => {
    const schema = mcp().toolParamSchema('hadron_find_nodes', 'limit');
    expect(schema.parse(500000)).toBe(500000);
    expect(schema.parse(-1)).toBe(-1);
  });

  it('limit 500000 returns exactly 200 hits of 205 matches, with no internal error', async () => {
    const out = await mcp().callToolText('hadron_find_nodes', { query: 'corridor', memoryUrn: urn(), limit: 500000 });
    expect(out).not.toContain('[internal_server_error]');
    expect(hitCount(out)).toBe(200);
  });

  it('limit -1 clamps to 1 hit instead of a raw negative-LIMIT database error', async () => {
    const out = await mcp().callToolText('hadron_find_nodes', { query: 'corridor', memoryUrn: urn(), limit: -1 });
    expect(out).not.toContain('[internal_server_error]');
    expect(hitCount(out)).toBe(1);
  });

  it('a fractional limit passed past the schema (test bypass) truncates to 2, never crashes', async () => {
    const out = await mcp().callToolText('hadron_find_nodes', { query: 'corridor', memoryUrn: urn(), limit: 2.5 });
    expect(out).not.toContain('[internal_server_error]');
    expect(hitCount(out)).toBe(2);
  });

  it('defaults are preserved: 10 for a query, 20 for survey mode', async () => {
    const query = await mcp().callToolText('hadron_find_nodes', { query: 'corridor', memoryUrn: urn() });
    expect(hitCount(query)).toBe(10);
    const survey = await mcp().callToolText('hadron_find_nodes', { query: '*', memoryUrn: urn() });
    expect(hitCount(survey)).toBe(20);
  });

  it('survey mode clamps too: limit 500000 lists 200, not all 205', async () => {
    const out = await mcp().callToolText('hadron_find_nodes', { query: '*', memoryUrn: urn(), limit: 500000 });
    expect(hitCount(out)).toBe(200);
  });

  it('the limit description states the cap', async () => {
    const desc = mcp().toolParamDescription('hadron_find_nodes', 'limit');
    expect(desc).toMatch(/200/);
  });
});
