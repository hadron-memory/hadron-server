/**
 * #1316 — the residual memory-ref surfaces must not tell an unreadable memory
 * from a missing one.
 *
 * #1319 closed `memory(ref:)` and the direct node create/update doors. This
 * fixture covers the six surfaces it left, each of which resolved the ref
 * (only a MISSING memory throws there) and then ran its own gate with its own
 * denial shape — so "exists but you can't read it" answered differently from
 * "no such memory", and memory URNs are guessable:
 *
 *   memoryUsageSummary · validateMemory · node(ref:, memoryRef:) ·
 *   nodeBatch(memory:) · cloneMemory · retryFailedEmbeddings
 *
 * Every assertion is PAIRED: the same request against an existing target and a
 * missing one, compared as the complete HTTP response after substituting only
 * the caller-supplied ref. Real HTTP and real UserApiKeys, so the wire shape
 * is what a client sees (formatError included). Controls pin what must NOT
 * change: a reader keeps their data, a readable-but-not-permitted caller keeps
 * FORBIDDEN, malformed refs stay caller errors, and a denied mutation leaves
 * no side effect.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey, type OAuthScope } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { status: number; data: Record<string, any> | null | undefined; errors: GqlError[] | undefined };

const NODE_LOC = 'oracle:probe';

const USAGE = `query($m: ID!) { memoryUsageSummary(memoryRef: $m) { nodeLoc type count } }`;
const VALIDATE = `query($m: ID!) { validateMemory(memoryRef: $m) { memoryId nodesChecked ok } }`;
const NODE = `query($m: ID!) { node(ref: "${NODE_LOC}", memoryRef: $m) { id loc } }`;
const BATCH = `query($m: ID!) { nodeBatch(memory: $m, locPrefix: "oracle") { nodes { id loc } unavailable truncated omitted } }`;
const CLONE = `mutation($m: ID!, $t: String!) { cloneMemory(ref: $m, targetUrn: $t) { id urn } }`;
const RETRY = `mutation($m: ID!) { retryFailedEmbeddings(memoryRef: $m) }`;

let server: Server;
let baseUrl: string;
const key: Record<string, string> = {};
/** Existing targets, by label → { id, urn }. */
const mem: Record<string, { id: string; urn: string }> = {};
let missingUrn: string;
let missingId: string;
let outsiderCloneTarget: string;
let readerCloneTarget: string;
let suffix: string;

async function gql(k: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: Record<string, any> | null; errors?: GqlError[] };
  return { status: response.status, data: body.data, errors: body.errors };
}

/**
 * The complete externally visible response with the caller's own ref replaced
 * by a placeholder — the ONLY difference a paired request is allowed to show.
 * `locations`/`path` stay in, since they are part of what a client receives.
 */
function wire(result: Gql, ref: string): string {
  return JSON.stringify({ status: result.status, data: result.data, errors: result.errors }).split(ref).join('<REF>');
}

const code = (result: Gql) => result.errors?.[0]?.extensions?.code;

beforeAll(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: 'oracle org', urn: `oracle-${suffix}` },
  });
  const otherOrg = await db.organization.create({
    data: { id: generateId(), name: 'outsider org', urn: `oracle-other-${suffix}` },
  });
  const mkUser = (label: string) =>
    db.user.create({ data: { id: generateId(), handle: `${label}-${suffix}`, githubUsername: `${label}-${suffix}` } });
  const owner = await mkUser('owner');
  const reader = await mkUser('reader');
  const outsider = await mkUser('outsider');
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });

  const mint = async (userId: string, label: string, oauthScopes: OAuthScope[]) =>
    (await mintUserApiKey(db, { userId, label, createdBy: userId, issuedVia: 'test', oauthScopes })).rawKey;
  key.owner = await mint(owner.id, 'owner', ['account']);
  key.reader = await mint(reader.id, 'reader', ['account']);
  key.outsider = await mint(outsider.id, 'outsider', ['account']);

  // Org knowledge memory: the reader may read its nodes; the outsider may not.
  const knowledge = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:knowledge`,
      name: 'org knowledge',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
      vectorIndexEnabled: true,
    },
  });
  // The owner's personal memory: nobody else reads it.
  const personal = await db.memory.create({
    data: {
      id: generateId(),
      urn: `${org.urn}:personal-${suffix}`,
      name: 'owner personal',
      class: 'personal',
      visibility: null,
      userId: owner.id,
      ownerUserId: owner.id,
    },
  });
  // A creator-owned knowledge holding retains the record-vs-node shape.
  // System records no longer admit ordinary org readers (#1807).
  const holdingAgent = await db.agent.create({ data: { organizationId: org.id, urn: org.urn + ':holding-agent', name: 'Holding fixture' } });
  const recordOnly = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:record-only-holding`,
      name: 'record-readable, nodes-unreadable',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
      userMemoryOfAgentId: holdingAgent.id,
      createdBy: owner.id,
      acceptsUploads: false,
    },
  });
  for (const m of [knowledge, personal, recordOnly]) {
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: m.id,
        loc: NODE_LOC,
        name: 'probe',
        // A failed embed, so a permitted retryFailedEmbeddings has work to do
        // and a denied one visibly must not touch it.
        embeddingFailedAt: new Date('2026-01-01T00:00:00Z'),
        embeddingError: 'probe failure',
      },
    });
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', memoryId: m.id, nodeLoc: NODE_LOC },
    });
  }
  mem.knowledge = knowledge;
  mem.personal = personal;
  mem.recordOnly = recordOnly;
  missingUrn = `${org.urn}:no-such-memory-${suffix}`;
  missingId = generateId();
  outsiderCloneTarget = `${otherOrg.urn}::clone-${suffix}`;
  readerCloneTarget = `${org.urn}::reader-clone-${suffix}`;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

type Surface = {
  name: string;
  query: string;
  vars: (ref: string, principal: string) => Record<string, unknown>;
};
const SURFACES: Surface[] = [
  { name: 'memoryUsageSummary', query: USAGE, vars: (m) => ({ m }) },
  { name: 'validateMemory', query: VALIDATE, vars: (m) => ({ m }) },
  { name: 'node(ref:, memoryRef:)', query: NODE, vars: (m) => ({ m }) },
  { name: 'nodeBatch(memory:)', query: BATCH, vars: (m) => ({ m }) },
  {
    name: 'cloneMemory',
    query: CLONE,
    vars: (m, p) => ({ m, t: p === 'reader' ? readerCloneTarget : outsiderCloneTarget }),
  },
  { name: 'retryFailedEmbeddings', query: RETRY, vars: (m) => ({ m }) },
];

/** Side-effect probe: nothing a denied request may change. */
async function sideEffects() {
  const [memories, failed] = await Promise.all([
    db.memory.count(),
    db.node.count({ where: { embeddingFailedAt: { not: null } } }),
  ]);
  return { memories, failed };
}

const READ_SURFACES = SURFACES.slice(0, 4);
const MUTATION_SURFACES = SURFACES.slice(4);

/**
 * Principal × target pairs that MUST be indistinguishable from a missing
 * memory. The outsider can open nothing in the org; for the NODE-data reads the
 * reader's record-only knowledge holding is also concealed (they may open the
 * record, but these surfaces return node data, gated on node content).
 */
const OUTSIDER_CASES: Array<[string, 'urn' | 'id']> = [
  ['knowledge', 'urn'],
  ['knowledge', 'id'],
  ['personal', 'urn'],
  ['personal', 'id'],
];

async function paired(p: string, s: Surface, target: string, form: 'urn' | 'id') {
  const ref = form === 'urn' ? mem[target]!.urn : mem[target]!.id;
  const missing = form === 'urn' ? missingUrn : missingId;
  const before = await sideEffects();
  const existing = await gql(key[p]!, s.query, s.vars(ref, p));
  const absent = await gql(key[p]!, s.query, s.vars(missing, p));
  expect(await sideEffects()).toEqual(before);
  return { existing, absent, ref, missing };
}

describe('#1316 — unreadable answers exactly like missing', () => {
  for (const s of SURFACES) {
    for (const [target, form] of OUTSIDER_CASES) {
      it(`${s.name}: outsider, existing ${target} by ${form} ≡ missing`, async () => {
        const { existing, absent, ref, missing } = await paired('outsider', s, target, form);
        expect(code(absent)).toBe('MEMORY_NOT_FOUND');
        expect(wire(existing, ref)).toBe(wire(absent, missing));
      });
    }
  }

  for (const s of READ_SURFACES) {
    it(`${s.name}: record-readable, node-unreadable reader ≡ missing`, async () => {
      const { existing, absent, ref, missing } = await paired('reader', s, 'recordOnly', 'urn');
      expect(code(absent)).toBe('MEMORY_NOT_FOUND');
      expect(wire(existing, ref)).toBe(wire(absent, missing));
    });
  }
});

describe('#1316 — controls: what concealment must not change', () => {
  it('a reader keeps every read surface on a memory they can read', async () => {
    const m = mem.knowledge!.urn;
    const usage = await gql(key.reader!, USAGE, { m });
    expect(usage.errors).toBeUndefined();
    expect(usage.data!.memoryUsageSummary).toEqual([{ nodeLoc: NODE_LOC, type: 'read', count: 1 }]);
    const validate = await gql(key.reader!, VALIDATE, { m });
    expect(validate.errors).toBeUndefined();
    expect(validate.data!.validateMemory).toMatchObject({ memoryId: mem.knowledge!.id, nodesChecked: 1 });
    const node = await gql(key.reader!, NODE, { m });
    expect(node.errors).toBeUndefined();
    expect(node.data!.node).toMatchObject({ loc: NODE_LOC });
    const batch = await gql(key.reader!, BATCH, { m });
    expect(batch.errors).toBeUndefined();
    expect(batch.data!.nodeBatch.nodes).toEqual([expect.objectContaining({ loc: NODE_LOC })]);
  });

  it('a readable memory with no such loc still answers null, not MEMORY_NOT_FOUND', async () => {
    const result = await gql(key.reader!, `query($m: ID!) { node(ref: "oracle:absent", memoryRef: $m) { id } }`, {
      m: mem.knowledge!.urn,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data!.node).toBeNull();
  });

  for (const s of MUTATION_SURFACES) {
    for (const target of ['knowledge', 'recordOnly']) {
      it(`${s.name}: a caller who can open the ${target} record keeps Forbidden, with no side effect`, async () => {
        const before = await sideEffects();
        const result = await gql(key.reader!, s.query, s.vars(mem[target]!.urn, 'reader'));
        expect(await sideEffects()).toEqual(before);
        expect(result.errors).toHaveLength(1);
        expect(result.errors![0]!.message).toBe('Forbidden');
        expect(code(result)).not.toBe('MEMORY_NOT_FOUND');
      });
    }
  }

  it('a malformed ref stays a caller error on every surface, identical for outsider and owner', async () => {
    for (const s of SURFACES) {
      const outsider = await gql(key.outsider!, s.query, s.vars('not a urn', 'outsider'));
      const owner = await gql(key.owner!, s.query, s.vars('not a urn', 'owner'));
      expect(code(outsider), s.name).toBe('URN_NOT_QUALIFIED');
      expect(wire(outsider, 'not a urn'), s.name).toBe(wire(owner, 'not a urn'));
    }
  });

  it('a DB fault while classifying a denial propagates as a fault, never as not-found', async () => {
    const failure = vi
      .spyOn(db.memory, 'findUnique')
      .mockRejectedValueOnce(new Error('injected classification db failure'));
    try {
      const before = await sideEffects();
      const result = await gql(key.outsider!, RETRY, { m: mem.knowledge!.urn });
      expect(code(result)).toBe('INTERNAL_SERVER_ERROR');
      // #1789: a fault is the generic envelope (detail goes to the log), and never NOT_FOUND/FORBIDDEN (Pin 1).
      expect(result.errors![0]!.message).toBe('Internal server error.');
      expect(result.errors![0]!.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
      expect(await sideEffects()).toEqual(before);
    } finally {
      failure.mockRestore();
    }
  });

  it('a non-denial failure inside the authorization itself propagates, never as not-found', async () => {
    // The authorization step's OWN fault (here the org-membership lookup) is
    // not a denial, so it must reach the caller as itself — classifying every
    // error would turn an outage into a silent "no such memory".
    const failure = vi
      .spyOn(db.orgMember, 'findFirst')
      .mockRejectedValueOnce(new Error('injected authorization db failure'));
    try {
      const before = await sideEffects();
      const result = await gql(key.outsider!, RETRY, { m: mem.knowledge!.urn });
      expect(code(result)).toBe('INTERNAL_SERVER_ERROR');
      // #1789: a fault is the generic envelope (detail goes to the log), and never NOT_FOUND/FORBIDDEN (Pin 1).
      expect(result.errors![0]!.message).toBe('Internal server error.');
      expect(result.errors![0]!.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
      expect(await sideEffects()).toEqual(before);
    } finally {
      failure.mockRestore();
    }
  });

  it('a DB fault while resolving a read ref propagates as a fault, never as not-found', async () => {
    const failure = vi.spyOn(db.memory, 'findFirst').mockRejectedValueOnce(new Error('injected resolve db failure'));
    try {
      const result = await gql(key.outsider!, VALIDATE, { m: mem.knowledge!.urn });
      expect(code(result)).toBe('INTERNAL_SERVER_ERROR');
      // #1789: a fault is the generic envelope (detail goes to the log), and never NOT_FOUND/FORBIDDEN (Pin 1).
      expect(result.errors![0]!.message).toBe('Internal server error.');
      expect(result.errors![0]!.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
    } finally {
      failure.mockRestore();
    }
  });

  // Last: these succeed, so they change the side-effect baseline.
  it('the owner still re-drives failed embeddings and clones', async () => {
    const retry = await gql(key.owner!, RETRY, { m: mem.knowledge!.urn });
    expect(retry.errors).toBeUndefined();
    expect(retry.data!.retryFailedEmbeddings).toBe(1);
    const clone = await gql(key.owner!, CLONE, { m: mem.knowledge!.urn, t: `oracle-${suffix}::owner-clone` });
    expect(clone.errors, JSON.stringify(clone.errors)).toBeUndefined();
    expect(clone.data!.cloneMemory.id).toEqual(expect.any(String));
  });
});
