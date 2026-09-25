/**
 * #1312 — the governed spec doors accept every generically-valid loc shape.
 *
 * This is deliberately an on-the-wire audit fixture rather than a new spec
 * framework: real HTTP, a real UserApiKey, and the same createSpecNode /
 * updateSpecNode mutations the CLI routes through. The matrix covers the old
 * citation-looking shape, shallower and deeper shapes, and atoms that are
 * valid under the generic loc grammar without looking like a numbered tier.
 *
 * #1316 deliberately extends this same fixture: #1312 originally pinned an
 * outsider's existing-target answer as FORBIDDEN, which exposed the memory's
 * existence beside a missing-target control. The paired wire assertions below
 * compare the complete response after replacing only the caller-supplied ref.
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

const CREATE_SPEC = `mutation($input: CreateNodeInput!) {
  createSpecNode(input: $input) { id loc name role content data }
}`;
const UPDATE_SPEC = `mutation($input: UpdateNodeInput!) {
  updateSpecNode(input: $input) { id loc name role content data }
}`;
const CREATE_NODE = `mutation($input: CreateNodeInput!) {
  createNode(input: $input) { id }
}`;
const UPDATE_NODE = `mutation($input: UpdateNodeInput!) {
  updateNode(input: $input) { id }
}`;
const READ_MEMORY = `query($ref: ID!) {
  memory(ref: $ref) { id name }
}`;

let server: Server;
let baseUrl: string;
let memoryId: string;
let memoryUrn: string;
let missingMemoryUrn: string;
let sharedMemoryId: string;
let anchorId: string;
let recordOnlyMemoryId: string;
let recordOnlyNodeId: string;
const key: Record<string, string> = {};

async function gql(k: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: Record<string, any> | null; errors?: GqlError[] };
  return { status: response.status, data: body.data, errors: body.errors };
}

const expectCode = (result: Gql, code: string) => {
  expect(result.status).toBe(200);
  expect(result.errors).toHaveLength(1);
  expect(result.errors![0]!.extensions?.code).toBe(code);
};

beforeAll(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: 'spec hierarchy audit', urn: `spec-hierarchy-${suffix}` },
  });
  const owner = await db.user.create({
    data: { id: generateId(), handle: `owner-${suffix}`, githubUsername: `owner-${suffix}` },
  });
  const reader = await db.user.create({
    data: { id: generateId(), handle: `reader-${suffix}`, githubUsername: `reader-${suffix}` },
  });
  const outsider = await db.user.create({
    data: { id: generateId(), handle: `outsider-${suffix}`, githubUsername: `outsider-${suffix}` },
  });
  const grantee = await db.user.create({
    data: { id: generateId(), handle: `grantee-${suffix}`, githubUsername: `grantee-${suffix}` },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
  const otherOrg = await db.organization.create({
    data: { id: generateId(), name: 'other org', urn: `spec-hierarchy-other-${suffix}` },
  });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });

  const mint = async (userId: string, label: string, oauthScopes: OAuthScope[]) =>
    (await mintUserApiKey(db, { userId, label, createdBy: userId, issuedVia: 'test', oauthScopes })).rawKey;
  key.owner = await mint(owner.id, 'owner', ['account']);
  key.reader = await mint(reader.id, 'reader', ['account']);
  key.outsider = await mint(outsider.id, 'outsider', ['account']);
  key.grantee = await mint(grantee.id, 'grantee', ['account']);

  const sharedMemory = await db.memory.create({
    data: {
      id: generateId(),
      urn: `shared-${suffix}`,
      name: 'writer-shared personal memory',
      class: 'personal',
      visibility: null,
      userId: owner.id,
      ownerUserId: owner.id,
    },
  });
  sharedMemoryId = sharedMemory.id;
  await db.memoryShare.create({
    data: { memoryId: sharedMemory.id, granteeId: grantee.id, grantorId: owner.id, role: 'writer' },
  });

  // An org member may open this system Memory RECORD, but the shared
  // node-content gate deliberately excludes its nodes. This pins the distinct
  // gate update-by-id needs when classifying an ordinary write denial.
  const recordOnlyMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:record-only-system`,
      name: 'record-readable, nodes-unreadable system memory',
      class: 'system',
      visibility: null,
      acceptsUploads: false,
    },
  });
  recordOnlyMemoryId = recordOnlyMemory.id;
  const recordOnlyNode = await db.node.create({
    data: {
      id: generateId(),
      memoryId: recordOnlyMemory.id,
      loc: 'private:node',
      name: 'must stay concealed',
    },
  });
  recordOnlyNodeId = recordOnlyNode.id;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const memory = await gql(
    key.owner!,
    `mutation($orgId: ID!, $name: String!) { createMemory(orgId: $orgId, name: $name) { id urn } }`,
    { orgId: org.id, name: `spec-hierarchy-${suffix}` },
  );
  expect(memory.errors, JSON.stringify(memory.errors)).toBeUndefined();
  memoryId = memory.data!.createMemory.id;
  memoryUrn = memory.data!.createMemory.urn;
  missingMemoryUrn = `${memoryUrn}-missing`;

  const anchor = await gql(key.owner!, CREATE_SPEC, {
    input: { memoryId, loc: 'anchor', name: 'edge anchor', role: 'spec' },
  });
  expect(anchor.errors, JSON.stringify(anchor.errors)).toBeUndefined();
  anchorId = anchor.data!.createSpecNode.id;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('#1312 — hierarchy-neutral governed spec doors', () => {
  const shapes = [
    ['legacy citation-shaped', 'app:onb:010:01'],
    ['shallow', 'policy'],
    ['deeper than the legacy shape', 'product:area:feature:rule:detail:leaf'],
    ['non-tier-shaped generic atoms', 'screen.flow:phase_two:alpha-1'],
  ] as const;

  for (const [label, loc] of shapes) {
    it(`creates and updates a ${label} loc without changing identity or supplied edges`, async () => {
      const created = await gql(key.owner!, CREATE_SPEC, {
        input: {
          memoryId,
          loc,
          name: `created ${label}`,
          role: 'spec',
          content: 'first body',
          data: { version: '0.0.1', shape: label },
          edges: [{ targetId: anchorId, name: 'evidence-for' }],
        },
      });
      expect(created.status).toBe(200);
      expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
      expect(created.data!.createSpecNode).toMatchObject({
        loc,
        name: `created ${label}`,
        role: 'spec',
        content: 'first body',
        data: { version: '0.0.1', shape: label },
      });
      const id = created.data!.createSpecNode.id as string;
      expect(await db.edge.findMany({ where: { sourceId: id, deletedAt: null } })).toEqual([
        expect.objectContaining({ sourceId: id, targetId: anchorId, name: 'evidence-for' }),
      ]);

      const updated = await gql(key.owner!, UPDATE_SPEC, {
        input: {
          id,
          name: `updated ${label}`,
          content: 'second body',
          data: { version: '0.0.2', shape: label },
          edges: [{ targetId: anchorId, name: 'still-evidence-for' }],
        },
      });
      expect(updated.status).toBe(200);
      expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();
      expect(updated.data!.updateSpecNode).toMatchObject({
        id,
        loc,
        name: `updated ${label}`,
        role: 'spec',
        content: 'second body',
        data: { version: '0.0.2', shape: label },
      });
      expect(await db.edge.findMany({ where: { sourceId: id, deletedAt: null } })).toEqual([
        expect.objectContaining({ sourceId: id, targetId: anchorId, name: 'still-evidence-for' }),
      ]);
    });
  }

  it('keeps the ordinary denial for a reader who can see the memory but cannot write', async () => {
    const loc = 'denied:reader';
    const read = await gql(key.reader!, READ_MEMORY, { ref: memoryUrn });
    expect(read.errors).toBeUndefined();
    expect(read.data!.memory.id).toBe(memoryId);

    const create = await gql(key.reader!, CREATE_SPEC, {
      input: { memoryId: memoryUrn, loc, name: 'must not exist', role: 'spec' },
    });
    expectCode(create, 'FORBIDDEN');
    expect(await db.node.findFirst({ where: { memoryId, loc } })).toBeNull();

    const update = await gql(key.reader!, UPDATE_SPEC, {
      input: { id: anchorId, content: 'must not land' },
    });
    expectCode(update, 'FORBIDDEN');
    expect((await db.node.findUniqueOrThrow({ where: { id: anchorId } })).content).toBeNull();
  });

  it('preserves legitimate writer-share read and write access', async () => {
    const read = await gql(key.grantee!, READ_MEMORY, { ref: sharedMemoryId });
    expect(read.errors).toBeUndefined();
    expect(read.data!.memory.id).toBe(sharedMemoryId);

    const create = await gql(key.grantee!, CREATE_NODE, {
      input: { memoryId: sharedMemoryId, loc: 'shared:writer', name: 'allowed' },
    });
    expect(create.errors, JSON.stringify(create.errors)).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: create.data!.createNode.id } })).toEqual(
      expect.objectContaining({ memoryId: sharedMemoryId, loc: 'shared:writer' }),
    );
  });

  describe('#1316 — an outsider gets the same answer for unreadable and missing targets', () => {
    const normalizeSentRef = (result: Gql, sentRef: string) =>
      JSON.parse(JSON.stringify(result).replaceAll(sentRef, '<sent-ref>'));

    it('memory(ref:) returns the same bare null for an unreadable URN and a missing URN', async () => {
      const existing = await gql(key.outsider!, READ_MEMORY, { ref: memoryUrn });
      const missing = await gql(key.outsider!, READ_MEMORY, { ref: missingMemoryUrn });

      expect(existing).toEqual(missing);
      expect(existing).toEqual({ status: 200, data: { memory: null }, errors: undefined });
    });

    for (const [surface, mutation, role] of [
      ['createNode', CREATE_NODE, undefined],
      ['createSpecNode', CREATE_SPEC, 'spec'],
    ] as const) {
      it(`${surface} conceals an unreadable memory exactly like a missing memory`, async () => {
        const loc = `oracle:${surface.toLowerCase()}`;
        const input = (ref: string) => ({
          memoryId: ref,
          loc,
          name: 'must not exist',
          ...(role ? { role } : {}),
          edges: [{ targetId: anchorId, name: 'must-not-land' }],
        });
        const edgesBefore = await db.edge.count();
        const existing = await gql(key.outsider!, mutation, { input: input(memoryUrn) });
        const missing = await gql(key.outsider!, mutation, { input: input(missingMemoryUrn) });

        expect(normalizeSentRef(existing, memoryUrn)).toEqual(
          normalizeSentRef(missing, missingMemoryUrn),
        );
        expectCode(existing, 'MEMORY_NOT_FOUND');
        expect(await db.node.findFirst({ where: { memoryId, loc } })).toBeNull();
        expect(await db.edge.count()).toBe(edgesBefore);
      });
    }

    for (const [surface, mutation] of [
      ['updateNode', UPDATE_NODE],
      ['updateSpecNode', UPDATE_SPEC],
    ] as const) {
      it(`${surface} conceals an unreadable node exactly like a missing node`, async () => {
        const missingNodeId = generateId();
        const input = (id: string) => ({
          id,
          content: 'must not land',
          edges: [{ targetId: anchorId, name: 'must-not-land' }],
        });
        const edgesBefore = await db.edge.count();
        const existing = await gql(key.outsider!, mutation, { input: input(anchorId) });
        const missing = await gql(key.outsider!, mutation, { input: input(missingNodeId) });

        expect(normalizeSentRef(existing, anchorId)).toEqual(
          normalizeSentRef(missing, missingNodeId),
        );
        expectCode(existing, 'NODE_NOT_FOUND');
        expect((await db.node.findUniqueOrThrow({ where: { id: anchorId } })).content).toBeNull();
        expect(await db.edge.count()).toBe(edgesBefore);
      });
    }

    // The (memoryId, loc) selector resolves the MEMORY first and runs the write
    // gate before any node lookup, so its not-found is the memory's. A missing
    // memory answers MEMORY_NOT_FOUND from resolveMemoryRef, before any gate;
    // relabeling an unreadable one NODE_NOT_FOUND would make the two
    // distinguishable, which is the oracle this PR closes (@copilot, PR #1319).
    for (const [surface, mutation] of [
      ['updateNode', UPDATE_NODE],
      ['updateSpecNode', UPDATE_SPEC],
    ] as const) {
      it(`${surface} by (memoryId, loc) conceals an unreadable memory exactly like a missing one`, async () => {
        const input = (ref: string, loc: string) => ({
          memoryId: ref,
          loc,
          content: 'must not land',
          edges: [{ targetId: anchorId, name: 'must-not-land' }],
        });
        const edgesBefore = await db.edge.count();
        const existing = await gql(key.outsider!, mutation, { input: input(memoryUrn, 'anchor') });
        const missing = await gql(key.outsider!, mutation, { input: input(missingMemoryUrn, 'anchor') });
        const missingLoc = await gql(key.outsider!, mutation, {
          input: input(memoryUrn, 'oracle:no-such-loc'),
        });

        expect(normalizeSentRef(existing, memoryUrn)).toEqual(
          normalizeSentRef(missing, missingMemoryUrn),
        );
        // The loc is never looked up for a caller the gate refuses.
        expect(existing).toEqual(missingLoc);
        expectCode(existing, 'MEMORY_NOT_FOUND');
        expect((await db.node.findUniqueOrThrow({ where: { id: anchorId } })).content).toBeNull();
        expect(await db.edge.count()).toBe(edgesBefore);
      });
    }

    it('update by (memoryId, loc) answers an existing and a missing loc alike when only the record is readable', async () => {
      // This caller may read the Memory RECORD, so its existence is not a
      // secret from them; what must not leak is which locs exist. The write
      // gate refuses before the node lookup, so both answer the same.
      const input = (loc: string) => ({ memoryId: recordOnlyMemoryId, loc, content: 'must not land' });
      const existing = await gql(key.reader!, UPDATE_NODE, { input: input('private:node') });
      const missing = await gql(key.reader!, UPDATE_NODE, { input: input('private:no-such-node') });

      expect(existing).toEqual(missing);
      expectCode(existing, 'FORBIDDEN');
      expect((await db.node.findUniqueOrThrow({ where: { id: recordOnlyNodeId } })).content).toBeNull();
    });

    it('uses the node-content gate when the Memory record is readable but its nodes are not', async () => {
      const read = await gql(key.reader!, READ_MEMORY, { ref: recordOnlyMemoryId });
      expect(read.errors).toBeUndefined();
      expect(read.data!.memory.id).toBe(recordOnlyMemoryId);

      const missingNodeId = generateId();
      const existing = await gql(key.reader!, UPDATE_NODE, {
        input: { id: recordOnlyNodeId, content: 'must not land' },
      });
      const missing = await gql(key.reader!, UPDATE_NODE, {
        input: { id: missingNodeId, content: 'must not land' },
      });

      expect(normalizeSentRef(existing, recordOnlyNodeId)).toEqual(
        normalizeSentRef(missing, missingNodeId),
      );
      expectCode(existing, 'NODE_NOT_FOUND');
      expect((await db.node.findUniqueOrThrow({ where: { id: recordOnlyNodeId } })).content).toBeNull();
    });

    it('does not disguise malformed refs or internal DB faults as not-found', async () => {
      const malformed = await gql(key.outsider!, CREATE_SPEC, {
        input: { memoryId: 'relative-memory', loc: 'oracle:malformed', name: 'bad', role: 'spec' },
      });
      expectCode(malformed, 'URN_NOT_QUALIFIED');

      const failure = vi.spyOn(db.memory, 'findUnique').mockRejectedValueOnce(new Error('injected db failure'));
      try {
        const fault = await gql(key.owner!, READ_MEMORY, { ref: memoryUrn });
        expectCode(fault, 'INTERNAL_SERVER_ERROR');
      } finally {
        failure.mockRestore();
      }

      const writeFailure = vi
        .spyOn(db.memory, 'findUnique')
        .mockRejectedValueOnce(new Error('injected write-gate db failure'));
      try {
        const fault = await gql(key.outsider!, CREATE_SPEC, {
          input: { memoryId: memoryUrn, loc: 'oracle:db-fault', name: 'must not exist', role: 'spec' },
        });
        expectCode(fault, 'INTERNAL_SERVER_ERROR');
        expect(await db.node.findFirst({ where: { memoryId, loc: 'oracle:db-fault' } })).toBeNull();
      } finally {
        writeFailure.mockRestore();
      }
    });
  });

  it('keeps the role-governed boundary: generic createNode cannot mint a spec', async () => {
    const result = await gql(key.owner!, CREATE_NODE, {
      input: { memoryId, loc: 'generic:must-refuse', name: 'must not exist', role: 'spec' },
    });
    expectCode(result, 'ROLE_GOVERNED');
    expect(await db.node.findFirst({ where: { memoryId, loc: 'generic:must-refuse' } })).toBeNull();
  });

  it('still rejects a loc that fails the generic loc grammar', async () => {
    const result = await gql(key.owner!, CREATE_SPEC, {
      input: { memoryId, loc: 'bad::loc', name: 'must not exist', role: 'spec' },
    });
    expectCode(result, 'InvalidLocError');
    expect(await db.node.findFirst({ where: { memoryId, loc: 'bad::loc' } })).toBeNull();
  });

  it('still rejects duplicate identity and leaves the original untouched', async () => {
    const input = { memoryId, loc: 'duplicate', name: 'original', role: 'spec' };
    const first = await gql(key.owner!, CREATE_SPEC, { input });
    expect(first.errors, JSON.stringify(first.errors)).toBeUndefined();
    const originalId = first.data!.createSpecNode.id as string;

    const duplicate = await gql(key.owner!, CREATE_SPEC, {
      input: { ...input, name: 'replacement' },
    });
    expectCode(duplicate, 'NodeLocConflictError');
    expect(await db.node.findMany({ where: { memoryId, loc: 'duplicate' } })).toEqual([
      expect.objectContaining({ id: originalId, name: 'original', deletedAt: null }),
    ]);
  });

  it('resolves explicit edge targets before writing, so a missing target is atomic', async () => {
    const loc = 'atomic:missing-target';
    const result = await gql(key.owner!, CREATE_SPEC, {
      input: {
        memoryId,
        loc,
        name: 'must not exist',
        role: 'spec',
        edges: [{ targetId: 'nowhere:missing', name: 'evidence-for' }],
      },
    });
    expectCode(result, 'NodeNotFoundError');
    expect(result.errors![0]!.message).toMatch(/Edge target not found/);
    // No row at all, tombstones included: this proves transaction rollback,
    // not merely that the read surface hides a partially-created node.
    expect(await db.node.findFirst({ where: { memoryId, loc } })).toBeNull();
  });
});
