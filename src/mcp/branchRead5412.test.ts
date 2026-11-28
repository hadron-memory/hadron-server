/**
 * #5412 section 5 (gate rulings issuecomment-7238580841 and issuecomment-7238581276), MCP side: a memory a pure App key reads ONLY
 * through a `memory.read` grant with a `branch`. `hadron_get_node`, `hadron_get_nodes`, `hadron_list_nodes` and `hadron_find_nodes`
 * admit the nodes inside the branch; everything outside it answers exactly like a missing node; a node admitted this way carries
 * nothing from outside it (no Related / Referenced by, no records, stored text without includes); and `canReadMemory` (every
 * other MCP door) still refuses the memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { DB_NOW, raw, insertGrantUnguarded, type World } from '../lib/grants/grantFixtures3668.js';
import { createTestableMcpServer } from './server.js';
import { EXPLICIT_REF, canReadMemory } from './access-control.js';
import { mcpNodeBranchScopes } from './branchRead.js';
import { emitNodeUrnV2 } from '../lib/urnEmit.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let alice: string;
let app: { id: string; urn: string };
let keyId: string;

const keyAuth = (): AuthContext => ({ appId: app.id, appKeyId: keyId, roles: [], clientId: `app:${app.id}` } as AuthContext);
const call = (tool: string, args: Record<string, unknown>) => createTestableMcpServer(keyAuth()).callToolText(tool, args);

async function alicesMemory() {
  const own = await db.organization.create({ data: { id: generateId(), name: `alice-${generateId().slice(-8)}`, urn: `alice-${generateId().slice(-8)}` } });
  await db.orgMember.create({ data: { organizationId: own.id, userId: alice, role: 'OWNER' } });
  return db.memory.create({
    data: { id: generateId(), name: 'a', urn: `${own.urn}:kb`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: own.id } as never,
  });
}
async function activeGrant(values: Record<string, unknown>) {
  return insertGrantUnguarded({ appId: app.id, userId: alice } as World, {
    user_id: null, grantee_app_id: app.id, issuer_user_id: alice, action: 'memory.read', action_values: values,
    activated_at: raw(DB_NOW), verification_kind: 'PASSKEY', verified_by: alice,
  } as never);
}
const node = (memoryId: string, loc: string, content = 'zebrafish marker') =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: `n-${loc}`, content } as never });

async function branchWorld() {
  const m = await alicesMemory();
  const inside = { docs: await node(m.id, 'docs'), api: await node(m.id, 'docs:api'), v1: await node(m.id, 'docs:api:v1') };
  const outside = { docsx: await node(m.id, 'docsx'), other: await node(m.id, 'other'), secret: await node(m.id, 'other:secret', 'zebrafish SECRET') };
  await db.edge.create({ data: { id: generateId(), memoryId: m.id, sourceId: inside.api.id, targetId: outside.secret.id, name: 'relates_to', loc: 'e1' } as never });
  await db.edge.create({ data: { id: generateId(), memoryId: m.id, sourceId: outside.other.id, targetId: inside.api.id, name: 'relates_to', loc: 'e2' } as never });
  await activeGrant({ memory: m.id, branch: 'docs' });
  const memUrn = `hrn:mem:${m.urn}`;
  const urn = (loc: string) => emitNodeUrnV2(m.urn, loc);
  return { m, memUrn, urn, inside, outside };
}

/** Nothing from outside the branch: no outside locs, ids or text. */
function expectNoOutside(text: string, w: Awaited<ReturnType<typeof branchWorld>>) {
  for (const n of Object.values(w.outside)) {
    expect(text).not.toContain(n.id);
    expect(text).not.toContain(`n-${n.loc}`);
  }
  expect(text).not.toContain('SECRET');
  expect(text).not.toContain('Related:');
  expect(text).not.toContain('Referenced by:');
}

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  const org = (await createDbOrgAndGraph(db, { orgName: 'br5412m', graphName: 'base' })).org;
  alice = (await db.user.create({ data: { id: generateId(), handle: `alice-${generateId().slice(-6)}` } as never })).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } as never });
  keyId = (await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'k1' } })).id;
  await db.$executeRawUnsafe(`INSERT INTO app_key_scopes (id, app_key_id, scope, granted_by_user_id) VALUES ($1, $2, 'grant:read', $3)`, generateId(), keyId, alice);
});

describe('condition 1: every other MCP door still refuses a branch-only memory', () => {
  it('canReadMemory is false for it; the branch map carries it', async () => {
    const { m } = await branchWorld();
    expect(await canReadMemory(db, keyAuth(), m.id, EXPLICIT_REF)).toBe(false);
    expect((await mcpNodeBranchScopes(db, keyAuth())).get(m.id)).toEqual(['docs']);
  });
});

describe('hadron_get_node', () => {
  it('admits a node inside the branch, with no edges, records or include resolution', async () => {
    const w = await branchWorld();
    await db.node.update({ where: { id: w.inside.api.id }, data: { content: 'see {{include other:secret}}' } });
    const out = await call('hadron_get_node', { urn: w.urn('docs:api') });
    expect(out).toContain(`ID: ${w.inside.api.id}`);
    expect(out).toContain('see {{include other:secret}}');
    expect(out).not.toMatch(/^(Validation|Approval|Minted|Signatures|Feedback|Created by|Last edited by|Authored by):/m);
    expectNoOutside(out.replace('{{include other:secret}}', ''), w);
  });

  it('outside the branch and across the `:` boundary answers exactly like a missing node', async () => {
    const w = await branchWorld();
    const missing = await call('hadron_get_node', { urn: w.urn('docs:nope') });
    expect(missing).toContain('Node not found.');
    for (const loc of ['docsx', 'other', 'other:secret']) expect(await call('hadron_get_node', { urn: w.urn(loc) })).toBe(missing);
  });

  it('a whole grant beside the branch wins: the full projection, edges included', async () => {
    const w = await branchWorld();
    await activeGrant({ memory: w.m.id });
    const out = await call('hadron_get_node', { urn: w.urn('other:secret') });
    expect(out).toContain('SECRET');
    expect(await call('hadron_get_node', { urn: w.urn('docs:api') })).toContain('Related:');
  });
});

describe('hadron_get_nodes', () => {
  it('refs: inside renders, outside is Unavailable like a missing ref, by URN and by PK', async () => {
    const w = await branchWorld();
    const ghost = generateId();
    const out = await call('hadron_get_nodes', { refs: [w.urn('docs'), w.inside.v1.id, w.urn('other:secret'), w.outside.docsx.id, ghost] });
    expect(out).toContain('returned 2 node(s); 3 unavailable');
    expect(out).toContain(`ID: ${w.inside.docs.id}`);
    expect(out).toContain(`ID: ${w.inside.v1.id}`);
    const unavailable = out.slice(out.indexOf('Unavailable'));
    expect(unavailable).toContain(w.urn('other:secret'));
    expect(unavailable).toContain(w.outside.docsx.id);
    expect(unavailable).toContain(ghost);
    expectNoOutside(out.slice(0, out.indexOf('Unavailable')), w);
  });

  it('prefix: the prefix intersected with the branch, in the statement', async () => {
    const w = await branchWorld();
    const all = await call('hadron_get_nodes', { memoryUrn: w.memUrn, locPrefix: '' });
    expect(all).toContain('returned 3 node(s).');
    expectNoOutside(all, w);
    expect(await call('hadron_get_nodes', { memoryUrn: w.memUrn, locPrefix: 'other' })).toContain('returned 0 node(s).');
  });
});

describe('hadron_list_nodes', () => {
  it('lists the branch alone, and no ancestor above it', async () => {
    const w = await branchWorld();
    const out = await call('hadron_list_nodes', { memoryUrn: w.memUrn, depth: 5 });
    expect(out).toContain('docs:api:v1');
    expect(out).not.toContain('docsx');
    expect(out).not.toContain('other');
    expect(out).not.toContain('missing');
  });

  it('parentRel inside the branch lists under it; outside answers like a missing parent', async () => {
    const w = await branchWorld();
    expect(await call('hadron_list_nodes', { memoryUrn: w.memUrn, parentRel: 'docs:api' })).toContain('docs:api:v1');
    const outside = await call('hadron_list_nodes', { memoryUrn: w.memUrn, parentRel: 'other' });
    const missing = await call('hadron_list_nodes', { memoryUrn: w.memUrn, parentRel: 'nope' });
    expect(outside).toBe(missing.replace('nope', 'other'));
  });
});

describe('hadron_find_nodes', () => {
  it('memoryUrn, memoryUrns and allMemories: only branch hits, with no edges to outside', async () => {
    const w = await branchWorld();
    for (const args of [{ memoryUrn: w.memUrn }, { memoryUrns: [w.memUrn] }, { allMemories: true }]) {
      const out = await call('hadron_find_nodes', { query: 'zebrafish', mode: 'keyword', brief: true, ...args });
      expect(out).toContain(w.inside.api.id);
      expectNoOutside(out, w);
      expect(out).not.toContain('Edges:');
    }
  });

  it('expand (graph neighbours) adds nothing from outside the branch', async () => {
    const w = await branchWorld();
    for (const expand of [1, 2, 3]) {
      const out = await call('hadron_find_nodes', { query: 'marker', mode: 'keyword', memoryUrn: w.memUrn, expand });
      expect(out).toContain(w.inside.api.id);
      expectNoOutside(out, w);
    }
    await activeGrant({ memory: w.m.id });
    expect(await call('hadron_find_nodes', { query: 'marker', mode: 'keyword', memoryUrn: w.memUrn, expand: 1 })).toContain(w.outside.secret.id);
  });

  it('a keyword only outside the branch finds nothing', async () => {
    const w = await branchWorld();
    expect(await call('hadron_find_nodes', { query: 'SECRET', mode: 'keyword', memoryUrn: w.memUrn })).not.toContain(w.outside.secret.id);
  });
});
