/**
 * #5131 — the structural drift pin for install-write concealment: every field of the SDL
 * `type Node` is classified as CONCEALED_FIELDS (blanked), CONCEALED_NODE_KEEPS (carried
 * on the sparse parent, plus documented internal keeps) or reviewed (derives from the
 * concealed parent itself, loading at most address data), so the next field the Node type
 * gains cannot silently escape concealment the way `storedBytes` nearly did (#5018,
 * caught by the §10 review; prior instances #3092 / #1151).
 *
 * The seven acceptance items map to tests below; item 7 (deleting a classified field
 * turns the pin red) is item 2 read under its mutant — the PR's mutant protocol
 * demonstrates it by deleting `updatedByUser` from CONCEALED_FIELDS.
 */
import { describe, it, expect } from 'vitest';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { portalUrlForUrn } from '../../../lib/portalUrl.js';
import {
  INSTALL_CONCEALED_FIELDS,
  CONCEALED_NODE_KEEPS,
  INSTALL_REVIEWED_NO_LOAD_FIELDS,
  INSTALL_REVIEWED_ADDRESS_LOADS,
  concealedInstallNode,
  classifyInstallNodeConcealment,
} from './installMemory.js';

const sdlOf = async (): Promise<string> => {
  const { typeDefs } = await import('./typeDefs.js');
  return String((typeDefs as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? typeDefs);
};

/** A database whose EVERY access throws, including namespace access (`ctx.db.node`). */
const throwingDb = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    throw new Error(`pin: concealed-parent resolution reached db.${String(prop)}`);
  },
});
const throwingCtx = { db: throwingDb } as unknown as Context;

const MEM_URN = 'hadronmemory.com:org-x:app-y:install';
const LOC = 'prompts:lane';
/** The node namespace throws on every query; only the two address tables serve, one column each. */
const throwingNodeTable = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    return () => {
      throw new Error(`pin: concealed-parent resolution queried the node table (${String(prop)})`);
    };
  },
});
const addressCtx = {
  db: {
    node: throwingNodeTable,
    memory: { findUnique: async () => ({ urn: MEM_URN }) },
    agent: { findFirst: async () => null },
  },
} as unknown as Context;

/** A realistic row the sparse parent is built from: concealment must drop all of this. */
const concealedParent = concealedInstallNode({
  id: 'node-pin-id', memoryId: 'mem-pin-id', loc: LOC, nodeType: null, objectType: 'NOTE',
  revision: 7, revSeq: 7, isLink: false, isPlaceholder: false,
  createdAt: new Date(0), updatedAt: new Date(0),
  name: 'the real title', alias: 'real-alias', description: 'real description', abstract: 'real abstract',
  abstractOriginHash: 'real-hash', content: 'real content body', tokens: 123, seq: 9,
  role: 'engineer', llmModel: 'glm-5.3', isRunnable: true, ownerRepo: 'acme/real',
  tags: ['real:tag'], embeddingAttempts: 4, embeddingTruncatedChunks: 3,
  embeddingPendingAt: new Date(0), embeddingFailedAt: new Date(0), embeddingError: 'real failure',
});

describe('#5131 install-concealment field drift pin', () => {
  it('1. an unclassified field fails: a doctored SDL with driftProbe reports exactly [driftProbe]', async () => {
    const real = await sdlOf();
    const doctored = real.replace('\n  type Node {', '\n  type Node {\n    driftProbe: String');
    expect(doctored).not.toEqual(real);
    expect(classifyInstallNodeConcealment(doctored).unclassified).toEqual(['driftProbe']);
  });

  it('2. the real SDL is fully classified (fields > 40, none unclassified)', async () => {
    const drift = classifyInstallNodeConcealment(await sdlOf());
    expect(drift.fieldCount).toBeGreaterThan(40);
    expect(drift.unclassified).toEqual([]);
  });

  it('3. the buckets are disjoint', async () => {
    expect(classifyInstallNodeConcealment(await sdlOf()).overlapping).toEqual([]);
  });

  it('4. no stale entry: every bucket name is an SDL Node field (documented internals exempt)', async () => {
    expect(classifyInstallNodeConcealment(await sdlOf()).stale).toEqual([]);
  });

  it('5. every reviewed entry carries a non-empty reason, in the terms of the pin', () => {
    for (const [field, reason] of Object.entries(INSTALL_REVIEWED_NO_LOAD_FIELDS)) {
      expect(reason.trim().length, `no-load reason for ${field}`).toBeGreaterThan(0);
      expect(reason, `no-load reason for ${field} must say it derives from the parent or loads only address data`).toMatch(/parent|urn/i);
    }
    for (const [field, reason] of Object.entries(INSTALL_REVIEWED_ADDRESS_LOADS)) {
      expect(reason.trim().length, `address reason for ${field}`).toBeGreaterThan(0);
    }
  });

  it('6. each no-load reviewed field resolves against a concealed parent with an all-throwing database, returning the parent-derived value', async () => {
    // Canary: the context really throws, so a resolver that queried could not pass silently.
    expect(() => (throwingCtx.db as unknown as Record<string, unknown>).node).toThrow(/pin:/);

    const expected: Record<string, unknown> = {
      deletedAt: undefined, alias: undefined, description: undefined, abstract: undefined,
      abstractOriginHash: undefined, embeddingPendingAt: undefined, embeddingFailedAt: undefined,
      embeddingError: undefined, tokens: undefined, properties: undefined, data: undefined,
      seq: undefined, ownerRepo: undefined, isRunnable: undefined, role: undefined,
      llmModel: undefined, aiAgent: undefined, content: undefined,
      name: LOC, embeddingAttempts: 0, tags: [], specLint: null,
      lintWarnings: { items: [], total: 0, nextCursor: null },
    };
    expect(Object.keys(expected).sort()).toEqual(Object.keys(INSTALL_REVIEWED_NO_LOAD_FIELDS).sort());

    const nodeResolvers = resolvers.Node as Record<string, unknown>;
    for (const [field, want] of Object.entries(expected)) {
      const explicit = nodeResolvers[field];
      // GraphQL's default resolution for a field with no explicit resolver is a plain read
      // of parent[field]; a future explicit resolver replaces this branch and is then held
      // to the same throwing database.
      const resolve = (typeof explicit === 'function' ? explicit : (parent: Record<string, unknown>) => parent[field]) as
        (parent: unknown, args: unknown, ctx: unknown) => unknown;
      const args = field === 'content' ? { raw: null } : field === 'lintWarnings' ? { first: null, after: null } : {};
      const out = await resolve(concealedParent, args, throwingCtx);
      if (want === undefined) expect(out, `Node.${field} on a concealed parent`).toBeUndefined();
      else expect(out, `Node.${field} on a concealed parent`).toEqual(want);
    }
  });

  it('6b. the address-only reviewed fields never reach the node table, and answer from loc plus the memory urn', async () => {
    const nodeResolvers = resolvers.Node as Record<string, unknown>;
    const urn = emitNodeUrnV2(MEM_URN, LOC);
    expect(await (nodeResolvers.urn as (p: unknown, a: unknown, c: unknown) => Promise<string>)(concealedParent, {}, addressCtx)).toBe(urn);
    expect(await (nodeResolvers.portalUrl as (p: unknown, a: unknown, c: unknown) => Promise<string | null>)(concealedParent, {}, addressCtx)).toBe(portalUrlForUrn(urn));
    // actionUrn for a non-register loc never queries at all (registerEntryCode nulls first).
    expect(await (nodeResolvers.actionUrn as (p: unknown, a: unknown, c: unknown) => Promise<string | null>)(concealedParent, {}, throwingCtx)).toBeNull();
    // A register: loc loads only the holding Agent's urn; no App install memory is an Agent system memory.
    const registerParent = concealedInstallNode({ ...concealedParent, loc: 'register:do-thing' });
    expect(await (nodeResolvers.actionUrn as (p: unknown, a: unknown, c: unknown) => Promise<string | null>)(registerParent, {}, addressCtx)).toBeNull();
  });

  it('the buckets this pin reads are the ones installMemory.ts actually enforces (no shadow copy)', () => {
    // CONCEALED_FIELDS keys are enforced by withInstallConcealment; KEEPS by concealedInstallNode.
    expect(INSTALL_CONCEALED_FIELDS.length).toBeGreaterThan(20);
    expect([...CONCEALED_NODE_KEEPS]).toContain('revSeq');
    expect(INSTALL_CONCEALED_FIELDS).not.toContain('revSeq');
  });

  it('8. the leak this pin caught on its first run: indexTruncated on a concealed parent answers null, never the live row chunk count', async () => {
    // Red on main (Peter's ruling, 2026-11-25): the sparse parent carries no
    // embeddingTruncatedChunks, so Node.indexTruncated fell through to
    // truncatedChunksBatched and re-read the row by node id. This database serves
    // that re-read — so the only thing standing between the caller and
    // { omittedChunks: 3 } is the CONCEALED_FIELDS entry.
    const servingCtx = {
      db: {
        node: { findMany: async () => [{ id: 'node-pin-id', embeddingTruncatedChunks: 3 }] },
      },
    } as unknown as Context;
    // Control: an ORDINARY parent carrying the column serves it (no concealment marker).
    const control = { id: 'node-pin-id', memoryId: 'mem-pin-id', loc: LOC, embeddingTruncatedChunks: 3 };
    expect(await (resolvers.Node as Record<string, unknown>).indexTruncated(control, {}, servingCtx)).toEqual({ omittedChunks: 3 });
    // Concealed parent: same node, same serving database — must answer null.
    expect(await (resolvers.Node as Record<string, unknown>).indexTruncated(concealedParent, {}, servingCtx)).toBeNull();
  });
});
