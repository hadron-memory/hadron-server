import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateId } from '../../lib/id.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import {
  rewriteMemoryUrnRefs,
  memoryUrnForms,
} from '../../controller/operations/cloneMemory.js';

// ---------------------------------------------------------------------------
// Unit: URN-reference rewriting
// ---------------------------------------------------------------------------

describe('memoryUrnForms', () => {
  it('derives the canonical form from the stored legacy form', () => {
    expect(memoryUrnForms('acme.com:dev')).toEqual({
      legacy: 'acme.com:dev',
      canonical: 'acme.com::dev',
    });
  });

  it('doubles only the org→memory separator (slug keeps inner colons)', () => {
    expect(memoryUrnForms('acme.com:a:b').canonical).toBe('acme.com::a:b');
  });
});

describe('rewriteMemoryUrnRefs', () => {
  const OLD = 'acme.com:dev';
  const NEW = 'acme.com:dev-clone';

  it('rewrites prefixed, bare-canonical, and legacy node references', () => {
    const text = [
      'See urn:node:acme.com::dev::topics:setup for details.',
      'Bare: acme.com::dev::topics:setup',
      'Legacy: acme.com:dev:topics:setup',
      'Memory ref: urn:memory:acme.com::dev',
    ].join('\n');
    expect(rewriteMemoryUrnRefs(text, OLD, NEW)).toBe(
      [
        'See urn:node:acme.com::dev-clone::topics:setup for details.',
        'Bare: acme.com::dev-clone::topics:setup',
        'Legacy: acme.com:dev-clone:topics:setup',
        'Memory ref: urn:memory:acme.com::dev-clone',
      ].join('\n'),
    );
  });

  it('leaves other memories and slug-extension look-alikes alone', () => {
    const text = [
      'acme.com::other::x',
      'acme.com::dev-tools::y', // slug extends "dev" with a slug char
      'acme.com::dev.x::y', // slug extends "dev" with a dot atom (PR-265 review)
      'foo.acme.com::dev::z', // different org ending in the source org
    ].join('\n');
    expect(rewriteMemoryUrnRefs(text, OLD, NEW)).toBe(text);
  });

  it('rewrites a reference followed by sentence punctuation', () => {
    expect(rewriteMemoryUrnRefs('see acme.com::dev.', OLD, NEW)).toBe(
      'see acme.com::dev-clone.',
    );
    expect(rewriteMemoryUrnRefs('(acme.com::dev)', OLD, NEW)).toBe(
      '(acme.com::dev-clone)',
    );
  });

  it('passes null/empty through', () => {
    expect(rewriteMemoryUrnRefs(null, OLD, NEW)).toBeNull();
    expect(rewriteMemoryUrnRefs('', OLD, NEW)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Integration: cloneMemory resolver
// ---------------------------------------------------------------------------

let org: { id: string; urn: string };
let adminUser: { id: string };

function adminCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: adminUser.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'org-a', urn: 'org-a' },
  });
  adminUser = await db.user.create({
    data: { githubId: 9001, githubUsername: 'admin-user', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: adminUser.id, role: 'ADMIN' },
  });
});

async function createSourceMemory(overrides: Record<string, unknown> = {}) {
  return db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: 'org-a:src-mem',
      name: 'src-mem',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
      description: 'source memory',
      tags: ['alpha', 'beta'],
      source: 'https://github.com/org-a/src-mem.git',
      readBranch: 'main',
      writeBranch: 'hadron-updates',
      ...overrides,
    },
  });
}

describe('cloneMemory', () => {
  it('clones nodes/edges, rewrites URN references, and resets git config', async () => {
    const source = await createSourceMemory({ vectorIndexEnabled: true });

    const REF_CONTENT = [
      'Canonical: urn:node:org-a::src-mem::topics:setup',
      'Bare: org-a::src-mem::topics:setup',
      'Legacy: org-a:src-mem:topics:setup',
      'Other memory: org-a::other-mem::x stays.',
    ].join('\n');

    const guide = await db.node.create({
      data: {
        id: generateId(),
        memoryId: source.id,
        loc: 'guide',
        name: 'Guide',
        content: REF_CONTENT,
        abstract: 'Points at org-a::src-mem::topics:setup.',
        abstractOriginHash: computeContentHash(REF_CONTENT), // fresh abstract
        contentHash: 'aaaa1111',
        tags: ['t1'],
        properties: { kind: 'guide' },
        seq: 3,
      },
    });
    const setup = await db.node.create({
      data: {
        id: generateId(),
        memoryId: source.id,
        loc: 'topics:setup',
        name: 'Setup',
        content: 'No references here.',
        contentHash: 'bbbb2222',
        abstract: 'stale abstract',
        abstractOriginHash: 'deadbeef', // does NOT match content → stale
      },
    });
    const deleted = await db.node.create({
      data: {
        id: generateId(),
        memoryId: source.id,
        loc: 'gone',
        name: 'Gone',
        deletedAt: new Date(),
      },
    });
    // External node in another memory of the same org.
    const otherMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'org-a:other-mem',
        name: 'other-mem',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    const external = await db.node.create({
      data: { id: generateId(), memoryId: otherMem.id, loc: 'x', name: 'X' },
    });

    // Spec 037: edges carry `memoryId` (denormalized from the source node) and a
    // memory-unique `loc` derived from the endpoint locs + name. All three
    // sources live in `source`, so memoryId is source.id (the cross-memory
    // see-also edge is keyed to the SOURCE's memory).
    await db.edge.create({
      data: {
        memoryId: source.id,
        sourceId: guide.id,
        targetId: setup.id,
        loc: deriveEdgeLoc(guide.loc, 'routes-to', setup.loc),
        name: 'routes-to',
        priority: 2,
      },
    });
    await db.edge.create({
      data: {
        memoryId: source.id,
        sourceId: guide.id,
        targetId: external.id,
        loc: deriveEdgeLoc(guide.loc, 'see-also', external.loc),
        name: 'see-also',
      },
    });
    await db.edge.create({
      data: {
        memoryId: source.id,
        sourceId: setup.id,
        targetId: deleted.id,
        loc: deriveEdgeLoc(setup.loc, 'dangling', deleted.loc),
        name: 'dangling',
      },
    });
    await db.pendingEdge.create({
      data: { sourceId: guide.id, targetId: 'org-a::src-mem::missing:loc', name: 'pends' },
    });

    const clone = await resolvers.Mutation.cloneMemory(
      {},
      { id: 'urn:memory:org-a::src-mem', name: 'clone-mem' },
      adminCtx(),
    );

    // Memory row.
    expect(clone.id).not.toBe(source.id);
    expect(clone.urn).toBe('org-a:clone-mem');
    expect(clone.name).toBe('clone-mem');
    expect(clone.class).toBe('knowledge');
    expect(clone.description).toBe('source memory');
    expect(clone.tags).toEqual(['alpha', 'beta']);
    expect(clone.vectorIndexEnabled).toBe(true);
    // Git-sync config does not carry over.
    expect(clone.source).toBeNull();
    expect(clone.readBranch).toBeNull();
    expect(clone.writeBranch).toBeNull();
    expect(clone.pendingEdgeCount).toBe(1);

    // Nodes: live ones copied with NEW ids, same locs; deleted one skipped.
    const cloneNodes = await db.node.findMany({ where: { memoryId: clone.id } });
    expect(cloneNodes.map((n) => n.loc).sort()).toEqual(['guide', 'topics:setup']);
    const cloneGuide = cloneNodes.find((n) => n.loc === 'guide')!;
    const cloneSetup = cloneNodes.find((n) => n.loc === 'topics:setup')!;
    expect(cloneGuide.id).not.toBe(guide.id);

    // Content rewritten in all three spellings; foreign memory untouched.
    expect(cloneGuide.content).toBe(
      [
        'Canonical: urn:node:org-a::clone-mem::topics:setup',
        'Bare: org-a::clone-mem::topics:setup',
        'Legacy: org-a:clone-mem:topics:setup',
        'Other memory: org-a::other-mem::x stays.',
      ].join('\n'),
    );
    expect(cloneGuide.abstract).toBe('Points at org-a::clone-mem::topics:setup.');
    // Fresh abstract stays fresh against the rewritten content...
    expect(cloneGuide.abstractOriginHash).toBe(computeContentHash(cloneGuide.content));
    // ...and the external-producer contentHash is dropped (content changed).
    expect(cloneGuide.contentHash).toBeNull();
    // Untouched node keeps its hash; stale abstract stays stale.
    expect(cloneSetup.content).toBe('No references here.');
    expect(cloneSetup.contentHash).toBe('bbbb2222');
    expect(cloneSetup.abstractOriginHash).toBe('deadbeef');
    // Misc fields carry over.
    expect(cloneGuide.tags).toEqual(['t1']);
    expect(cloneGuide.properties).toEqual({ kind: 'guide' });
    expect(cloneGuide.seq).toBe(3);
    // 033: vector-indexed clone is stamped for re-embedding.
    expect(cloneGuide.embeddingPendingAt).not.toBeNull();

    // Edges: internal remapped, cross-memory target preserved,
    // deleted-target edge skipped.
    const cloneEdges = await db.edge.findMany({
      where: { sourceId: { in: cloneNodes.map((n) => n.id) } },
    });
    expect(cloneEdges).toHaveLength(2);
    const routes = cloneEdges.find((e) => e.name === 'routes-to')!;
    expect(routes.sourceId).toBe(cloneGuide.id);
    expect(routes.targetId).toBe(cloneSetup.id);
    expect(routes.priority).toBe(2);
    const seeAlso = cloneEdges.find((e) => e.name === 'see-also')!;
    expect(seeAlso.targetId).toBe(external.id);

    // PendingEdge: source remapped, target string rewritten.
    const clonePending = await db.pendingEdge.findMany({
      where: { sourceId: cloneGuide.id },
    });
    expect(clonePending).toHaveLength(1);
    expect(clonePending[0].targetId).toBe('org-a::clone-mem::missing:loc');

    // Provenance log entry on the clone.
    const log = await db.memoryLogEntry.findMany({ where: { memoryId: clone.id } });
    expect(log).toHaveLength(1);
    expect(log[0].message).toContain('org-a:src-mem');

    // No version history is fabricated for clone nodes.
    const versions = await db.nodeVersion.findMany({
      where: { nodeId: { in: cloneNodes.map((n) => n.id) } },
    });
    expect(versions).toHaveLength(0);

    // Source memory is untouched.
    const srcGuide = await db.node.findUniqueOrThrow({ where: { id: guide.id } });
    expect(srcGuide.content).toBe(REF_CONTENT);
  });

  it('requires org ADMIN for a knowledge-class source', async () => {
    await createSourceMemory();
    const member = await db.user.create({
      data: { githubId: 9002, githubUsername: 'plain-member' },
    });
    await db.orgMember.create({
      data: { organizationId: org.id, userId: member.id, role: 'READER' },
    });
    await expect(
      resolvers.Mutation.cloneMemory(
        {},
        { id: 'org-a::src-mem', name: 'clone-mem' },
        { db, roles: [], userId: member.id } as Context,
      ),
    ).rejects.toThrow();
  });

  it('personal-class source: owner-only, clone owned by the caller', async () => {
    const owner = await db.user.create({
      data: { githubId: 9003, githubUsername: 'owner-user' },
    });
    await db.orgMember.create({
      data: { organizationId: org.id, userId: owner.id, role: 'READER' },
    });
    const personal = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'org-a:my-notes',
        name: 'my-notes',
        class: 'personal',
        userId: owner.id,
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: personal.id, loc: 'n1', name: 'N1' },
    });

    // A platform admin who is not the owner is rejected (matches deleteMemory).
    await expect(
      resolvers.Mutation.cloneMemory({}, { id: personal.id, name: 'notes-2' }, adminCtx()),
    ).rejects.toThrow(/only the owner/);

    const clone = await resolvers.Mutation.cloneMemory(
      {},
      { id: personal.id, name: 'notes-2' },
      { db, roles: [], userId: owner.id } as Context,
    );
    expect(clone.class).toBe('personal');
    expect(clone.userId).toBe(owner.id);
    expect(clone.visibility).toBeNull();
    const nodes = await db.node.findMany({ where: { memoryId: clone.id } });
    expect(nodes).toHaveLength(1);
  });

  it('group-class clone bootstraps the caller as first owner', async () => {
    await createSourceMemory({
      urn: 'org-a:team-mem',
      name: 'team-mem',
      class: 'group',
      visibility: 'GROUP',
    });
    const clone = await resolvers.Mutation.cloneMemory(
      {},
      { id: 'org-a::team-mem', name: 'team-mem-2' },
      adminCtx(),
    );
    expect(clone.class).toBe('group');
    expect(clone.visibility).toBe('GROUP');
    const members = await db.memoryMember.findMany({ where: { memoryId: clone.id } });
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(adminUser.id);
    expect(members[0].role).toBe('owner');
  });

  it('rejects system-class sources', async () => {
    await createSourceMemory({
      urn: 'org-a:sys-mem',
      name: 'sys-mem',
      class: 'system',
      visibility: null,
    });
    await expect(
      resolvers.Mutation.cloneMemory({}, { id: 'org-a::sys-mem', name: 'x' }, adminCtx()),
    ).rejects.toThrow(/class='system'/);
  });

  it('rejects encrypted sources', async () => {
    await createSourceMemory({ isEncrypted: true });
    await expect(
      resolvers.Mutation.cloneMemory(
        {},
        { id: 'org-a::src-mem', name: 'x' },
        adminCtx(),
      ),
    ).rejects.toThrow(/encrypted/);
  });

  it('rejects a URN collision with a live memory', async () => {
    await createSourceMemory();
    await resolvers.Mutation.cloneMemory(
      {},
      { id: 'org-a::src-mem', name: 'clone-mem' },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.cloneMemory(
        {},
        { id: 'org-a::src-mem', name: 'clone-mem' },
        adminCtx(),
      ),
    ).rejects.toThrow(/already exists/);
  });
});
