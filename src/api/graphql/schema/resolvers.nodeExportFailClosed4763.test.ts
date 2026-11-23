/**
 * #4763 (blind P3-1 / local review): the node-content read gate shared by node(ref:) and nodeExport fails
 * CLOSED on a filter shape without an in-list. `memoryAccessFilter` always returns `{ memoryId: { in: ids } }`
 * for every principal kind (pinned at its source in resolvers.nodeExportRef4139.test.ts), so this branch is
 * defence in depth and unreachable today — which is exactly why it is pinned by MOCKING the one producer:
 * if that invariant ever breaks (a caller gains an unrestricted shape), node(ref:) must answer null and
 * nodeExport must refuse NODE_NOT_FOUND, never widen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

// The non-list shapes a broken memoryAccessFilter could plausibly return: no memoryId key at all, and a
// memoryId object without an `in` list. Both must refuse, on both surfaces, for a ref that IS readable
// under the real filter (the control test proves it, so the refusals below cannot pass for another reason).
let brokenFilterShape: Record<string, unknown> | null = null;
vi.mock('./resolvers.helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolvers.helpers.js')>();
  return {
    ...actual,
    memoryAccessFilter: async (ctx: Context) => (brokenFilterShape ?? actual.memoryAccessFilter(ctx)),
  };
});

const Q = resolvers.Query as any;
const LOC = 'docs:entry';
const urn = (m: { urn: string }, loc = LOC) => `hrn:node:${m.urn}:${loc}`;
let f: Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const s = generateId().toLowerCase();
  const org = await db.organization.create({ data: { name: 'Fail-closed org', urn: `failclosed-${s}.example` } });
  const m = await db.memory.create({
    data: { name: 'pub', urn: `${org.urn}:pub`, class: 'knowledge', visibility: 'PUBLIC', organizationId: org.id },
  });
  const node = await db.node.create({ data: { memoryId: m.id, loc: LOC, name: 'n', content: 'secret pub', nodeType: 'record' } });
  const admin = await db.user.create({ data: { id: generateId(), githubId: 47631, githubUsername: 'admin4763' } });
  const adminCtx = { db, roles: ['ADMIN'], userId: admin.id } as Context;
  return { pub: { ...m, nodeId: node.id }, adminCtx };
}

async function rejection(p: Promise<unknown>) {
  try { await p; return null; } catch (err) {
    return { code: (err as { code?: string }).code ?? (err as { extensions?: { code?: string } }).extensions?.code ?? null };
  }
}

beforeEach(async () => { await cleanDb(db); f = await fixture(); });

describe('#4763 the shared read gate fails closed on a non-list filter shape', () => {
  it('control: with the real filter, both surfaces read the node', async () => {
    expect(await Q.node({}, { ref: urn(f.pub) }, f.adminCtx)).not.toBeNull();
    expect((await Q.nodeExport({}, { ref: urn(f.pub) }, f.adminCtx)).data).toContain('secret pub');
  });

  it.each([
    ['no memoryId key', {}],
    ['a memoryId object without an in-list', { memoryId: { notIn: [] } }],
  ] as const)('%s: node(ref:) answers null and nodeExport refuses NODE_NOT_FOUND, by PK and by URN', async (_name, shape) => {
    brokenFilterShape = shape;
    try {
      for (const ref of [urn(f.pub), f.pub.nodeId]) {
        expect(await Q.node({}, { ref }, f.adminCtx)).toBeNull();
        expect(await rejection(Q.nodeExport({}, { ref }, f.adminCtx))).toMatchObject({ code: 'NODE_NOT_FOUND' });
      }
    } finally {
      brokenFilterShape = null;
    }
  });
});
