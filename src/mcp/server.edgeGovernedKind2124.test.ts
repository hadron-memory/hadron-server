/**
 * #2124 — the MCP edge lines carry the edge's own `governedKind`: get_node
 * (Related + Referenced by), get_nodes, get_next_node and find_nodes (brief)
 * all print `(governedKind: <KIND|null>)` from the one shared formatter, with
 * the same tokens GraphQL returns. null means an ordinary edge, whatever the
 * edge is NAMED.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let bob: { id: string };
let mcp: ReturnType<typeof createTestableMcpServer>;
let commentedId: string;
let rootId: string;

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-8);
  bob = await db.user.create({ data: { id: generateId(), handle: `bob2124-${sfx}`, githubUsername: `bob2124-${sfx}`, roles: ['READER'] } });
  const mem = await db.memory.create({ data: { id: generateId(), ownerUserId: bob.id, userId: bob.id, class: 'personal', name: 'gk', urn: 'c2124.test:gk' } });
  const p = await db.node.create({ data: { memoryId: mem.id, loc: 'p', name: 'Parent', content: 'parent body', description: 'parent desc' } });
  const t1 = await db.node.create({ data: { memoryId: mem.id, loc: 'p:plain', name: 'Plain Target', seq: 1 } });
  const t2 = await db.node.create({ data: { memoryId: mem.id, loc: 'p:inc', name: 'Include Target', seq: 2 } });
  const q = await db.node.create({ data: { memoryId: mem.id, loc: 'q', name: 'Q' } });
  const qc = await db.node.create({ data: { memoryId: mem.id, loc: 'q:c', name: 'Q Child', seq: 1 } });
  await db.edge.create({ data: { memoryId: mem.id, sourceId: qc.id, targetId: t2.id, name: 'inc', loc: 'q:c:inc:inc', governedKind: 'INCLUDE' } });
  void q;
  // An ordinary edge deliberately NAMED `includes`.
  await db.edge.create({ data: { memoryId: mem.id, sourceId: p.id, targetId: t1.id, name: 'includes', loc: 'p:includes:plain' } });
  await db.edge.create({ data: { memoryId: mem.id, sourceId: p.id, targetId: t2.id, name: 'include', loc: 'p:include:inc', governedKind: 'INCLUDE' } });
  const ctx = { db, userId: bob.id, roles: [] } as any;
  const M = resolvers.Mutation as any;
  commentedId = t1.id;
  const root = await M.createComment(null, { targetRef: t1.id, body: 'root' }, ctx);
  rootId = root.id;
  await M.replyToComment(null, { commentRef: root.id, body: 'reply' }, ctx);
  mcp = createTestableMcpServer({ userId: bob.id, roles: ['READER'], clientId: `user:${bob.id}` });
});

describe('MCP governedKind annotation (#2124)', () => {
  it('hadron_get_node: Related names each outgoing edge kind; "includes"-named edge is null', async () => {
    const out = await mcp.callToolText('hadron_get_node', { urn: 'hrn:node:c2124.test:gk:p' });
    expect(out).toMatch(/Plain Target\) — includes \(governedKind: null\)/);
    expect(out).toMatch(/Include Target\) — include \(governedKind: INCLUDE\)/);
  });

  it('hadron_get_node: Referenced by names the anchor and reply kinds', async () => {
    const anchored = await mcp.callToolText('hadron_get_node', { urn: 'hrn:node:c2124.test:gk:p:plain' });
    expect(anchored).toContain('(governedKind: COMMENT_ANCHOR)');
    const root = await mcp.callToolText('hadron_get_node', { urn: `hrn:node:c2124.test:gk:comments:${rootId}` });
    expect(root).toContain('(governedKind: COMMENT_REPLY)');
    expect(commentedId).toBeTruthy();
  });

  it('hadron_get_nodes shares the formatter', async () => {
    const out = await mcp.callToolText('hadron_get_nodes', { refs: ['hrn:node:c2124.test:gk:p'] });
    expect(out).toContain('(governedKind: INCLUDE)');
    expect(out).toContain('(governedKind: null)');
  });

  it('hadron_get_next_node prints the kind on its Related lines', async () => {
    const out = await mcp.callToolText('hadron_get_next_node', { parent: 'hrn:node:c2124.test:gk:q' });
    expect(out).toMatch(/Include Target\) — inc \(governedKind: INCLUDE\)/);
  });

  it('hadron_find_nodes (brief) prints the kind on its Edges line', async () => {
    const out = await mcp.callToolText('hadron_find_nodes', { query: 'parent', memoryUrn: 'c2124.test:gk', brief: true });
    expect(out).toContain('(governedKind: INCLUDE)');
    expect(out).toContain('(governedKind: null)');
  });

  it('an unknown stored kind is an error result, never a formatted ordinary edge', async () => {
    // The PostgreSQL enum refuses an unknown value, so reach the formatter's boundary directly.
    const { governedKindAnnotation } = await import('../lib/edgeGovernedKind.js');
    expect(() => governedKindAnnotation('FUTURE_KIND')).toThrow('UNSUPPORTED_EDGE_GOVERNED_KIND');
    expect(() => governedKindAnnotation(undefined)).toThrow('UNSUPPORTED_EDGE_GOVERNED_KIND');
  });
});
