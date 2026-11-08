import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { requireMemoryWriteAccess } from './resolvers.helpers.js';
import { canWriteToMemory } from '../../../mcp/access-control.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

let server: Server;
let baseUrl: string;
let orgId: string;
let foreignOrgId: string;
let agentId: string;
const users: Record<string, string> = {};
const memories: Record<string, string> = {};
const ctx = (who: string): Context => ({ db, userId: users[who], roles: ['READER'] });

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'Auth A', urn: 'auth1795.example' } })).id;
  foreignOrgId = (await db.organization.create({ data: { id: generateId(), name: 'Auth B', urn: 'other1795.example' } })).id;
  for (const [name, role, organizationId] of [
    ['owner', 'ADMIN', orgId], ['contributor', 'CONTRIBUTOR', orgId], ['reader', 'READER', orgId],
    ['subscriber', 'CONTRIBUTOR', foreignOrgId], ['foreignAdmin', 'ADMIN', foreignOrgId],
  ] as const) {
    users[name] = (await db.user.create({ data: { id: generateId(), handle: `auth1795-${name.toLowerCase()}`, roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { organizationId, userId: users[name], role } });
  }
  agentId = (await db.agent.create({ data: { id: generateId(), urn: 'auth1795.example:agent', name: 'Agent', organizationId: orgId } })).id;
  for (const [name, cls] of [['definition', 'system'], ['ordinary', 'knowledge'], ['group', 'group']] as const) {
    memories[name] = (await db.memory.create({ data: {
      id: generateId(), urn: `auth1795.example:${name}`, name, class: cls,
      organizationId: orgId, visibility: cls === 'group' ? 'GROUP' : cls === 'system' ? null : 'ORGANIZATION',
    } })).id;
  }
  await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: memories.definition } });
  await db.node.create({ data: { id: generateId(), memoryId: memories.definition, loc: 'conversations:default', name: 'Default', data: { stageOrder: ['start'] } } });
  await db.node.create({ data: { id: generateId(), memoryId: memories.definition, loc: 'conversations:default:start', name: 'Start', content: 'Hello' } });
  await serveEveryAgent(db); // #2712: the chat is served the Agent's boot prompt
  // Provision through the shipped path, not a synthetic ownership shortcut.
  await resolvers.Mutation.startChat({}, { agentId }, ctx('owner'));
  memories.holding = (await db.memory.findFirstOrThrow({ where: { userMemoryOfAgentId: agentId, createdBy: users.owner } })).id;
  expect(await db.memory.findUniqueOrThrow({ where: { id: memories.holding } })).toMatchObject({ class: 'knowledge', appId: null, ownerUserId: null, userId: null });
  for (const memoryId of Object.values(memories)) {
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'existing', name: 'Original', content: 'Original' } });
  }
});

describe('#1795 shared authorization', () => {
  it('GraphQL and MCP agree on ordinary org and group writer grants', async () => {
    const agrees = async (who: string, key: string, expected: boolean) => {
      const graphql = await requireMemoryWriteAccess(ctx(who), memories[key]).then(() => true, (error) => {
        expect(error.extensions?.code).toBe('FORBIDDEN');
        return false;
      });
      const mcp = await canWriteToMemory(db, { userId: users[who], roles: ['READER'] }, memories[key]);
      expect({ graphql, mcp }).toEqual({ graphql: expected, mcp: expected });
    };
    await agrees('contributor', 'ordinary', true);
    await agrees('reader', 'ordinary', false);
    await agrees('contributor', 'group', false);
    await db.memoryMember.create({ data: { memoryId: memories.group, userId: users.reader, role: 'writer' } });
    await agrees('reader', 'group', true);
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: users.contributor } }, data: { deletedAt: new Date() } });
    await agrees('contributor', 'ordinary', false);
  });
  it.each(['definition', 'holding'])('org contributor cannot write %s', async (key) => {
    await expect(requireMemoryWriteAccess(ctx('contributor'), memories[key])).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it.each(['definition', 'holding'])('a subscription cannot grant %s writes', async (key) => {
    await db.memorySubscription.create({ data: { id: generateId(), memoryId: memories[key], organizationId: foreignOrgId, role: 'CONTRIBUTOR' } });
    await expect(requireMemoryWriteAccess(ctx('subscriber'), memories[key])).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('a revoked ordinary subscription grants nothing', async () => {
    await db.memorySubscription.create({ data: { id: generateId(), memoryId: memories.ordinary, organizationId: foreignOrgId, role: 'CONTRIBUTOR', deletedAt: new Date() } });
    await expect(requireMemoryWriteAccess(ctx('subscriber'), memories.ordinary)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('ordinary contributor and live subscription writes are preserved', async () => {
    await expect(requireMemoryWriteAccess(ctx('contributor'), memories.ordinary)).resolves.toBeUndefined();
    await db.memorySubscription.create({ data: { id: generateId(), memoryId: memories.ordinary, organizationId: foreignOrgId, role: 'CONTRIBUTOR' } });
    await expect(requireMemoryWriteAccess(ctx('subscriber'), memories.ordinary)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctx('reader'), memories.ordinary)).rejects.toThrow();
  });

  it('org admin writes its definition, foreign admin cannot', async () => {
    await expect(requireMemoryWriteAccess(ctx('owner'), memories.definition)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctx('foreignAdmin'), memories.definition)).rejects.toThrow();
  });

  it('group membership stays exclusive, even with a subscription', async () => {
    await expect(requireMemoryWriteAccess(ctx('contributor'), memories.group)).rejects.toThrow();
    await db.memoryMember.create({ data: { memoryId: memories.group, userId: users.reader, role: 'writer' } });
    await expect(requireMemoryWriteAccess(ctx('reader'), memories.group)).resolves.toBeUndefined();
    await db.memorySubscription.create({ data: { id: generateId(), memoryId: memories.group, organizationId: foreignOrgId, role: 'CONTRIBUTOR' } });
    await expect(requireMemoryWriteAccess(ctx('subscriber'), memories.group)).rejects.toThrow();
  });

  it('the creator keeps authoring access without an org contributor grant', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: users.owner } }, data: { role: 'READER' } });
    await expect(requireMemoryWriteAccess(ctx('owner'), memories.holding)).resolves.toBeUndefined();
  });

  it('an org admin cannot write a different creator holding', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: users.contributor } }, data: { role: 'ADMIN' } });
    await expect(requireMemoryWriteAccess(ctx('contributor'), memories.holding)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('an impersonated creator cannot use the creator branch', async () => {
    await expect(requireMemoryWriteAccess({ ...ctx('owner'), impersonation: { orgId } as never }, memories.holding)).rejects.toThrow();
  });

  it('null creator and revoked membership never supply an owner or grant', async () => {
    await db.memory.update({ where: { id: memories.holding }, data: { createdBy: null } });
    await expect(requireMemoryWriteAccess(ctx('owner'), memories.holding)).rejects.toThrow();
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: users.contributor } }, data: { deletedAt: new Date() } });
    await expect(requireMemoryWriteAccess(ctx('contributor'), memories.ordinary)).rejects.toThrow();
  });

  it('strict ownership and user-owned definition controls remain', async () => {
    const strict = await db.memory.create({ data: { id: generateId(), urn: 'auth1795.example:strict', name: 'Strict', class: 'private', organizationId: orgId, userId: users.owner } });
    await expect(requireMemoryWriteAccess({ ...ctx('contributor'), roles: ['ADMIN'] }, strict.id)).rejects.toThrow();
    await expect(requireMemoryWriteAccess(ctx('owner'), strict.id)).resolves.toBeUndefined();
    const owned = await db.memory.create({ data: { id: generateId(), urn: 'auth1795-owner:definition', name: 'Owned', class: 'system', ownerUserId: users.owner } });
    await expect(requireMemoryWriteAccess(ctx('owner'), owned.id)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctx('contributor'), owned.id)).rejects.toThrow();
  });
});

describe('#1795 public GraphQL boundary', () => {
  it('a narrowed contributor read conceals another creator holding while its creator still reads', async () => {
    const node = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: memories.holding, loc: 'existing' } } });
    for (const who of ['contributor', 'owner']) {
      const { rawKey } = await mintUserApiKey(db, { userId: users[who], label: null, createdBy: users[who], issuedVia: 'test' });
      const response = await fetch(`${baseUrl}/graphql`, {
        method: 'POST', headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query($ref: ID!) { node(ref: $ref) { id content } }', variables: { ref: node.id } }),
      });
      const body = await response.json() as { errors?: unknown; data?: { node: { id: string; content: string } | null } };
      expect(response.status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect(body.data?.node).toEqual(who === 'owner' ? { id: node.id, content: 'Original' } : null);
    }
  });
  it('the admitted creator path works over the real HTTP boundary', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: users.owner } }, data: { role: 'READER' } });
    const { rawKey } = await mintUserApiKey(db, { userId: users.owner, label: null, createdBy: users.owner, issuedVia: 'test' });
    const response = await fetch(`${baseUrl}/graphql`, {
      method: 'POST', headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'mutation($input: CreateNodeInput!) { createNode(input: $input) { id } }', variables: { input: { memoryId: memories.holding, loc: 'owner-authored', name: 'Owner authored' } } }),
    });
    const body = await response.json() as { errors?: unknown; data?: { createNode?: { id: string } } };
    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data?.createNode?.id).toEqual(expect.any(String));
    expect(await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: memories.holding, loc: 'owner-authored' } } })).toMatchObject({ createdBy: users.owner });
  });

  it.each([
    ['definition', 'createNode', 'new'], ['definition', 'updateNode', 'existing'],
    ['holding', 'createNode', 'new'], ['holding', 'updateNode', 'existing'],
  ])('%s %s is refused over HTTP with no state change', async (key, field, loc) => {
    const memoryId = memories[key];
    const { rawKey } = await mintUserApiKey(db, { userId: users.contributor, label: null, createdBy: users.contributor, issuedVia: 'test' });
      const response = await fetch(`${baseUrl}/graphql`, {
        method: 'POST', headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: `mutation($input: ${field === 'createNode' ? 'CreateNodeInput' : 'UpdateNodeInput'}!) { ${field}(input: $input) { id } }`, variables: { input: { memoryId, loc, name: 'Changed', content: 'Changed' } } }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { errors?: Array<{ extensions?: { code?: string } }>; data?: Record<string, unknown> };
      // #1807: an uninstalled contributor cannot open the system record;
      // conceal it rather than distinguishing its write refusal.
      expect(body.errors?.[0]?.extensions?.code).toBe(key === 'definition' ? 'MEMORY_NOT_FOUND' : 'FORBIDDEN');
      expect(body.data?.[field]).toBeFalsy();
    expect(await db.node.count({ where: { memoryId, loc: 'new' } })).toBe(0);
    expect(await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId, loc: 'existing' } } })).toMatchObject({ name: 'Original', content: 'Original' });
  });
});
