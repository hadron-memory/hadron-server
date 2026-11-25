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
 * demonstrates it by deleting `updatedByUser` from CONCEALED_FIELDS. The #5147 review
 * strengthened the pins: classification is by parsed AST (definition + extensions, any
 * GraphQL name — tests 9/10), the no-query proofs record every database access so a
 * swallowed error cannot pass (tests 6/6b/11), the wrap itself is proven (test 11), and
 * the only KEEPS field with an explicit resolver is enumerated (test 12).
 */
import { describe, it, expect } from 'vitest';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { portalUrlForUrn } from '../../../lib/portalUrl.js';
import {
  INSTALL_CONCEALED_FIELDS,
  CONCEALED_NODE_KEEPS,
  CONCEALED_NODE_INTERNAL_KEEPS,
  INSTALL_REVIEWED_NO_LOAD_FIELDS,
  INSTALL_REVIEWED_ADDRESS_LOADS,
  concealedInstallNode,
  classifyInstallNodeConcealment,
} from './installMemory.js';

const sdlOf = async (): Promise<string> => {
  const { typeDefs } = await import('./typeDefs.js');
  return String((typeDefs as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? typeDefs);
};

/**
 * A database whose EVERY access is recorded and then thrown, including namespace
 * access (`ctx.db.node`) — the recording is the proof a swallowed error cannot
 * defeat: a resolver that catches the throw still leaves its access on the log
 * (#5147 review), and the tests below assert the log stays empty.
 */
const dbAccesses: string[] = [];
const throwingDb = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    dbAccesses.push(String(prop));
    throw new Error(`pin: concealed-parent resolution reached db.${String(prop)}`);
  },
});
const throwingCtx = { db: throwingDb } as unknown as Context;

const MEM_URN = 'hadronmemory.com:org-x:app-y:install';
const LOC = 'prompts:lane';
/**
 * A fresh recording context per resolution: the node namespace records every
 * property touched and throws on every query; the two address tables serve,
 * capturing their arguments so the pins can assert the loads are by memory id /
 * systemMemoryId only — never the node row, never a content-derived column.
 */
const recordingAddressCtx = () => {
  const nodeProps: string[] = [];
  const memoryArgs: Array<Record<string, unknown>> = [];
  const agentArgs: Array<Record<string, unknown>> = [];
  const ctx = {
    db: {
      node: new Proxy({} as Record<string, unknown>, {
        get(_target, prop) {
          nodeProps.push(String(prop));
          return () => {
            throw new Error(`pin: concealed-parent resolution queried the node table (${String(prop)})`);
          };
        },
      }),
      memory: {
        findUnique: async (args: Record<string, unknown>) => {
          memoryArgs.push(args);
          return { urn: MEM_URN };
        },
      },
      agent: {
        findFirst: async (args: Record<string, unknown>) => {
          agentArgs.push(args);
          return null;
        },
      },
    },
  } as unknown as Context;
  return { ctx, nodeProps, memoryArgs, agentArgs };
};

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
    // The internal keeps are a documented subset of the carried fields, each reason
    // naming what reads it — an exemption with no reader is a stale entry in waiting.
    for (const [field, reason] of Object.entries(CONCEALED_NODE_INTERNAL_KEEPS)) {
      expect(reason.trim().length, `internal-keep reason for ${field}`).toBeGreaterThan(0);
      expect(CONCEALED_NODE_KEEPS, `internal keep ${field} must be carried on the sparse parent`).toContain(field);
    }
  });

  it('6. each no-load reviewed field resolves against a concealed parent with an all-throwing database, returning the parent-derived value', async () => {
    // Canary: the context really throws (and records), so a resolver that queried could not
    // pass silently — and one that swallowed the error would still leave the access logged.
    dbAccesses.length = 0;
    expect(() => (throwingCtx.db as unknown as Record<string, unknown>).node).toThrow(/pin:/);
    expect(dbAccesses).toEqual(['node']);
    dbAccesses.length = 0;

    // Raw `undefined` is what default resolution of an absent property returns; GraphQL
    // renders it null. The reasons in INSTALL_REVIEWED_NO_LOAD_FIELDS describe the field
    // value the caller sees; this pin asserts the raw resolver output.
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
      dbAccesses.length = 0;
      const out = await resolve(concealedParent, args, throwingCtx);
      if (want === undefined) expect(out, `Node.${field} on a concealed parent`).toBeUndefined();
      else expect(out, `Node.${field} on a concealed parent`).toEqual(want);
      // The resolution must not merely survive the throwing database — it must never touch it.
      expect(dbAccesses, `Node.${field} on a concealed parent reached the database`).toEqual([]);
    }
  });

  it('6b. the address-only reviewed fields never reach the node table, and answer from loc plus the memory urn', async () => {
    const nodeResolvers = resolvers.Node as Record<string, unknown>;
    const urn = emitNodeUrnV2(MEM_URN, LOC);
    const byMemoryId = (args: Record<string, unknown> | undefined) =>
      (args?.where as { id?: string } | undefined)?.id === 'mem-pin-id';
    // Node.urn: one load, the memory's urn by memory id; the node table untouched.
    {
      const { ctx, nodeProps, memoryArgs } = recordingAddressCtx();
      expect(await (nodeResolvers.urn as (p: unknown, a: unknown, c: unknown) => Promise<string>)(concealedParent, {}, ctx)).toBe(urn);
      expect(nodeProps, 'Node.urn touched the node table').toEqual([]);
      expect(memoryArgs, 'Node.urn must load exactly once, by memory id').toHaveLength(1);
      expect(byMemoryId(memoryArgs[0]), 'Node.urn must load by memory id, not by node id').toBe(true);
    }
    // Node.portalUrl: the same single load feeding the same composed urn.
    {
      const { ctx, nodeProps, memoryArgs } = recordingAddressCtx();
      expect(await (nodeResolvers.portalUrl as (p: unknown, a: unknown, c: unknown) => Promise<string | null>)(concealedParent, {}, ctx)).toBe(portalUrlForUrn(urn));
      expect(nodeProps, 'Node.portalUrl touched the node table').toEqual([]);
      expect(memoryArgs, 'Node.portalUrl must load exactly once, by memory id').toHaveLength(1);
      expect(byMemoryId(memoryArgs[0]), 'Node.portalUrl must load by memory id, not by node id').toBe(true);
    }
    // actionUrn for a non-register loc never queries at all (registerEntryCode nulls first).
    dbAccesses.length = 0;
    expect(await (nodeResolvers.actionUrn as (p: unknown, a: unknown, c: unknown) => Promise<string | null>)(concealedParent, {}, throwingCtx)).toBeNull();
    expect(dbAccesses, 'Node.actionUrn queried for a non-register loc').toEqual([]);
    // A register: loc loads only the holding Agent's urn by systemMemoryId; no App install
    // memory is an Agent system memory, and the node table stays untouched.
    const registerParent = concealedInstallNode({ ...concealedParent, loc: 'register:do-thing' });
    {
      const { ctx, nodeProps, agentArgs } = recordingAddressCtx();
      expect(await (nodeResolvers.actionUrn as (p: unknown, a: unknown, c: unknown) => Promise<string | null>)(registerParent, {}, ctx)).toBeNull();
      expect(nodeProps, 'Node.actionUrn touched the node table').toEqual([]);
      expect(agentArgs, 'Node.actionUrn must load the Agent by systemMemoryId exactly once').toHaveLength(1);
      expect((agentArgs[0]?.where as { systemMemoryId?: string } | undefined)?.systemMemoryId).toBe('mem-pin-id');
    }
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
    const indexTruncated = (resolvers.Node as Record<string, unknown>).indexTruncated as
      (parent: unknown, args: unknown, ctx: unknown) => Promise<unknown>;
    expect(await indexTruncated(control, {}, servingCtx)).toEqual({ omittedChunks: 3 });
    // Concealed parent: same node, same serving database — must answer null.
    expect(await indexTruncated(concealedParent, {}, servingCtx)).toBeNull();
  });

  it('9. the classifier reads GraphQL names, not a line regex: digit- and underscore-bearing fields are caught', async () => {
    // The #5147 review mutants, pinned permanently: `sha256` / `content_v2` match the
    // schema's own name rule but not `[a-zA-Z]+`, so a text-regex classifier would leave
    // them unclassified with the pin green — the exact drift this suite exists to catch.
    const real = await sdlOf();
    for (const probe of ['sha256: String', 'content_v2: String']) {
      const doctored = real.replace('\n  type Node {', `\n  type Node {\n    ${probe}`);
      expect(doctored).not.toEqual(real);
      expect(classifyInstallNodeConcealment(doctored).unclassified).toEqual([probe.split(':')[0]]);
    }
  });

  it('10. an `extend type Node` block is classified too, not just the definition', async () => {
    const real = await sdlOf();
    const extended = `${real}\n\nextend type Node {\n  lateAddition: String\n}\n`;
    const drift = classifyInstallNodeConcealment(extended);
    expect(drift.unclassified).toEqual(['lateAddition']);
    expect(drift.fieldCount).toBeGreaterThan(40);
  });

  it('11. the imported map is the wrapped one: every concealed field answers on a concealed parent without reaching the database', async () => {
    // withInstallConcealment wraps the merged map in resolvers.ts; the concealment check
    // lives in that wrapper, so the pin must import the WRAPPED resolvers.Node — these
    // resolutions prove it: on a concealed parent every CONCEALED_FIELDS entry returns
    // its blanked value BEFORE the original resolver could touch the all-throwing db.
    const nodeResolvers = resolvers.Node as Record<string, unknown>;
    for (const field of INSTALL_CONCEALED_FIELDS) {
      dbAccesses.length = 0;
      const out = await (nodeResolvers[field] as (p: unknown, a: unknown, c: unknown) => unknown)(
        concealedParent, field === 'signingRequestsPage' ? {} : {}, throwingCtx,
      );
      expect(out, `Node.${field} on a concealed parent must not throw`).toBeDefined();
      expect(dbAccesses, `Node.${field} on a concealed parent reached the database`).toEqual([]);
    }
    // Canary: without the wrap, the ORIGINAL resolver for a concealed field does reach
    // the database on an ordinary parent (Node.memory loads the record by id).
    dbAccesses.length = 0;
    await expect(
      (nodeResolvers.memory as (p: unknown, a: unknown, c: unknown) => unknown)(
        { id: 'node-pin-id', memoryId: 'mem-pin-id', loc: LOC }, {}, throwingCtx,
      ),
    ).rejects.toThrow(/pin:/);
    expect(dbAccesses).not.toEqual([]);
  });

  it('12. the only KEEPS field with an explicit resolver is Node.revision, whose non-reader path is pinned in installMemoryConcealedRevision5131.test.ts', () => {
    // The carried fields are safe because the sparse parent carries them — UNLESS a field
    // gains an explicit resolver that re-reads the live row, the way indexTruncated did.
    // This pin enumerates the wrap: a NEW explicit resolver on a KEEPS field turns this
    // red and must be moved to a reviewed bucket with a reason and a no-query proof.
    // Node.revision's proof needs a real database (its read gate is the memory's access
    // predicate), so it lives in installMemoryConcealedRevision5131.test.ts: on a concealed
    // parent it answers the carried revSeq with no node-row read, row lock or reconcile.
    const nodeResolvers = resolvers.Node as Record<string, unknown>;
    const withResolvers = CONCEALED_NODE_KEEPS.filter((k) => typeof nodeResolvers[k] === 'function');
    expect(withResolvers).toEqual(['revision']);
  });
});
