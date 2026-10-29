/**
 * #1885 slice 2 — reading an Agent's effective system memory over MCP
 * (cor:dmo:050:14; addressing per team chat #10929). Same fixture and reader as
 * the GraphQL file: a participant of an App that installs only
 * `backend-engineer` reads its system memory and holds no access to
 * `engineer`'s, so every engineer node they see came through the child.
 *
 * Pinned: hadron_get_node, hadron_get_nodes (both forms), hadron_list_nodes and
 * hadron_find_nodes return the effective memory; inherited nodes keep their own
 * URN, say `Inherited from`, and show none of the base's edges or records; the
 * child's own node wins; a base's boot prompt and overridden nodes never come
 * through, by any address.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

// Every node id a signature status is loaded for, so a pin can say an
// inherited node loads none (#1891 x #1902), not only that none is printed.
const signatureLoads = vi.hoisted(() => [] as string[][]);
vi.mock('../lib/signing/status.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/signing/status.js')>();
  return {
    ...mod,
    loadSignatureStatuses: (d: Parameters<typeof mod.loadSignatureStatuses>[0], ids: string[]) => {
      signatureLoads.push([...ids]);
      return mod.loadSignatureStatuses(d, ids);
    },
  };
});

let n: number;
let org: { id: string; urn: string };
let reader: string;
let engineer: { id: string; urn: string; mem: string; memUrn: string };
let backend: { id: string; urn: string; mem: string; memUrn: string };

const auth = (): AuthContext => ({ userId: reader, roles: ['READER'], clientId: `user:${reader}` });
const call = (tool: string, params: Record<string, unknown>) => createTestableMcpServer(auth()).callToolText(tool, params);
const childUrn = (loc: string) => `hrn:node:${backend.memUrn}:${loc}`;
const baseUrn = (loc: string) => `hrn:node:${engineer.memUrn}:${loc}`;

async function agent(slug: string, base?: { id: string }) {
  const memUrn = `${org.urn}:${slug}-system`;
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${slug} system`, urn: memUrn } });
  const a = await db.agent.create({
    data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: base?.id ?? null },
  });
  return { id: a.id, urn: a.urn, mem: mem.id, memUrn };
}

async function node(memoryId: string, loc: string, name: string, data: { role?: string; isRunnable?: boolean } = {}) {
  return (await db.node.create({ data: { memoryId, loc, name, content: `${name} body`, role: data.role ?? null, isRunnable: data.isRunnable ?? null } })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Eff', urn: `effmcp-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `effmcp-reader-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  engineer = await agent('engineer');
  backend = await agent('backend-engineer', engineer);
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: backend.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader, role: 'member' } });

  const engOpenPr = await node(engineer.mem, 'tasks:open-pr', 'EngOpenPr', { isRunnable: true });
  const engRelease = await node(engineer.mem, 'processes:release', 'EngRelease', { role: 'process.release' });
  await node(engineer.mem, 'tasks:ship', 'EngShip', { isRunnable: true });
  await node(engineer.mem, 'prompts:boot', 'EngBoot', { role: 'boot-prompt' });
  await node(backend.mem, 'tasks:open-pr', 'BackOpenPr', { isRunnable: true });
  await node(backend.mem, 'notes:own', 'BackOwn');
  await db.edge.create({ data: { memoryId: engineer.mem, sourceId: engRelease, targetId: engOpenPr, name: 'stage', loc: 'processes:release:stage:tasks:open-pr' } });
});

describe('hadron_get_node through the child', () => {
  it('reads engineer\'s release process under its own URN, marked, its edge resolved to the child\'s override', async () => {
    const out = await call('hadron_get_node', { urn: childUrn('processes:release') });
    expect(out).toContain('EngRelease body');
    expect(out).toContain(baseUrn('processes:release'));
    expect(out).toContain(`Inherited from: hrn:agent:${engineer.urn}`);
    // The stage edge leads to engineer's overridden tasks:open-pr: never shown;
    // it resolves through the child to the child's own node (#1893).
    expect(out).toContain(`Related:\n  - ${childUrn('tasks:open-pr')}`);
    expect(out).not.toContain(baseUrn('tasks:open-pr'));
  });

  it('the child\'s own node wins; a base boot prompt and an overridden node are not reachable', async () => {
    const own = await call('hadron_get_node', { urn: childUrn('tasks:open-pr') });
    expect(own).toContain('BackOpenPr body');
    expect(own).not.toContain('Inherited from');
    expect(await call('hadron_get_node', { urn: childUrn('prompts:boot') })).toMatch(/not found/);
    // S7: by its own URN, the overridden node, and (until the A/B ruling) every base node.
    expect(await call('hadron_get_node', { urn: baseUrn('tasks:open-pr') })).toMatch(/not found/i);
    expect(await call('hadron_get_node', { urn: baseUrn('processes:release') })).toMatch(/not found/i);
  });
});

describe('hadron_get_nodes matches the single read', () => {
  it('an explicit set through the child returns the inherited node marked, the own node, and lists the rest unavailable', async () => {
    const out = await call('hadron_get_nodes', {
      refs: [childUrn('processes:release'), childUrn('tasks:open-pr'), childUrn('prompts:boot'), baseUrn('tasks:open-pr')],
    });
    expect(out).toContain('EngRelease body');
    expect(out).toContain(`Inherited from: hrn:agent:${engineer.urn}`);
    expect(out).toContain('BackOpenPr body');
    expect(out).not.toContain('EngOpenPr body');
    expect(out).not.toContain('EngBoot body');
    expect(out).toContain(childUrn('prompts:boot'));
  });

  it('a prefix read of the child\'s tasks is its effective tasks', async () => {
    const out = await call('hadron_get_nodes', { memoryUrn: `hrn:mem:${backend.memUrn}`, locPrefix: 'tasks:' });
    expect(out).toContain('BackOpenPr body');
    expect(out).toContain('EngShip body');
    expect(out).not.toContain('EngOpenPr body');
  });
});

describe('hadron_list_nodes and hadron_find_nodes over the child', () => {
  it('lists the effective tree, inherited rows under their own URN and marked', async () => {
    const out = await call('hadron_list_nodes', { memoryUrn: `hrn:mem:${backend.memUrn}`, depth: 3 });
    expect(out).toContain(`${baseUrn('processes:release')} — EngRelease [info] (inherited from hrn:agent:${engineer.urn})`);
    expect(out).toContain(`${baseUrn('tasks:ship')} — EngShip [info] (inherited`);
    expect(out).toContain(`${childUrn('tasks:open-pr')} — BackOpenPr`);
    expect(out).not.toContain('EngOpenPr');
    expect(out).not.toContain('EngBoot');
  });

  it('finds runnable tasks across the effective memory', async () => {
    const out = await call('hadron_find_nodes', { query: '*', memoryUrn: `hrn:mem:${backend.memUrn}`, isRunnable: true });
    expect(out).toContain('BackOpenPr');
    expect(out).toContain('EngShip');
    expect(out).toContain(`Inherited from: hrn:agent:${engineer.urn}`);
    expect(out).not.toContain('EngOpenPr');
  });
});

describe('ruling 6 — a write at an inherited loc through the child never writes the base', () => {
  it('creating the loc in the child makes the child\'s own node, which then overrides; the base is untouched', async () => {
    const before = await db.node.findFirstOrThrow({ where: { memoryId: engineer.mem, loc: 'processes:release' } });
    // A writer of the child's system memory (a platform admin here).
    const adminId = (await db.user.create({ data: { handle: `effmcp-admin-${n}`, roles: ['ADMIN'] } })).id;
    const admin = createTestableMcpServer({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
    // An update through the child names no node of the child's own: nothing to update, and never the base.
    expect(await admin.callToolText('hadron_update_node', { urn: childUrn('processes:release'), content: 'CHILD EDIT' })).toMatch(/not found/i);
    // Creating the loc in the child writes the child's own node.
    expect(await admin.callToolText('hadron_create_node', { urn: childUrn('processes:release'), name: 'BackRelease', content: 'BackRelease body' })).toMatch(/saved|created/i);
    const after = await db.node.findFirstOrThrow({ where: { id: before.id } });
    expect(after.content).toBe(before.content);
    expect(after.revSeq).toBe(before.revSeq);
    const out = await call('hadron_get_node', { urn: childUrn('processes:release') });
    expect(out).toContain('BackRelease body');
    expect(out).not.toContain('Inherited from');
  });
});

describe('P2-2 (Diego, #1891) — an inherited node\'s validation shows state only', () => {
  it('never names the base\'s validator or its record, even a validator the reader can read', async () => {
    const release = await db.node.findFirstOrThrow({ where: { memoryId: engineer.mem, loc: 'processes:release' } });
    // A validator the reader CAN read on its own: the child's own runnable task.
    const validator = await db.node.findFirstOrThrow({ where: { memoryId: backend.mem, loc: 'tasks:open-pr' } });
    await db.nodeContentValidationReport.create({
      data: { nodeId: release.id, memoryId: engineer.mem, nodeRevSeq: release.revSeq, validationTaskId: validator.id, validationTaskRevSeq: validator.revSeq, outcome: 'PASS' },
    });
    for (const out of [
      await call('hadron_get_node', { urn: childUrn('processes:release') }),
      await call('hadron_get_nodes', { refs: [childUrn('processes:release')] }),
      await call('hadron_get_nodes', { memoryUrn: `hrn:mem:${backend.memUrn}`, locPrefix: 'processes:' }),
    ]) {
      expect(out).toContain('EngRelease body');
      const line = out.split('\n').find((l) => l.startsWith('Validation:'))!;
      expect(line).toMatch(/^Validation: \w+$/);
      expect(out).not.toContain('validator');
    }
  });
});

describe('the Signatures line: inherited sanitization and the #1902 switch, combined', () => {
  const idAt = async (memoryId: string, loc: string) =>
    (await db.node.findFirstOrThrow({ where: { memoryId, loc }, select: { id: true } })).id;
  const loaded = () => signatureLoads.flat();
  const lines = (out: string) => out.split('\n').filter((l) => l.startsWith('Signatures:'));

  beforeEach(() => { signatureLoads.length = 0; });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('switch on: an inherited node shows no line and loads no status; the child\'s own node shows it', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    const inheritedId = await idAt(engineer.mem, 'processes:release');
    const ownId = await idAt(backend.mem, 'notes:own');

    const inherited = await call('hadron_get_node', { urn: childUrn('processes:release') });
    expect(inherited).toContain('Inherited from');
    expect(lines(inherited)).toEqual([]);

    const own = await call('hadron_get_node', { urn: childUrn('notes:own') });
    expect(lines(own)).toEqual(['Signatures: none']);

    expect(loaded()).toContain(ownId);
    expect(loaded()).not.toContain(inheritedId);
  });

  it('switch on, batch read: the same, in one hadron_get_nodes', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    const inheritedId = await idAt(engineer.mem, 'processes:release');
    const ownId = await idAt(backend.mem, 'notes:own');

    const out = await call('hadron_get_nodes', { refs: [childUrn('processes:release'), childUrn('notes:own')] });
    expect(out).toContain('EngRelease body');
    expect(out).toContain('BackOwn body');
    expect(lines(out)).toEqual(['Signatures: none']);
    expect(loaded()).toContain(ownId);
    expect(loaded()).not.toContain(inheritedId);
  });

  it('switch off: neither node shows a line, and nothing is loaded', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', '');
    const single = [
      await call('hadron_get_node', { urn: childUrn('processes:release') }),
      await call('hadron_get_node', { urn: childUrn('notes:own') }),
    ];
    const batch = await call('hadron_get_nodes', { refs: [childUrn('processes:release'), childUrn('notes:own')] });
    for (const out of [...single, batch]) expect(lines(out)).toEqual([]);
    expect(loaded()).toEqual([]);
  });
});

it('#2774 renders inherited edge endpoint metadata without loading their bodies', async () => {
  const release = await db.node.findFirstOrThrow({ where: { memoryId: engineer.mem, loc: 'processes:release' } });
  const ship = await db.node.findFirstOrThrow({ where: { memoryId: engineer.mem, loc: 'tasks:ship' } });
  const override = await db.node.findFirstOrThrow({ where: { memoryId: backend.mem, loc: 'tasks:open-pr' } });
  const endpointIds = new Set([ship.id, override.id]);
  await db.node.update({ where: { id: release.id }, data: { abstract: 'Inherited summary' } });
  await db.node.updateMany({ where: { id: { in: [...endpointIds] } }, data: { content: 'UNSELECTED'.repeat(16_384) } });
  await db.edge.create({ data: { memoryId: engineer.mem, sourceId: ship.id, targetId: release.id, name: 'before', loc: 'ship-before-release' } });
  const single = await call('hadron_get_node', { urn: childUrn('processes:release'), contentScope: 'abstract', raw: true });
  let bytes = 0;
  const edges = db.edge.findMany.bind(db.edge);
  const edgeSpy = vi.spyOn(db.edge, 'findMany').mockImplementation((async (args: any) => {
    const rows = await edges(args);
    for (const row of rows as any[]) for (const endpoint of [row.source, row.target]) bytes += Buffer.byteLength(endpoint?.content ?? '');
    return rows;
  }) as typeof db.edge.findMany);
  const unique = db.node.findUnique.bind(db.node);
  const nodeSpy = vi.spyOn(db.node, 'findUnique').mockImplementation((async (args: any) => {
    const row = await unique(args);
    if (row && endpointIds.has(row.id)) bytes += Buffer.byteLength(row.content ?? '');
    return row;
  }) as typeof db.node.findUnique);
  try {
    const batch = await call('hadron_get_nodes', { refs: [childUrn('processes:release')], contentScope: 'abstract', raw: true });
    expect(batch).toContain(single);
    expect(batch).toContain(childUrn('tasks:open-pr'));
    expect(batch).toContain(baseUrn('tasks:ship'));
    expect(batch).toContain('Source: abstract-stale');
    expect(bytes).toBe(0);
  } finally { edgeSpy.mockRestore(); nodeSpy.mockRestore(); }
});
