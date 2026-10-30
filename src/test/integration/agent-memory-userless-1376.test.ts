/**
 * #1376 (R201, cor:dmo:050:09) — an AgentMemoryItem never admits a credential-only principal.
 *
 * An item is a limit, never a grant: a userless App key (no user behind it) reaches org-owned knowledge only by
 * its own read access, never because its Agent carries an item. #1349 capped what an item may reach to the
 * Agent's own tenant; this pins the other half, that the tenant's own memory is not reached by a key through the
 * fold either. Every case seeds the item directly, as a row minted before any attach gate.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { getPrincipalAppMemoryAccess } from '../../mcp/access-control.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

type Gql = { data: Record<string, any> | null | undefined; errors: Array<{ message: string }> | undefined };

const READ = `query($r: ID!) { node(ref: $r) { content } }`;
const WRITE = `mutation($i: UpdateNodeInput!) { updateNode(input: $i) { id } }`;
const LIST = `query($m: ID!) { memoryNodes(memoryRef: $m) { total } }`;

let server: Server;
let baseUrl: string;
let suffix: string;
let homeOrgId: string;
const mem: Record<string, { id: string; urn: string; nodeId: string; content: string }> = {};

async function gql(key: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: Record<string, any> | null; errors?: Gql['errors'] };
  return { data: body.data, errors: body.errors };
}

/** A fresh agent in a fresh App of the HOME org, linked to `target` by a legacy item row. */
async function link(target: string, role: string) {
  const label = `${target}-${role}-${Math.floor(Math.random() * 1e9)}`;
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: homeOrgId, name: label, urn: `ag-${label}-${suffix}` } as never,
  });
  const { app, rawKey } = await createDbAppWithKey(db, `app-${label}`, homeOrgId);
  await createDbAppAgent(db, app.id, agent.id);
  await db.agentMemoryItem.create({
    data: { id: generateId(), agentId: agent.id, memoryId: mem[target]!.id, role } as never,
  });
  return { appId: app.id, agentId: agent.id, appKey: rawKey };
}

const reads = async (key: string, target: string) =>
  (await gql(key, READ, { r: mem[target]!.nodeId })).data?.node?.content ?? null;
const lists = async (key: string, target: string) =>
  ((await gql(key, LIST, { m: mem[target]!.urn })).data?.memoryNodes?.total ?? 0) > 0;

async function writes(key: string, target: string) {
  const r = await gql(key, WRITE, { i: { id: mem[target]!.nodeId, content: `tampered-${Math.random()}` } });
  const after = await db.node.findUniqueOrThrow({ where: { id: mem[target]!.nodeId } });
  if (r.errors) expect(after.content).toBe(mem[target]!.content);
  else await db.node.update({ where: { id: after.id }, data: { content: mem[target]!.content } });
  return !r.errors;
}

const nodeUrn = (target: string) => `hrn:node:${mem[target]!.urn.replace(/^hrn:mem:/, '')}:payroll`;
const mcpFor = (auth: { appId: string; userId?: string }) =>
  createTestableMcpServer({ ...auth, roles: ['READER'] } as never);

async function mcpReads(auth: { appId: string; userId?: string }, target: string) {
  return (await mcpFor(auth).callToolText('hadron_get_node', { urn: nodeUrn(target) })).includes(mem[target]!.content);
}

async function mcpWrites(auth: { appId: string; userId?: string }, target: string) {
  await mcpFor(auth).callToolText('hadron_update_node', { urn: nodeUrn(target), content: 'mcp-tampered' });
  const after = await db.node.findUniqueOrThrow({ where: { id: mem[target]!.nodeId } });
  const wrote = after.content === 'mcp-tampered';
  if (wrote) await db.node.update({ where: { id: after.id }, data: { content: mem[target]!.content } });
  return wrote;
}

beforeAll(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const home = await db.organization.create({ data: { id: generateId(), name: 'home', urn: `home-${suffix}` } });
  homeOrgId = home.id;
  const mkMem = async (label: string, data: Record<string, unknown>) => {
    const m = await db.memory.create({ data: { id: generateId(), urn: `${home.urn}:${label}`, name: label, ...data } as never });
    const content = `${label} SECRET`;
    const n = await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'payroll', name: 'p', content } });
    mem[label] = { id: m.id, urn: `hrn:mem:${home.urn}:${label}`, nodeId: n.id, content };
  };
  await mkMem('homeOrg', { organizationId: home.id, class: 'knowledge', visibility: 'ORGANIZATION' });
  await mkMem('homeGroup', { organizationId: home.id, class: 'group', visibility: 'GROUP' });
  await mkMem('homePublic', { organizationId: home.id, class: 'knowledge', visibility: 'PUBLIC' });

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('#1376 — a userless App key is not admitted by its Agent’s item', () => {
  it.each(['read', 'read-write'])('the home tenant’s ORGANIZATION knowledge, %s item: no read, list or write over GraphQL', async (role) => {
    const { appKey } = await link('homeOrg', role);
    expect(await reads(appKey, 'homeOrg')).toBeNull();
    expect(await lists(appKey, 'homeOrg')).toBe(false);
    expect(await writes(appKey, 'homeOrg')).toBe(false);
  });

  it.each(['read', 'read-write'])('the same, over MCP, %s item', async (role) => {
    const { appId } = await link('homeOrg', role);
    expect(await mcpReads({ appId }, 'homeOrg')).toBe(false);
    expect(await mcpWrites({ appId }, 'homeOrg')).toBe(false);
  });

  it('a group memory of the home tenant is not admitted either', async () => {
    const { appId, appKey } = await link('homeGroup', 'read-write');
    expect(await reads(appKey, 'homeGroup')).toBeNull();
    expect(await writes(appKey, 'homeGroup')).toBe(false);
    expect((await getPrincipalAppMemoryAccess(db, { appId })).has(mem.homeGroup!.id)).toBe(false);
  });

  it('the principal-level access map holds no item-derived entry', async () => {
    const { appId } = await link('homeOrg', 'read-write');
    expect((await getPrincipalAppMemoryAccess(db, { appId })).has(mem.homeOrg!.id)).toBe(false);
  });

  it('PUBLIC knowledge is no exception: a key with no item cannot read it, so the item adds none', async () => {
    const bare = await createDbAppWithKey(db, `bare-${generateId()}`, homeOrgId);
    expect(await reads(bare.rawKey, 'homePublic')).toBeNull();
    const { appId, appKey } = await link('homePublic', 'read-write');
    expect(await reads(appKey, 'homePublic')).toBeNull();
    expect(await mcpReads({ appId }, 'homePublic')).toBe(false);
    expect(await writes(appKey, 'homePublic')).toBe(false);
    expect(await mcpWrites({ appId }, 'homePublic')).toBe(false);
  });

  it('the Agent’s own system memory still folds for the key (it is not an item)', async () => {
    const { appId, agentId } = await link('homeOrg', 'read');
    const sys = await db.memory.create({
      data: { id: generateId(), urn: `home-${suffix}:sys-${generateId()}`, name: 'sys', organizationId: homeOrgId, class: 'system' } as never,
    });
    await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: sys.id } as never });
    expect((await getPrincipalAppMemoryAccess(db, { appId })).get(sys.id)).toBe('READ_ONLY');
  });
});

describe('#1376 — a request with a user behind it keeps the fold', () => {
  it('an App member (no org role) reaches the item’s memory through the App, as before', async () => {
    const user = await db.user.create({ data: { id: generateId(), handle: `m-${generateId()}`, githubUsername: `m-${generateId()}` } });
    const { appId, appKey } = await link('homeOrg', 'read-write');
    await createDbAppMember(db, appId, user.id, 'member');
    expect((await getPrincipalAppMemoryAccess(db, { appId, userId: user.id })).get(mem.homeOrg!.id)).toBe('READ_WRITE');
    expect(await mcpReads({ appId, userId: user.id }, 'homeOrg')).toBe(true);
    // the same App's key without the user is still refused
    expect(await reads(appKey, 'homeOrg')).toBeNull();
  });
});
