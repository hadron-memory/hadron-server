/**
 * mergeNodes — fold a source node into a target node. Covers per-field merge
 * strategy (text concat, tag union, JSON shallow-merge), field selection via
 * `include`, edge re-pointing, deleteSource, URN inputs, the version snapshot
 * + abstract-staleness recompute, and the guard errors.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let memory: { id: string; urn: string };

function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

async function makeNode(loc: string, fields: Record<string, unknown> = {}) {
  return db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc, name: loc, ...fields },
  });
}

function merge(input: Record<string, unknown>) {
  return resolvers.Mutation.mergeNodes({}, { input } as never, ctx());
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'mn-org', urn: 'mn-org' },
  });
  admin = await db.user.create({
    data: { githubId: 8888, githubUsername: 'mn-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'mn-mem' }, ctx());
});

describe('mergeNodes — field merge', () => {
  it('concatenates text, unions tags, and keeps the source by default', async () => {
    const src = await makeNode('src', {
      content: 'source body',
      description: 'src desc',
      tags: ['b', 'c'],
    });
    const tgt = await makeNode('tgt', {
      content: 'target body',
      description: 'tgt desc',
      tags: ['a', 'b'],
    });

    const out = await merge({ source: src.id, target: tgt.id });

    expect(out.id).toBe(tgt.id);
    expect(out.content).toBe('target body\n\nsource body');
    expect(out.description).toBe('tgt desc\n\nsrc desc');
    expect(out.tags).toEqual(['a', 'b', 'c']);

    // deleteSource defaults to false → source survives untouched.
    const stillThere = await db.node.findUnique({ where: { id: src.id } });
    expect(stillThere?.deletedAt).toBeNull();
    expect(stillThere?.content).toBe('source body');
  });

  it('passes a one-sided text value through unchanged', async () => {
    const src = await makeNode('src', { content: 'only source' });
    const tgt = await makeNode('tgt', {}); // no content
    const out = await merge({ source: src.id, target: tgt.id, include: ['CONTENT'] });
    expect(out.content).toBe('only source');
  });

  it('shallow-merges data/properties with the target winning on collisions', async () => {
    const src = await makeNode('src', {
      data: { a: 1, shared: 'from-source' },
      properties: { p: 'src', shared: 'src' },
    });
    const tgt = await makeNode('tgt', {
      data: { b: 2, shared: 'from-target' },
      properties: { q: 'tgt', shared: 'tgt' },
    });

    const out = await merge({ source: src.id, target: tgt.id, include: ['DATA', 'PROPERTIES'] });

    expect(out.data).toEqual({ a: 1, b: 2, shared: 'from-target' });
    expect(out.properties).toEqual({ p: 'src', q: 'tgt', shared: 'tgt' });
  });

  it('only merges the selected fields', async () => {
    const src = await makeNode('src', { content: 'sc', description: 'sd', tags: ['x'] });
    const tgt = await makeNode('tgt', { content: 'tc', description: 'td', tags: ['y'] });

    const out = await merge({ source: src.id, target: tgt.id, include: ['CONTENT'] });

    expect(out.content).toBe('tc\n\nsc');
    expect(out.description).toBe('td'); // untouched
    expect(out.tags).toEqual(['y']); // untouched
  });

  it('does not fold a non-object (array/scalar) source JSON into a null target', async () => {
    // mergeJson must reject a non-plain-object source even when the target is
    // null — otherwise an array/scalar would be written into data/properties.
    const src = await makeNode('src', { data: [1, 2, 3], properties: 'scalar' });
    const tgt = await makeNode('tgt', {}); // data + properties null

    const out = await merge({ source: src.id, target: tgt.id, include: ['DATA', 'PROPERTIES'] });

    expect(out.data).toBeNull();
    expect(out.properties).toBeNull();
  });
});

describe('mergeNodes — source lifecycle', () => {
  it('hard-deletes the source when deleteSource is true', async () => {
    const src = await makeNode('src', { content: 's' });
    const tgt = await makeNode('tgt', { content: 't' });

    await merge({ source: src.id, target: tgt.id, deleteSource: true });

    const gone = await db.node.findUnique({ where: { id: src.id } });
    expect(gone).toBeNull();
  });
});

describe('mergeNodes — edges', () => {
  it('re-points incoming and outgoing edges onto the target, dropping self-loops', async () => {
    const src = await makeNode('src');
    const tgt = await makeNode('tgt');
    const other = await makeNode('other');

    // outgoing from source → other
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: src.id, targetId: other.id, loc: 'src:rel:other' },
    });
    // incoming to source ← other
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: other.id, targetId: src.id, loc: 'other:rel:src' },
    });
    // source↔target edge → would become a target self-loop → dropped
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: src.id, targetId: tgt.id, loc: 'src:rel:tgt' },
    });

    await merge({ source: src.id, target: tgt.id, include: ['EDGES'], deleteSource: true });

    const tgtOut = await db.edge.findMany({ where: { sourceId: tgt.id } });
    const tgtIn = await db.edge.findMany({ where: { targetId: tgt.id } });
    expect(tgtOut.map((e) => e.targetId)).toEqual([other.id]); // src:rel:other moved
    expect(tgtIn.map((e) => e.sourceId)).toEqual([other.id]); // other:rel:src moved
    // The src↔tgt edge collapsed to a self-loop and was dropped.
    const selfLoops = await db.edge.findMany({ where: { sourceId: tgt.id, targetId: tgt.id } });
    expect(selfLoops).toHaveLength(0);
    // Source removed without cascade-deleting the transferred edges.
    expect(await db.node.findUnique({ where: { id: src.id } })).toBeNull();
    expect(await db.edge.count({ where: { OR: [{ sourceId: tgt.id }, { targetId: tgt.id }] } })).toBe(2);
  });

  it('recomputes a re-homed edge loc from its new endpoints (#568 Q2)', async () => {
    const src = await makeNode('src');
    const tgt = await makeNode('tgt');
    const other = await makeNode('other');
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: src.id, targetId: other.id, loc: 'src:rel:other', name: 'rel' },
    });
    await merge({ source: src.id, target: tgt.id, include: ['EDGES'], deleteSource: true });
    const moved = await db.edge.findFirstOrThrow({ where: { sourceId: tgt.id, targetId: other.id } });
    // loc no longer references the merged-away `src`; it reflects the new source.
    expect(moved.loc).toBe('tgt:rel:other');
  });

  it('dedupes an equivalent edge B already has, instead of duplicating (#568 Q2)', async () => {
    const src = await makeNode('src');
    const tgt = await makeNode('tgt');
    const other = await makeNode('other');
    // Both A and B already point at `other` with the SAME name → equivalent.
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: src.id, targetId: other.id, loc: 'src:rel:other', name: 'rel' },
    });
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: tgt.id, targetId: other.id, loc: 'tgt:rel:other', name: 'rel' },
    });
    await merge({ source: src.id, target: tgt.id, include: ['EDGES'], deleteSource: true });
    // B keeps exactly ONE tgt→other:rel edge (A's re-homed duplicate dropped).
    const tgtToOther = await db.edge.findMany({ where: { sourceId: tgt.id, targetId: other.id } });
    expect(tgtToOther).toHaveLength(1);
  });

  it('keeps distinct-name edges to the same target (dedup is per name)', async () => {
    const src = await makeNode('src');
    const tgt = await makeNode('tgt');
    const other = await makeNode('other');
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: src.id, targetId: other.id, loc: 'src:imports:other', name: 'imports' },
    });
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: tgt.id, targetId: other.id, loc: 'tgt:depends:other', name: 'depends' },
    });
    await merge({ source: src.id, target: tgt.id, include: ['EDGES'], deleteSource: true });
    // Different names → not equivalent → both survive on B.
    const tgtToOther = await db.edge.findMany({ where: { sourceId: tgt.id, targetId: other.id } });
    expect(tgtToOther.map((e) => e.name).sort()).toEqual(['depends', 'imports']);
  });

  it('does not touch edges when EDGES is not included', async () => {
    const src = await makeNode('src');
    const tgt = await makeNode('tgt');
    const other = await makeNode('other');
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: src.id, targetId: other.id, loc: 'src:rel:other' },
    });

    await merge({ source: src.id, target: tgt.id, include: ['CONTENT'] });

    // Edge still hangs off the (still-present) source.
    expect(await db.edge.count({ where: { sourceId: src.id } })).toBe(1);
    expect(await db.edge.count({ where: { sourceId: tgt.id } })).toBe(0);
  });
});

describe('mergeNodes — version history + staleness', () => {
  it('snapshots a NodeVersion of the target and refreshes the abstract hash', async () => {
    const src = await makeNode('src', { content: 'sc', abstract: 'src abstract' });
    const tgt = await makeNode('tgt', {
      content: 'tc',
      abstract: 'tgt abstract',
      abstractOriginHash: 'stale123',
    });

    const out = await merge({ source: src.id, target: tgt.id, include: ['CONTENT', 'ABSTRACT'] });

    expect(out.abstract).toBe('tgt abstract\n\nsrc abstract');
    // abstract changed → hash recomputed off the post-merge content.
    expect(out.abstractOriginHash).not.toBe('stale123');

    const versions = await db.nodeVersion.findMany({ where: { nodeId: tgt.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('tc'); // pre-merge snapshot
  });
});

describe('mergeNodes — input resolution', () => {
  it('accepts fully-qualified node URNs for both endpoints', async () => {
    const src = await makeNode('src', { content: 's' });
    const tgt = await makeNode('tgt', { content: 't' });
    const out = await merge({
      source: `${memory.urn}:src`,
      target: `${memory.urn}:tgt`,
      include: ['CONTENT'],
    });
    expect(out.id).toBe(tgt.id);
    expect(out.content).toBe('t\n\ns');
  });
});

describe('mergeNodes — encryption', () => {
  it('merges on an encrypted memory: ciphertext at rest, plaintext to the caller', async () => {
    sessionKeyCache.clear();
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'mn-org:mn-agent',
        name: 'mn-agent',
        type: 'CHATBOT',
        surfaces: ['api'],
      },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'mn-app',
        urn: 'mn-org:mn-app',
        createUserPermission: 'IMPLICIT',
        identifyUserMethod: 'SECRET',
      },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });

    const key = generateDataKey().raw.toString('base64');
    const appCtx: Context = { db, appId: app.id, roles: ['ADMIN'], organizationId: org.id };
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx,
    );
    const memId = session.memoryId!;
    const sCtx: Context = { ...appCtx, sessionId: session.id };

    const src = await resolvers.Mutation.createNode(
      {}, { input: { memoryId: memId, loc: 'src', name: 'src', content: 'secret source' } }, sCtx,
    );
    const tgt = await resolvers.Mutation.createNode(
      {}, { input: { memoryId: memId, loc: 'tgt', name: 'tgt', content: 'secret target' } }, sCtx,
    );

    const out = await resolvers.Mutation.mergeNodes(
      {}, { input: { source: src.id, target: tgt.id, include: ['CONTENT'] } } as never, sCtx,
    );
    expect(out.content).toBe('secret target\n\nsecret source');

    // DB row is ciphertext.
    const raw = await db.node.findUnique({ where: { id: tgt.id } });
    expect(raw?.content?.startsWith('enc:v1:')).toBe(true);
    expect(raw?.content).not.toContain('secret');
  });

  it('runs an edge-only merge on an encrypted memory without a session key', async () => {
    // Only content/abstract/data are encrypted, so an EDGES-only merge needs
    // no key — it must not fail with SESSION_EXPIRED after the session ends.
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: 'mn-org:eo-agent', name: 'eo-agent', type: 'CHATBOT', surfaces: ['api'] },
    });
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'eo-app', urn: 'mn-org:eo-app', createUserPermission: 'IMPLICIT', identifyUserMethod: 'SECRET' },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });

    const key = generateDataKey().raw.toString('base64');
    const appCtx: Context = { db, appId: app.id, roles: ['ADMIN'], organizationId: org.id };
    const session = await resolvers.Mutation.startAgentSession(
      {}, { agentId: agent.id, externalUserId: 'mm-eo', dataKey: key }, appCtx,
    );
    const memId = session.memoryId!;
    const sCtx: Context = { ...appCtx, sessionId: session.id };

    const src = await resolvers.Mutation.createNode({}, { input: { memoryId: memId, loc: 'src', name: 'src', content: 'secret s' } }, sCtx);
    const tgt = await resolvers.Mutation.createNode({}, { input: { memoryId: memId, loc: 'tgt', name: 'tgt', content: 'secret t' } }, sCtx);
    const other = await resolvers.Mutation.createNode({}, { input: { memoryId: memId, loc: 'other', name: 'other' } }, sCtx);
    await db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: src.id, targetId: other.id, loc: 'src:rel:other' } });

    // End the session → no live key for this memory.
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx);
    sessionKeyCache.clear();

    const out = await resolvers.Mutation.mergeNodes(
      {}, { input: { source: src.id, target: tgt.id, include: ['EDGES'], deleteSource: true } } as never, sCtx,
    );

    // Merge succeeded: the edge transferred to the target.
    expect(await db.edge.count({ where: { sourceId: tgt.id } })).toBe(1);
    expect(await db.node.findUnique({ where: { id: src.id } })).toBeNull();
    // No key available → encrypted content is returned as-is (ciphertext), not decrypted.
    expect(out.content?.startsWith('enc:v1:')).toBe(true);
  });
});

describe('mergeNodes — guards', () => {
  it('rejects merging a node into itself', async () => {
    const n = await makeNode('n', { content: 'x' });
    await expect(merge({ source: n.id, target: n.id })).rejects.toThrow(/same node/i);
  });

  it('throws NODE_NOT_FOUND for a missing source', async () => {
    const tgt = await makeNode('tgt');
    await expect(merge({ source: generateId(), target: tgt.id })).rejects.toThrow(/not found/i);
  });

  it('rejects an over-long merged abstract', async () => {
    const src = await makeNode('src', { abstract: 'b'.repeat(1500) });
    const tgt = await makeNode('tgt', { abstract: 'a'.repeat(1500) });
    await expect(
      merge({ source: src.id, target: tgt.id, include: ['ABSTRACT'] }),
    ).rejects.toThrow(/2000/);
  });
});
