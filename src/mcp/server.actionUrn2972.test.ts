/**
 * #2972 — the MCP spelling of "a nested `register:` loc is not an entry".
 *
 * The `Action URN:` projection line (single `hadron_get_node` and batch
 * `hadron_get_nodes`, cor:api:040:01 parity) must be absent QUIETLY for a
 * nested `register:a:b` loc in a live Agent's system memory: it is a writable
 * namespace loc (reading (i)), not an entry needing repair. The single-atom
 * drift case keeps its warn.
 *
 * Red on main: the single-read quiet pin (main's single path warns "needs
 * repair" for `register:a:b`). The batch pin is EVIDENCE — main's batch catch
 * already nulls silently (server.ts :1870) — pinning the contract through the
 * shared-helper refactor: the mixed batch still serves the real entry's line.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { emitNodeUrnV2 } from '../lib/urnEmit.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const PORTAL = 'https://hadronmemory.com';
const M = resolvers.Mutation as any;
const CODE = 'task.finish.open-children'; // the amendment's canonical valid code

let org: { id: string; urn: string };
let admin: { id: string };
let teamAgent: { id: string; urn: string };
let teamMemoryId: string;
let teamMemoryUrn: string;

const gqlCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const auth = (userId: string): AuthContext => ({ userId, roles: ['READER'], clientId: `user:${userId}` });
const getNode = (ref: string) =>
  createTestableMcpServer(auth(admin.id)).callToolText('hadron_get_node', { urn: ref });
const getNodes = (refs: string[]) =>
  createTestableMcpServer(auth(admin.id)).callToolText('hadron_get_nodes', { refs });

async function rawNode(memoryId: string, loc: string) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x' } });
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.FRONTEND_URL = PORTAL;
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'mcp-au2972-org', urn: `mcpau2972-${suffix}.example` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 2972101, githubUsername: 'mcp-au2972-admin', handle: 'mcp-au2972-admin', roles: ['READER'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, gqlCtx(admin.id));
  const teamRow = await db.agent.findUniqueOrThrow({ where: { id: created.id } });
  teamAgent = { id: teamRow.id, urn: teamRow.urn };
  teamMemoryId = teamRow.systemMemoryId as string;
  teamMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: teamMemoryId } })).urn;
  await rawNode(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)
});

afterEach(() => {
  // vitest.config pins FRONTEND_URL off for every other file; restore that.
  process.env.FRONTEND_URL = '';
});

describe('#2972 — Action URN line, nested register: locs (hadron_get_node)', () => {
  it('is absent QUIETLY for register:a:b — no line, and no repair warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await rawNode(teamMemoryId, 'register:a:b');
    const text = await getNode(emitNodeUrnV2(teamMemoryUrn, 'register:a:b'));
    expect(text).not.toContain('Action URN:');
    // Scoped to THIS memory's nodes — a namespace loc is not repair-worthy.
    const ours = warn.mock.calls.filter((c) => String(c[0]).includes(teamMemoryId));
    expect(ours).toEqual([]);
    // The node itself is served — a namespace loc reads fine by node address.
    expect(text).toContain(`hrn:node:${teamMemoryUrn}:register:a:b`);
    warn.mockRestore();
  });

  it('a single-atom unemittable stored code still omits the line AND warns (drift defence, evidence)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await rawNode(teamMemoryId, 'register:bad code!');
    const text = await getNode(`hrn:node:${teamMemoryUrn}:register:bad code!`);
    expect(text).not.toContain('Action URN:');
    // Scoped to THIS memory: async warns from earlier tests can land in the
    // spy after their own restore, and the node's own URN line warns
    // separately (safeUrnEmit) — only the action-URN repair signal counts.
    const repair = warn.mock.calls.filter(
      (c) => String(c[0]).startsWith('[Action URN:]') && String(c[0]).includes(teamMemoryId),
    );
    expect(repair).toHaveLength(1);
    expect(String(repair[0]?.[0])).toContain('needs repair');
    warn.mockRestore();
  });
});

describe('#2972 — Action URN line, batch (hadron_get_nodes)', () => {
  it('a mixed batch serves the real entry\'s line, omits the nested loc\'s, and never warns for its own nodes (evidence: main\'s batch catch is already quiet)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await rawNode(teamMemoryId, `register:${CODE}`);
    await rawNode(teamMemoryId, 'register:a:b');
    const text = await getNodes([
      emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`),
      emitNodeUrnV2(teamMemoryUrn, 'register:a:b'),
    ]);
    expect(text).toContain(`Action URN: hrn:action:${teamAgent.urn}:${CODE}`);
    // the nested loc gets no line of its own while its node line is present
    expect(text).not.toContain(`Action URN: hrn:action:${teamAgent.urn}:a:b`);
    expect(text).toContain(`hrn:node:${teamMemoryUrn}:register:a:b`);
    // Scoped to THIS memory (async leak from earlier tests is not ours).
    const ours = warn.mock.calls.filter((c) => String(c[0]).includes(teamMemoryId));
    expect(ours).toEqual([]);
    warn.mockRestore();
  });
});
