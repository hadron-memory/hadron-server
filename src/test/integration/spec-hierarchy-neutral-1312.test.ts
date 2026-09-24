/**
 * #1312 — the governed spec doors accept every generically-valid loc shape.
 *
 * This is deliberately an on-the-wire audit fixture rather than a new spec
 * framework: real HTTP, a real UserApiKey, and the same createSpecNode /
 * updateSpecNode mutations the CLI routes through. The matrix covers the old
 * citation-looking shape, shallower and deeper shapes, and atoms that are
 * valid under the generic loc grammar without looking like a numbered tier.
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

let server: Server;
let baseUrl: string;
let memoryId: string;
let anchorId: string;
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

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const memory = await gql(
    key.owner!,
    `mutation($orgId: ID!, $name: String!) { createMemory(orgId: $orgId, name: $name) { id } }`,
    { orgId: org.id, name: `spec-hierarchy-${suffix}` },
  );
  expect(memory.errors, JSON.stringify(memory.errors)).toBeUndefined();
  memoryId = memory.data!.createMemory.id;

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

  it('keeps authorization intact for both create and update', async () => {
    for (const [caller, loc] of [
      [key.reader!, 'denied:reader'],
      [key.outsider!, 'denied:outsider'],
    ] as const) {
      const create = await gql(caller, CREATE_SPEC, {
        input: { memoryId, loc, name: 'must not exist', role: 'spec' },
      });
      expectCode(create, 'FORBIDDEN');
      expect(await db.node.findFirst({ where: { memoryId, loc } })).toBeNull();

      const update = await gql(caller, UPDATE_SPEC, {
        input: { id: anchorId, content: 'must not land' },
      });
      expectCode(update, 'FORBIDDEN');
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: anchorId } })).content).toBeNull();
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
