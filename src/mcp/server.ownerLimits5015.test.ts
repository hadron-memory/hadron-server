/**
 * #5015 (Billing A7b, cor:acl:150:04): the MCP doors that add a live node refuse at the owner's `nodes` limit, over the real
 * Streamable HTTP transport (the envelope a client reads, not the handler's return value). One case per door the issue names
 * for MCP: hadron_create_node (plain and the tombstone revive), hadron_create_parent_node, hadron_create_task (a governed
 * kind door), hadron_move_node (one node, and a subtree), hadron_restore_node and hadron_sync_graph. Each refusal writes nothing and its text carries the code.
 *
 * RED on main: every "refuses" case wrote the node (no MCP door called `requireNodeHeadroom`), and hadron_sync_graph had no
 * owner-limit branch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { signJwt } from '../auth/jwt.js';
import { OWNER_LIMIT_NO_NUMBER_MESSAGE, OwnerLimitReachedError } from '../lib/ownerLimits/errors.js';
import { reloadOwnerDefaultLimitsForTests } from '../lib/ownerLimits/defaults.js';
import { OWNER_LIMIT_KEYS } from '../lib/ownerLimits/keys.js';
import type { OwnerRef } from '../lib/owner.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const sync = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../integrations/github/syncGraphFromGithub.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/github/syncGraphFromGithub.js')>()),
  syncGraphFromGithub: sync.fn,
}));

let server: Server;
let base: string;
beforeAll(async () => {
  server = httpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });

const ORG = 'mcp5015-org';
let u: string, orgId: string, mO: string, mU: string;
const urnO = (loc: string) => `hrn:node:${ORG}:o:${loc}`;
const urnU = (loc: string) => `hrn:node:mcp5015-u:private:${loc}`;
const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...extra } });
async function capAtCurrent(owner: OwnerRef) {
  const limitValue = await OWNER_LIMIT_KEYS.nodes.count(db, owner);
  await db.ownerLimit.create({
    data: { id: generateId(), ...('userId' in owner ? { ownerUserId: owner.userId } : { organizationId: owner.organizationId }),
      key: 'nodes', limitValue, sourceType: 'manual', sourceId: 't', note: 't' },
  });
  return limitValue;
}

let client: Client;
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: (r.content as Array<{ text: string }>).map(c => c.text).join('\n') };
}
const REFUSAL = /^\[owner_limit_reached\] This organization has reached its limit of \d+ nodes?\.$/;
const REFUSAL_USER = /^\[owner_limit_reached\] Your account has reached its limit of \d+ nodes?\.$/;

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  sync.fn.mockReset();
  u = (await db.user.create({ data: { id: generateId(), handle: 'mcp5015-u', email: 'mcp5015-u@example.test', roles: ['READER'] } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'mcp5015', urn: ORG } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'OWNER' } });
  mO = (await db.memory.create({ data: { id: generateId(), name: 'o', urn: `${ORG}:o`, class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  mU = (await db.memory.create({ data: { id: generateId(), name: 'u', urn: 'mcp5015-u:private', class: 'private', userId: u, ownerUserId: u, vectorIndexEnabled: false } })).id;
  await node(mO, 'a');
  await node(mU, 'p');
  client = new Client({ name: 'owner-limit-5015', version: '1' });
  const headers = { authorization: `Bearer ${await signJwt({ sub: u, roles: ['READER'] })}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
});
afterEach(async () => {
  await client.close();
  reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' });
});

describe('#5015 MCP node doors at the owner\'s nodes limit', () => {
  it('control: below the cap, hadron_create_node writes the node', async () => {
    const r = await call('hadron_create_node', { urn: urnO('c'), name: 'c' });
    expect(r.isError, r.text).toBe(false);
    expect(await db.node.count({ where: { memoryId: mO, loc: 'c', deletedAt: null } })).toBe(1);
  });

  it('hadron_create_node refuses a new node and writes nothing', async () => {
    await capAtCurrent({ organizationId: orgId });
    const r = await call('hadron_create_node', { urn: urnO('c'), name: 'c' });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(REFUSAL);
    expect(await db.node.count({ where: { memoryId: mO, loc: 'c' } })).toBe(0);
  });

  it('a CONTRIBUTOR of the limited organization gets the form with no owner and no number', async () => {
    const c = (await db.user.create({ data: { id: generateId(), handle: 'mcp5015-c', email: 'mcp5015-c@example.test', roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: c, role: 'CONTRIBUTOR' } });
    await capAtCurrent({ organizationId: orgId });
    const other = new Client({ name: 'owner-limit-5015-c', version: '1' });
    await other.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${await signJwt({ sub: c, roles: ['READER'] })}` } } }));
    try {
      const r = await other.callTool({ name: 'hadron_create_node', arguments: { urn: urnO('c'), name: 'c' } });
      expect(r.isError).toBe(true);
      expect((r.content as Array<{ text: string }>).map(x => x.text).join('\n'))
        .toBe(`[owner_limit_reached] ${OWNER_LIMIT_NO_NUMBER_MESSAGE}`);
    } finally { await other.close(); }
    expect(await db.node.count({ where: { memoryId: mO, loc: 'c' } })).toBe(0);
  });

  it('hadron_create_node refuses the tombstone revive and leaves the tombstone deleted', async () => {
    const t = await node(mO, 't', { deletedAt: new Date() });
    await capAtCurrent({ organizationId: orgId });
    const r = await call('hadron_create_node', { urn: urnO('t'), name: 't again' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(REFUSAL);
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).deletedAt).not.toBeNull();
  });

  it('hadron_create_parent_node refuses a new parent and writes nothing', async () => {
    await capAtCurrent({ organizationId: orgId });
    const r = await call('hadron_create_parent_node', { urn: urnO('section'), name: 'Section' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(REFUSAL);
    expect(await db.node.count({ where: { memoryId: mO, loc: 'section' } })).toBe(0);
  });

  it('hadron_create_task (a governed kind door) refuses a new task and writes nothing', async () => {
    await capAtCurrent({ organizationId: orgId });
    const r = await call('hadron_create_task', { urn: urnO('tasks:t1'), name: 't1' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(REFUSAL);
    expect(await db.node.count({ where: { memoryId: mO, loc: 'tasks:t1' } })).toBe(0);
  });

  it('hadron_move_node refuses one node moved into a capped person\'s memory and leaves it where it was', async () => {
    await capAtCurrent({ userId: u });
    const a = await db.node.findFirstOrThrow({ where: { memoryId: mO, loc: 'a' } });
    const r = await call('hadron_move_node', { urn: urnO('a'), targetUrn: urnU('a') });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(REFUSAL_USER);
    expect(await db.node.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ memoryId: mO, loc: 'a', deletedAt: null });
  });

  it('hadron_move_node refuses a subtree moved into a capped person\'s memory and moves none of it', async () => {
    await node(mO, 'a:child');
    await capAtCurrent({ userId: u });
    const r = await call('hadron_move_node', { urn: urnO('a'), targetUrn: urnU('a') });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(REFUSAL_USER);
    expect(await db.node.count({ where: { memoryId: mO, loc: { in: ['a', 'a:child'] }, deletedAt: null } })).toBe(2);
    expect(await db.node.count({ where: { memoryId: mU, loc: { startsWith: 'a' } } })).toBe(0);
  });

  it('control: a move inside one owner adds nothing and succeeds at the cap', async () => {
    await capAtCurrent({ organizationId: orgId });
    const r = await call('hadron_move_node', { urn: urnO('a'), targetUrn: urnO('renamed') });
    expect(r.isError, r.text).toBe(false);
  });

  it('hadron_restore_node refuses to restore a node and leaves it deleted', async () => {
    const t = await node(mO, 'gone', { deletedAt: new Date() });
    await capAtCurrent({ organizationId: orgId });
    const r = await call('hadron_restore_node', { nodeRef: t.id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(REFUSAL);
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).deletedAt).not.toBeNull();
  });

  it('hadron_sync_graph returns the sync\'s owner-limit refusal in the caller\'s form, judged for this caller', async () => {
    const limited = new OwnerLimitReachedError({ key: 'nodes', owner: { organizationId: orgId }, limit: 1n, callerCanManageOwner: true });
    sync.fn.mockResolvedValue({ error: limited.message, errorCode: 'OWNER_LIMIT_REACHED', ownerLimitError: limited });
    const r = await call('hadron_sync_graph', { memoryUrn: `hrn:mem:${ORG}:o` });
    expect(r).toEqual({ isError: true, text: '[owner_limit_reached] This organization has reached its limit of 1 node.' });
    expect(sync.fn.mock.calls[0][1]).toEqual({ ownerLimitCaller: { userId: u } });
  });
});
