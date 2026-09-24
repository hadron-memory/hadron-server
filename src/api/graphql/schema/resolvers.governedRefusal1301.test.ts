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
import { createTestableMcpServer, GOVERNED_MCP_DOOR_FIELDS, mcpDoorCanReplay } from '../../../mcp/server.js';
import { GOVERNED_KINDS, RoleGovernedError } from '../../../lib/governedRole.js';

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
    // A GraphQL refusal names no MCP tool: the MCP doors carry fewer fields
    // than this input, so they could not replay it (@codex, #1305 round 7).
    expect(r.message).not.toContain('MCP');
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
    expect(r.message).not.toContain('MCP');
  });
});

describe('a data MERGE on a TASK, over GraphQL', () => {
  it('names the GraphQL/CLI replace route and no MCP tool', async () => {
    // The GraphQL door exempts the kind but does not SET the flag: pass it.
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:t', name: 't', content: 'Do it.', isRunnable: true } }, ctx());
    const r = await refusal(M.updateNodeData({}, { nodeRef: t.id, data: { a: 1 } }, ctx()));

    expect(r.ext).toMatchObject({ kind: 'task', door: 'updateTaskNode', mcpDoor: null, merge: 'data' });
    expect(r.message).toContain('updateTaskNode REPLACES data');
    expect(r.message).not.toContain('MCP');
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

describe('a node governed as MORE THAN ONE kind (@copilot + @codex, PR #1305)', () => {
  it('names no single door, because every door fails on the other kind — and they really do', async () => {
    // A runnable review. No door can create one (each owns one kind), so it is
    // seeded directly: it is the state the refusal has to describe honestly.
    const n = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'checks:rr', name: 'rr', role: 'review', isRunnable: true, content: 'x' },
    });

    const r = await refusal(M.updateNode({}, { input: { id: n.id, content: 'y' } }, ctx()));
    expect(r.ext).toMatchObject({ code: 'ROLE_GOVERNED', kinds: ['task', 'review'] });
    expect(r.message).toContain('governed as more than one kind (task and review)');
    expect(r.message).toContain('no current route can write it');
    expect(r.message).not.toMatch(/hadron_update_task|hadron_update_review|routes to it by itself/);
    // …and neither do the extensions, for a client routing from them.
    expect(r.ext.mcpDoor).toBeNull();

    // TRUTHFUL: each door the message declines to recommend does fail.
    expect((await refusal(M.updateTaskNode({}, { input: { id: n.id, content: 'y' } }, ctx()))).code).toBe('ROLE_GOVERNED');
    expect((await refusal(M.updateReviewNode({}, { input: { id: n.id, content: 'y' } }, ctx()))).code).toBe('ROLE_GOVERNED');
  });
});

describe('a refusal offers only routes that perform the refused operation (@codex, PR #1305)', () => {
  it('a revision RESTORE says no door restores, and offers no node-update route', async () => {
    const n = await spec();
    await M.updateSpecNode({}, { input: { id: n.id, content: 'second' } }, ctx());
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id }, orderBy: { createdAt: 'asc' } });

    const r = await refusal(M.restoreNodeRevision({}, { revisionId: rev.id }, ctx()));
    expect(r.code).toBe('ROLE_GOVERNED');
    expect(r.message).toContain('no door restores a revision');
    expect(r.message).not.toMatch(/routes to it by itself|Over MCP|may update/);
    expect(r.ext.mcpDoor).toBeNull();
  });

  it('a BULK refusal and an unlabelled caller offer no route at all', () => {
    const spec = GOVERNED_KINDS.find((k) => k.kind === 'spec')!;
    for (const context of ['bulk', undefined] as const) {
      const e = new RoleGovernedError(spec, 'update', 'edits', { context });
      // Names no door as a remedy (@copilot, #1305 round 7); extensions.door
      // still identifies the kind's door for tooling.
      expect(e.message).toBe('This write edits a node with role "spec". The generic node surface does not reach it. There is no route to suggest for this operation.');
      expect(e.extensions.door).toBe('updateSpecNode');
    }
  });
});

describe('a CREATE that would un-govern the node it resurrects (@codex, PR #1305)', () => {
  it('offers no MCP or CLI create route: both would force the signal back on', async () => {
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:gone', name: 'g', content: 'x', isRunnable: true } }, ctx());
    await db.node.update({ where: { id: t.id }, data: { deletedAt: new Date() } });

    const r = await refusal(M.createNode({}, { input: { memoryId, loc: 'tasks:gone', name: 'g', isRunnable: false } }, ctx()));

    expect(r.ext).toMatchObject({ code: 'ROLE_GOVERNED', kind: 'task', op: 'create', refusal: 'removes', mcpDoor: null });
    expect(r.message).not.toMatch(/hadron_create_task|routes to it by itself/);
  });
});

describe('callers whose refused operation no node-write route performs (@codex, PR #1305)', () => {
  it('a CLONE of a governed node offers no route: node create does not perform a clone', async () => {
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:src', name: 's', content: 'x', isRunnable: true } }, ctx());
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });

    const r = await refusal(M.cloneNode({}, { sourceRef: t.id, targetUrn: `hrn:node:${mem.urn.replace(/^hrn:mem:/, '')}:tasks:copy` }, ctx()));

    expect(r.code).toBe('ROLE_GOVERNED');
    expect(r.ext.mcpDoor).toBeNull();
    expect(r.message).not.toMatch(/routes to it by itself|Over MCP/);
  });

  it('MCP hadron_create_node on a LIVE governed loc offers no create door: it would hit NODE_LOC_CONFLICT', async () => {
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:live', name: 'l', content: 'x', isRunnable: true } }, ctx());
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const urn = `hrn:node:${mem.urn.replace(/^hrn:mem:/, '')}:tasks:live`;
    // Platform ADMIN, as the #1201 MCP tests drive it: the MCP write gate is
    // not what this case is about, only the refusal's route guidance.
    const text = await createTestableMcpServer({ userId: uid, roles: ['ADMIN'], clientId: `user:${uid}` } as never).callToolText(
      'hadron_create_node',
      { urn, name: 'again', content: 'y' },
    );
    expect(text).toMatch(/role_governed/);
    expect(text).not.toContain('hadron_create_task');
    // CONTROL: the loc really is live, so a create door would be refused too.
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).deletedAt).toBeNull();
  });
});

describe('MCP advertises a door only when it could replay the refused call (@codex, PR #1305)', () => {
  const adminMcp = () => createTestableMcpServer({ userId: uid, roles: ['ADMIN'], clientId: `user:${uid}` } as never);
  const taskUrn = async (loc: string) => {
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    return `hrn:node:${mem.urn.replace(/^hrn:mem:/, '')}:${loc}`;
  };

  it('every field the check calls replayable is a parameter of every door tool', () => {
    const srv = adminMcp();
    for (const tool of ['hadron_create_task', 'hadron_update_task', 'hadron_create_review', 'hadron_update_review']) {
      for (const field of GOVERNED_MCP_DOOR_FIELDS) {
        expect(() => srv.toolParamDescription(tool, field), `${tool}.${field}`).not.toThrow();
      }
    }
    // CONTROL: a generic field the doors do NOT carry is detected as missing.
    expect(() => srv.toolParamDescription('hadron_update_task', 'objectType')).toThrow();
  });

  it('CONTROL: a replayable update of a live task names hadron_update_task', async () => {
    await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:ok', name: 'o', content: 'x', isRunnable: true } }, ctx());
    const text = await adminMcp().callToolText('hadron_update_node', { urn: await taskUrn('tasks:ok'), content: 'y' });
    expect(text).toContain('Over MCP, use hadron_update_task');
  });

  it('an update carrying a field the door lacks (objectType) names no door', async () => {
    await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:ot', name: 'o', content: 'x', isRunnable: true } }, ctx());
    const text = await adminMcp().callToolText('hadron_update_node', { urn: await taskUrn('tasks:ot'), objectType: 'thing' });
    expect(text).toMatch(/role_governed/);
    expect(text).not.toContain('hadron_update_task');
  });

  it('an update of a TOMBSTONED task names no door: the update doors answer NODE_NOT_FOUND too', async () => {
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:dead', name: 'd', content: 'x', isRunnable: true } }, ctx());
    await db.node.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
    const text = await adminMcp().callToolText('hadron_update_node', { urn: await taskUrn('tasks:dead'), content: 'y' });
    expect(text).not.toContain('hadron_update_task');
  });
});

describe('GraphQL-side cases from review round 4 (@copilot, PR #1305)', () => {
  it('updateObject on a governed node offers no node-surface route', async () => {
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:obj', name: 'o', content: 'x', isRunnable: true } }, ctx());
    const r = await refusal(M.updateObject({}, { ref: t.id, fields: { a: 1 } }, ctx()));
    expect(r.code).toBe('ROLE_GOVERNED');
    expect(r.ext.mcpDoor).toBeNull();
    expect(r.message).not.toMatch(/hadron node update|Over MCP|no door merges/);
  });

  it('updateNode on a TOMBSTONED governed node offers no route', async () => {
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:tomb', name: 't', content: 'x', isRunnable: true } }, ctx());
    await db.node.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
    const r = await refusal(M.updateNode({}, { input: { memoryId, loc: 'tasks:tomb', content: 'y' } }, ctx()));
    // Either the plain not-found or a refusal with no route: never a door
    // that would itself answer NODE_NOT_FOUND.
    expect(r.message).not.toMatch(/routes to it by itself|Over MCP/);
    expect(r.ext.mcpDoor ?? null).toBeNull();
  });
});

describe('kind signals are door-specific (@copilot + @codex, PR #1305 round 5)', () => {
  it('mcpDoorCanReplay: each door carries only its own signal, and a create door only the value it sets', () => {
    // update doors
    expect(mcpDoorCanReplay({ isRunnable: false }, 'task', 'update')).toBe(true);
    expect(mcpDoorCanReplay({ role: null }, 'task', 'update')).toBe(false);
    expect(mcpDoorCanReplay({ role: 'note' }, 'task', 'update')).toBe(false);
    expect(mcpDoorCanReplay({ role: null }, 'review', 'update')).toBe(true);
    expect(mcpDoorCanReplay({ isRunnable: false }, 'review', 'update')).toBe(false);
    // create doors SET their signal: only that value replays
    expect(mcpDoorCanReplay({ isRunnable: true }, 'task', 'create')).toBe(true);
    expect(mcpDoorCanReplay({ isRunnable: true, role: 'note' }, 'task', 'create')).toBe(false);
    expect(mcpDoorCanReplay({ role: 'review' }, 'review', 'create')).toBe(true);
    expect(mcpDoorCanReplay({ role: 'review', isRunnable: false }, 'review', 'create')).toBe(false);
  });

  it('MCP: editing a live task while setting a role names no door; the control (content only) still does', async () => {
    await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:sig', name: 's', content: 'x', isRunnable: true } }, ctx());
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const urn = `hrn:node:${mem.urn.replace(/^hrn:mem:/, '')}:tasks:sig`;
    const mcp = createTestableMcpServer({ userId: uid, roles: ['ADMIN'], clientId: `user:${uid}` } as never);

    const withRole = await mcp.callToolText('hadron_update_node', { urn, role: 'note' });
    expect(withRole).toMatch(/role_governed/);
    expect(withRole).not.toContain('hadron_update_task');

    const plain = await mcp.callToolText('hadron_update_node', { urn, content: 'y' });
    expect(plain).toContain('Over MCP, use hadron_update_task');
  });
});

describe('MCP create over a TOMBSTONE offers no door (@codex, PR #1305 round 6)', () => {
  it('resurrection clears omitted fields here but the doors preserve them, so no door replays it', async () => {
    const t = await M.createTaskNode({}, { input: { memoryId, loc: 'tasks:res', name: 'r', content: 'x', isRunnable: true } }, ctx());
    await db.node.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const text = await createTestableMcpServer({ userId: uid, roles: ['ADMIN'], clientId: `user:${uid}` } as never).callToolText(
      'hadron_create_node',
      { urn: `hrn:node:${mem.urn.replace(/^hrn:mem:/, '')}:tasks:res`, name: 'again', isRunnable: true },
    );
    expect(text).toMatch(/role_governed/);
    expect(text).not.toContain('hadron_create_task');
  });

  it('CONTROL: MCP create on a FREE loc still names hadron_create_task', async () => {
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const text = await createTestableMcpServer({ userId: uid, roles: ['ADMIN'], clientId: `user:${uid}` } as never).callToolText(
      'hadron_create_node',
      { urn: `hrn:node:${mem.urn.replace(/^hrn:mem:/, '')}:tasks:fresh`, name: 'n', content: 'x', isRunnable: true },
    );
    expect(text).toContain('Over MCP, use hadron_create_task');
  });
});

describe('an UPDATE of a loc with no row at all (@copilot, PR #1305)', () => {
  it('offers no route, whichever refusal comes first', async () => {
    const r = await refusal(M.updateNode({}, { input: { memoryId, loc: 'tasks:nowhere', role: 'spec', content: 'y' } }, ctx()));
    expect(r.message).not.toMatch(/routes to it by itself|Over MCP/);
    expect(r.ext.mcpDoor ?? null).toBeNull();
  });
});
