/** #937 — MCP single-node update doors expose Node.revision as an atomic guard. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer, mcpDoorCanReplay } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let memory: { id: string; urn: string };
const auth = (): AuthContext => ({
  userId: admin.id,
  roles: ['ADMIN'],
  clientId: `user:${admin.id}`,
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-occ-org', urn: 'mcp-occ-org' },
  });
  admin = await db.user.create({
    data: { githubId: 93711, githubUsername: 'mcp-occ-admin', handle: 'mcp-occ-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:nodes`,
      name: 'nodes',
      class: 'knowledge',
    },
  });
});

const seed = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc,
      name: loc,
      content: 'version one',
      abstract: 'summary one',
      ...extra,
    },
  });

const urnFor = (loc: string) => `hrn:node:${memory.urn}:${loc}`;

describe('MCP expectedRevision (#937)', () => {
  it('refuses stale ordinary content replacement and leaves the winner intact', async () => {
    const node = await seed('occ:content');
    const clientA = createTestableMcpServer(auth());
    const clientB = createTestableMcpServer(auth());
    expect(await clientA.callToolText('hadron_get_node', { urn: urnFor(node.loc) })).toContain('Revision: 1');
    expect(await clientB.callToolText('hadron_get_node', { urn: urnFor(node.loc) })).toContain('Revision: 1');

    expect(await clientB.callToolText('hadron_update_node', {
      urn: urnFor(node.loc),
      expectedRevision: 1,
      content: 'writer B',
    })).toContain('Node updated:');
    expect(await clientA.callToolText('hadron_update_node', {
      urn: urnFor(node.loc),
      expectedRevision: 1,
      content: 'stale writer A',
    })).toMatch(/^\[node_write_conflict\]/);

    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      content: 'writer B',
      revSeq: 2,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });

  it.each([
    ['hadron_update_task', { isRunnable: true }],
    ['hadron_update_review', { role: 'review' }],
  ] as const)('%s enforces the same baseline for abstract replacement', async (tool, kind) => {
    const node = await seed(`occ:${tool}`, kind);
    const mcp = createTestableMcpServer(auth());
    expect(await mcp.callToolText(tool, {
      urn: urnFor(node.loc),
      expectedRevision: 1,
      abstract: 'writer B summary',
    })).toContain('updated:');
    const conflict = await mcp.callToolText(tool, {
      urn: urnFor(node.loc),
      expectedRevision: 1,
      abstract: 'stale writer A summary',
    });
    expect(conflict).toMatch(/^\[node_write_conflict\]/);
    expect(conflict).not.toMatch(/currentRevision|revision\s+2/i);

    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      abstract: 'writer B summary',
      revSeq: 2,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });

  it('refuses a pre-drift baseline and rolls reconciliation back', async () => {
    const node = await seed('occ:drift');
    await db.node.update({ where: { id: node.id }, data: { content: 'raw drift' } });
    const text = await createTestableMcpServer(auth()).callToolText('hadron_update_node', {
      urn: urnFor(node.loc),
      expectedRevision: 1,
      content: 'must not overwrite drift',
    });
    expect(text).toMatch(/^\[node_write_conflict\]/);
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      content: 'raw drift',
      revSeq: 1,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });

  it('refuses a stale no-op and keeps omission backward-compatible', async () => {
    const guarded = await seed('occ:no-op');
    const mcp = createTestableMcpServer(auth());
    await mcp.callToolText('hadron_update_node', {
      urn: urnFor(guarded.loc),
      expectedRevision: 1,
      content: 'version two',
    });
    expect(await mcp.callToolText('hadron_update_node', {
      urn: urnFor(guarded.loc),
      expectedRevision: 1,
      content: 'version two',
    })).toMatch(/^\[node_write_conflict\]/);
    expect(await db.nodeRevision.count({ where: { nodeId: guarded.id } })).toBe(1);

    const unguarded = await seed('occ:omitted');
    expect(await mcp.callToolText('hadron_update_node', {
      urn: urnFor(unguarded.loc),
      content: 'unguarded edit',
    })).toContain('Node updated:');
    expect(await db.node.findUniqueOrThrow({ where: { id: unguarded.id } })).toMatchObject({
      content: 'unguarded edit',
      revSeq: 2,
    });
  });

  // Added in review (@Andi, PR #1352). The guard-ONLY call — a precondition
  // with no field changes — is a documented use ("a useful no-op check"), and
  // three separate guards make it work: the entry condition must admit it into
  // the transaction at all, the comparison must run, and the early return must
  // stop it manufacturing history. Each could be removed with the suite staying
  // green before these cases.
  describe('a guard-only call (precondition, no field changes)', () => {
    it('refuses a stale precondition instead of silently succeeding', async () => {
      const node = await seed('occ:guard-only-stale');
      const mcp = createTestableMcpServer(auth());
      // Advance the node so revision 1 is stale.
      await mcp.callToolText('hadron_update_node', { urn: urnFor(node.loc), content: 'version two' });
      const before = await db.node.findUniqueOrThrow({ where: { id: node.id } });

      expect(
        await mcp.callToolText('hadron_update_node', { urn: urnFor(node.loc), expectedRevision: 1 }),
      ).toMatch(/^\[node_write_conflict\]/);
      // And nothing moved: not the revision, not the history, not the content.
      const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(after.revSeq).toBe(before.revSeq);
      expect(after.content).toBe(before.content);
      expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
    });

    it('passes a current precondition without manufacturing a revision', async () => {
      const node = await seed('occ:guard-only-current');
      const mcp = createTestableMcpServer(auth());
      const before = await db.node.findUniqueOrThrow({ where: { id: node.id } });

      const result = await mcp.callToolText('hadron_update_node', {
        urn: urnFor(node.loc),
        expectedRevision: before.revSeq,
      });
      expect(result).not.toMatch(/^\[node_write_conflict\]/);
      const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(after.revSeq, 'a guard-only check must not advance the live revision').toBe(before.revSeq);
      expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
    });
  });

  // Added in review (@Andi, PR #1352): a precondition is an UPDATE concept, so
  // a generic write carrying one must not replay through a governed CREATE
  // door. Nothing pinned the `op !== 'update'` half of that rule.
  it('never replays a precondition through a governed create door', () => {
    expect(mcpDoorCanReplay({ expectedRevision: 3 }, 'task', 'update')).toBe(true);
    expect(mcpDoorCanReplay({ expectedRevision: 3 }, 'review', 'update')).toBe(true);
    // `name` is supplied on the create cases on purpose: without it the
    // trailing create-needs-a-name rule returns false anyway, and the test
    // would pass no matter what the precondition rule did.
    expect(mcpDoorCanReplay({ expectedRevision: 3, name: 'n' }, 'task', 'create')).toBe(false);
    expect(mcpDoorCanReplay({ expectedRevision: 3, name: 'n' }, 'review', 'create')).toBe(false);
    // Control: the same create WITHOUT a precondition is replayable, so the
    // refusal above is attributable to the precondition and nothing else.
    expect(mcpDoorCanReplay({ name: 'n', isRunnable: true }, 'task', 'create')).toBe(true);
  });

  it.each(['hadron_update_node', 'hadron_update_task', 'hadron_update_review'])(
    '%s publishes a positive 32-bit revision schema',
    (tool) => {
      const schema = createTestableMcpServer(auth()).toolParamSchema(tool, 'expectedRevision');
      expect(schema.parse(1)).toBe(1);
      for (const bad of [0, -1, 1.5, 2_147_483_648]) {
        expect(() => schema.parse(bad)).toThrow();
      }
    },
  );
});
