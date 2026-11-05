/**
 * #1329 — authoring-attestation refusals a writer can act on, over the real
 * adapters: /graphql with a non-portal credential, /graphql with a user API key
 * (the CLI's credential, what `hadron api` prints) and /mcp.
 *
 * A writer who can read the required task gets its URN, id, current revision and
 * the way to load it. Anyone else gets one projection, whatever they claimed and
 * whatever is wrong with the task, so the refusal is no existence oracle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/jwt.js';
import { mintUserApiKey } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const fault = vi.hoisted(() => ({ memoryId: null as string | null, onTransaction: [] as boolean[] }));
vi.mock('../../api/graphql/schema/resolvers.helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/graphql/schema/resolvers.helpers.js')>();
  return {
    ...actual,
    isMemoryReadableFresh: (...args: Parameters<typeof actual.isMemoryReadableFresh>) => {
      fault.onTransaction.push(args[2] !== undefined);
      return args[1] === fault.memoryId ? Promise.reject(new Error('connection terminated unexpectedly')) : actual.isMemoryReadableFresh(...args);
    },
  };
});

let server: Server;
let baseUrl: string;
let writerId: string;
let memoryId: string;
let readableTaskId: string;
let hiddenMemoryId: string;
let hiddenTaskId: string;
let ruleId: string;
let apiKey: string;
let jwt: string;

const READABLE_URN = 'hrn:node:attest-1329:mem:task';
const HIDDEN_URN = 'hrn:node:attest-1329-other:hidden:task';
const CREATE = 'mutation($input: CreateNodeInput!) { createNode(input: $input) { id } }';
type Wire = { data?: unknown; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };

const post = async (token: string, query: string, variables: unknown, headers: Record<string, string> = {}): Promise<Wire> => {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ query, variables }),
  });
  return await res.json() as Wire;
};
const input = (authoredWith?: { task: string; revision: number }) => ({
  memoryId, loc: 'a', name: 'a', content: 'x', role: 'guide', ...(authoredWith ? { authoredWith } : {}),
});
/** The GraphQL surface: a sign-in JWT with a session is not the portal path, so it attests. */
const viaGraphql = (authoredWith?: { task: string; revision: number }) =>
  post(jwt, CREATE, { input: input(authoredWith) }, { 'x-hadron-session': generateId() });
/** The CLI wire: a user API key on /graphql, the response `hadron api` prints. */
const viaCliWire = (authoredWith?: { task: string; revision: number }) => post(apiKey, CREATE, { input: input(authoredWith) });
const viaMcp = async (authoredWith?: { task: string; revision: number }) => {
  const client = new Client({ name: 'attest-1329', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  }));
  try {
    const result = await client.callTool({
      name: 'hadron_create_node',
      arguments: { urn: 'hrn:node:attest-1329:mem:a', name: 'a', content: 'x', role: 'guide', ...(authoredWith ? { authoredWith } : {}) },
    });
    return result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { error: Record<string, unknown> } };
  } finally {
    await client.close();
  }
};
const repoint = (authorTaskId: string | null) => db.nodeRoleRule.update({ where: { id: ruleId }, data: { authorTaskId } });
const fields = (e: Record<string, unknown> | undefined) => {
  const { message: _message, ...rest } = e ?? {};
  return rest;
};

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(async () => {
  fault.memoryId = null;
  fault.onTransaction = [];
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'attest-1329', urn: 'attest-1329' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'attest-1329-other', urn: 'attest-1329-other' } });
  // A plain member: writes the memory, may not read its config.
  writerId = (await db.user.create({ data: { githubId: 13290, githubUsername: 'attest-1329', handle: 'attest-1329', email: 'attest-1329@example.test' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: writerId, role: 'CONTRIBUTOR' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'attest-1329:mem', name: 'mem', class: 'knowledge' } })).id;
  readableTaskId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'task', name: 'Task', isRunnable: true, content: 'how to', revSeq: 3 } })).id;
  hiddenMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: other.id, urn: 'attest-1329-other:hidden', name: 'hidden', class: 'knowledge' } })).id;
  hiddenTaskId = (await db.node.create({ data: { id: generateId(), memoryId: hiddenMemoryId, loc: 'task', name: 'Secret title', isRunnable: true, content: 'secret', revSeq: 5 } })).id;
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  ruleId = (await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: readableTaskId, authorTaskRequired: true } })).id;
  ({ rawKey: apiKey } = await mintUserApiKey(db, { userId: writerId, label: 'cli', createdBy: writerId, issuedVia: null }));
  jwt = await signJwt({ sub: writerId, roles: ['CONTRIBUTOR'], email: 'attest-1329@example.test' });
});

const RECOVERY = {
  taskAccess: 'READABLE',
  task: READABLE_URN,
  taskRevision: 3,
  load: {
    graphql: `node(ref: "${READABLE_URN}")`,
    mcp: `hadron_get_node(urn: "${READABLE_URN}")`,
    cli: `hadron node get ${READABLE_URN}`,
  },
};
const NO_RECOVERY = { taskAccess: 'UNAVAILABLE', task: null, taskId: null, taskRevision: null, load: null };

describe('#1329 a readable task', () => {
  const cases: Array<[string, () => { task: string; revision: number } | undefined]> = [
    ['AUTHORING_ATTESTATION_MISSING', () => undefined],
    ['AUTHORING_ATTESTATION_WRONG_TASK', () => ({ task: hiddenTaskId, revision: 3 })],
    ['AUTHORING_ATTESTATION_STALE', () => ({ task: READABLE_URN, revision: 2 })],
  ];
  it.each(cases)('%s carries the same recovery on GraphQL, the CLI wire and MCP', async (code, claim) => {
    const expected = { code, role: 'guide', ...RECOVERY, taskId: readableTaskId };
    const graphql = await viaGraphql(claim());
    const cli = await viaCliWire(claim());
    const mcp = await viaMcp(claim());
    expect(graphql.errors?.[0]?.extensions).toEqual(expect.objectContaining(expected));
    expect(fields(graphql.errors?.[0]?.extensions)).toEqual(fields(cli.errors?.[0]?.extensions));
    expect(mcp.isError).toBe(true);
    expect(fields(mcp.structuredContent?.error)).toEqual(expect.objectContaining(expected));
    for (const key of ['code', 'role', 'taskAccess', 'task', 'taskId', 'taskRevision', 'load']) {
      expect(mcp.structuredContent?.error[key]).toEqual(cli.errors?.[0]?.extensions?.[key]);
    }
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });

  it('names the route the caller has: the CLI on GraphQL, hadron_get_node on MCP', async () => {
    const wire = await viaCliWire();
    expect(wire.errors?.[0]?.message).toContain(`hadron node get ${READABLE_URN}`);
    expect(wire.errors?.[0]?.message).toContain('revision 3');
    const mcp = await viaMcp();
    expect(mcp.content[0]!.text).toMatch(/^\[authoring_attestation_missing\] /);
    expect(mcp.content[0]!.text).toContain(`hadron_get_node(urn: "${READABLE_URN}")`);
    expect(mcp.content[0]!.text).not.toContain('hadron node get');
  });

  it('a plain member recovers without the manager-only config read', async () => {
    const config = await post(apiKey, 'query($m: ID!) { memoryConfig(memoryRef: $m) { id } }', { m: memoryId });
    expect(config.errors?.length).toBeGreaterThan(0);
    const refused = await viaCliWire();
    const { task, taskRevision } = refused.errors![0]!.extensions as { task: string; taskRevision: number };
    const read = await post(apiKey, 'query($r: ID!) { node(ref: $r) { id content } }', { r: task });
    expect(read.data).toEqual({ node: { id: readableTaskId, content: 'how to' } });
    const retry = await viaCliWire({ task, revision: taskRevision });
    expect(retry.errors).toBeUndefined();
  });

  it('never claims a matching attestation proves the procedure was followed', async () => {
    for (const claim of [undefined, { task: hiddenTaskId, revision: 3 }, { task: READABLE_URN, revision: 2 }]) {
      const message = (await viaCliWire(claim)).errors![0]!.message;
      expect(message).not.toMatch(/prove|complian|verified|followed/i);
    }
  });
});

describe('#1329 every MCP writer carries the structured refusal', () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const client = new Client({ name: 'attest-1329', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    }));
    try {
      return await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { error: Record<string, unknown> } };
    } finally {
      await client.close();
    }
  };
  const A = 'hrn:node:attest-1329:mem:a';
  const P = 'hrn:node:attest-1329:mem:p';
  const T = 'hrn:node:attest-1329:mem:t';
  const tools: Array<[string, string, () => Record<string, unknown>]> = [
    ['hadron_create_node', 'a fresh create', () => ({ urn: `${A}-new`, name: 'n', content: 'x', role: 'guide' })],
    ['hadron_create_node', 'over a tombstone', () => ({ urn: T, name: 't', content: 'x', role: 'guide' })],
    ['hadron_update_node', 'an edit', () => ({ urn: A, content: 'changed' })],
    ['hadron_update_node_data', 'a data merge', () => ({ nodeUrn: A, data: { k: 1 } })],
    ['hadron_replace_text', 'a replace', () => ({ nodeUrns: [A], oldText: 'first', newText: 'second', fields: ['content'] })],
    ['hadron_create_parent_node', 'a section re-save', () => ({ urn: P, title: 'renamed' })],
    ['hadron_move_node', 'a rename', () => ({ urn: A, targetUrn: `${A}-moved`, renameToLeaf: true })],
  ];
  it.each(tools)('%s, %s', async (name, _label, args) => {
    const claim = { task: readableTaskId, revision: 3 };
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'a', name: 'a', content: 'first', role: 'guide' } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'p', name: 'p', content: 'first', role: 'guide', nodeType: 'parent' } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 't', name: 't', content: 'gone', role: 'guide', deletedAt: new Date() } });
    const result = await call(name, args());
    expect(result.content[0]!.text).toContain('authoring_attestation_missing');
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toEqual(expect.objectContaining({
      code: 'AUTHORING_ATTESTATION_MISSING', role: 'guide', ...RECOVERY, taskId: readableTaskId,
    }));
    expect((await call(name, { ...args(), authoredWith: claim })).isError).not.toBe(true);
  });
});

describe('#1329 a task the writer cannot read', () => {
  /** The whole response, so a stray field, a path or a message difference fails. */
  const projections = async (claim?: { task: string; revision: number }) => ({
    graphql: JSON.stringify((await viaGraphql(claim)).errors![0]!.extensions),
    graphqlMessage: (await viaGraphql(claim)).errors![0]!.message,
    cli: JSON.stringify(await viaCliWire(claim)),
    mcp: JSON.stringify(await viaMcp(claim)),
  });
  const brokenStates: Array<[string, () => Promise<unknown>]> = [
    ['hard-deleted, the foreign key nulled', () => repoint(null)],
    ['soft-deleted', async () => { await repoint(readableTaskId); await db.node.update({ where: { id: readableTaskId }, data: { deletedAt: new Date() } }); }],
    ['no longer runnable', async () => { await repoint(readableTaskId); await db.node.update({ where: { id: readableTaskId }, data: { isRunnable: false } }); }],
    ['in a deleted memory', async () => { await db.memory.update({ where: { id: hiddenMemoryId }, data: { deletedAt: new Date() } }); }],
  ];

  it.each(brokenStates)('answers byte-identically to a task that is %s, on every surface', async (_label, breakIt) => {
    await repoint(hiddenTaskId);
    const unreadable = await projections();
    await breakIt();
    expect(await projections()).toEqual(unreadable);
  });

  it("is judged on the write's own transaction", async () => {
    await repoint(hiddenTaskId);
    await viaCliWire();
    expect(fault.onTransaction).toEqual([true]);
  });

  it('says it is unreadable and names no task', async () => {
    await repoint(hiddenTaskId);
    const wire = await viaCliWire();
    expect(wire.errors![0]!.extensions).toEqual(expect.objectContaining({ code: 'AUTHOR_TASK_BROKEN', role: 'guide', ...NO_RECOVERY }));
    expect(wire.errors![0]!.message).toMatch(/unreadable/);
    expect(wire.errors![0]!.message).toMatch(/owner/);
    expect(JSON.stringify(wire)).not.toContain(hiddenTaskId);
    expect(JSON.stringify(wire)).not.toContain('attest-1329-other');
    expect(JSON.stringify(wire)).not.toContain('Secret title');
    const mcp = await viaMcp();
    expect(fields(mcp.structuredContent?.error)).toEqual(expect.objectContaining({ code: 'AUTHOR_TASK_BROKEN', ...NO_RECOVERY }));
    expect(JSON.stringify(mcp)).not.toContain(hiddenTaskId);
  });

  it('every claim gets the same answer: nothing confirms a guessed URN or revision', async () => {
    await repoint(hiddenTaskId);
    const none = await projections();
    for (const claim of [
      { task: HIDDEN_URN, revision: 5 }, // exact
      { task: hiddenTaskId, revision: 5 }, // exact, by id
      { task: HIDDEN_URN, revision: 4 }, // right task, stale
      { task: 'hrn:node:attest-1329-other:hidden:nope', revision: 5 }, // wrong task
    ]) {
      expect(await projections(claim)).toEqual(none);
    }
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });

  it('an exact claim that #1328 admitted is refused now, on the writer without read access', async () => {
    await repoint(hiddenTaskId);
    const res = await viaCliWire({ task: HIDDEN_URN, revision: 5 });
    expect(res.errors?.[0]?.extensions?.code).toBe('AUTHOR_TASK_BROKEN');
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });

  it('a task in another memory the writer can read is readable', async () => {
    await repoint(hiddenTaskId);
    const org = await db.memory.findUniqueOrThrow({ where: { id: hiddenMemoryId }, select: { organizationId: true } });
    await db.orgMember.create({ data: { organizationId: org.organizationId!, userId: writerId, role: 'CONTRIBUTOR' } });
    const res = await viaCliWire();
    expect(res.errors?.[0]?.extensions).toEqual(expect.objectContaining({
      code: 'AUTHORING_ATTESTATION_MISSING', taskAccess: 'READABLE', task: HIDDEN_URN, taskId: hiddenTaskId, taskRevision: 5,
    }));
    expect((await viaCliWire({ task: HIDDEN_URN, revision: 5 })).errors).toBeUndefined();
  });
});

describe('#1329 a failure while judging readability', () => {
  it('is the generic internal error on every surface, never "unreadable"', async () => {
    await repoint(hiddenTaskId);
    fault.memoryId = hiddenMemoryId;
    for (const wire of [await viaGraphql(), await viaCliWire({ task: HIDDEN_URN, revision: 5 })]) {
      expect(wire.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
      expect(wire.errors?.[0]?.message).not.toMatch(/unreadable|author task|connection/i);
      expect(wire.errors?.[0]?.extensions).not.toHaveProperty('taskAccess');
    }
    const mcp = await viaMcp();
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent?.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(mcp)).not.toMatch(/unreadable|author task|connection terminated|author_task_broken/i);
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });
});
