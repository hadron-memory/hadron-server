/**
 * #1301 — a governed refusal must name a route its reader can actually take.
 *
 * A customer PM ran `hadron node update --data-merge` on a spec node and was
 * told only `updateSpecNode` may update it, a GraphQL mutation no command she
 * had names. The protection was right; the message sent her to a door she
 * could not see, and for a MERGE it was wrong outright: the door REPLACES, so
 * following the hint literally would drop every key she did not resend.
 *
 * Each case below pins a claim the message makes AND that the route it names
 * works for the same caller, because a refusal that names a dead door is the
 * defect. The caller is a real customer shape: default platform roles
 * (`[READER]`), OWNER of her organisation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { GOVERNED_KINDS } from '../../../lib/governedRole.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
let memoryId: string;
let uid: string;
const ctx = (): Context => ({ db, roles: ['READER'], userId: uid, clientId: `user:${uid}` });

/** The refusal, as data, so each case can assert on it. */
async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string; ext: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; extensions?: Record<string, unknown> };
    return { code: err.extensions?.code as string | undefined, message: err.message, ext: err.extensions ?? {} };
  }
  throw new Error('expected a refusal, and the write succeeded');
}

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'gr', urn: `gr-${t}` } });
  uid = (await db.user.create({ data: { id: generateId(), githubId: 13011, githubUsername: `gr-${t}` } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: uid, role: 'OWNER' } });
  memoryId = (await M.createMemory({}, { orgId: org.id, name: `gr-${t}` }, ctx())).id;
});

const spec = () =>
  M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010', name: 'f', role: 'spec', data: { version: '0.0.1' } } }, ctx());

describe('a data MERGE on a spec node (what `hadron node update --data-merge` sends)', () => {
  it('says no door merges and names the REPLACE route, with every surface', async () => {
    const n = await spec();
    const r = await refusal(M.updateNodeData({}, { nodeRef: n.id, data: { provenance: 'x' } }, ctx()));

    expect(r.code).toBe('ROLE_GOVERNED');
    expect(r.ext).toMatchObject({ kind: 'spec', door: 'updateSpecNode', mcpDoor: null, merge: 'data' });
    expect(r.message).toContain('no door merges');
    expect(r.message).toContain('updateSpecNode REPLACES data');
    expect(r.message).toContain('including the keys it already has');
    expect(r.message).toContain("`hadron node update <ref> --data '<object>'`");
    expect(r.message).toContain('No MCP tool writes a spec node');
  });

  it('TRUTHFUL: the route it names works for the same caller, and keeps what was resent', async () => {
    const n = await spec();
    // What `hadron node update <ref> --data '<object>'` does for a spec node:
    // the CLI routes the replace through updateSpecNode by the node's kind.
    await M.updateSpecNode({}, { input: { id: n.id, data: { version: '0.0.1', provenance: 'x' } } }, ctx());
    const after = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect(after.data).toEqual({ version: '0.0.1', provenance: 'x' });
  });
});

describe('a properties MERGE on a spec node', () => {
  it('names the properties replace route, not the data one', async () => {
    const n = await spec();
    const r = await refusal(M.updateNodeProperties({}, { nodeRef: n.id, properties: { k: 1 } }, ctx()));

    expect(r.code).toBe('ROLE_GOVERNED');
    expect(r.ext).toMatchObject({ merge: 'properties' });
    expect(r.message).toContain('updateSpecNode REPLACES properties');
    expect(r.message).toContain("--properties '<object>'");
  });
});

describe('a generic (non-merge) write on a spec node', () => {
  it('names the GraphQL door, that the CLI routes there itself, the spec commands, and no MCP route', async () => {
    const n = await spec();
    const r = await refusal(M.updateNode({}, { input: { id: n.id, content: 'x' } }, ctx()));

    expect(r.code).toBe('ROLE_GOVERNED');
    expect(r.ext).not.toHaveProperty('merge');
    expect(r.message).toContain('which only updateSpecNode may update');
    expect(r.message).toContain('`hadron node update` routes to it by itself');
    expect(r.message).toContain('`hadron spec new` and `hadron spec edit` are the spec commands');
    expect(r.message).toContain('No MCP tool writes a spec node');
  });
});

describe('a data MERGE on a TASK names the MCP door, which accepts data', () => {
  it('points an agent at hadron_update_task', async () => {
    // The GraphQL door exempts the kind but does not SET the flag: pass it.
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:t', name: 't', content: 'Do it.', isRunnable: true } }, ctx());
    const r = await refusal(M.updateNodeData({}, { nodeRef: t.id, data: { a: 1 } }, ctx()));

    expect(r.ext).toMatchObject({ kind: 'task', door: 'updateTaskNode', mcpDoor: 'hadron_update_task', merge: 'data' });
    expect(r.message).toContain('Over MCP, pass data to hadron_update_task');
  });
});

describe('the register names only MCP tools that exist', () => {
  it('every mcpDoors entry is a registered tool, so no refusal can name a dead door', () => {
    const srv = createTestableMcpServer({ roles: [], clientId: 'test' } as never);
    const tools = new Set(srv.toolNames());
    // Positive control: the lookup sees real tools at all.
    expect(tools.has('hadron_create_node')).toBe(true);
    for (const entry of GOVERNED_KINDS) {
      for (const name of Object.values(entry.mcpDoors ?? {})) {
        expect(tools.has(name), `${entry.kind}: ${name}`).toBe(true);
      }
    }
    // And the kind with no MCP door really has none by any name.
    expect([...tools].filter((t) => /spec/.test(t) && /create|update/.test(t))).toEqual([]);
  });
});
