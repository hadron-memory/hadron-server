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
const fault = vi.hoisted(() => ({
  memoryId: null as string | null,
  onTransaction: [] as boolean[],
  /** The memory whose MCP read gate calls are recorded, and whether each ran on a transaction. */
  mcpWatch: null as string | null,
  mcpOnTransaction: [] as boolean[],
}));
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

vi.mock('../../mcp/access-control.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp/access-control.js')>();
  const { db: pooled } = await import('../../integrations/db/client.js');
  return {
    ...actual,
    canReadMemory: (...args: Parameters<typeof actual.canReadMemory>) => {
      if (args[2] === fault.mcpWatch) fault.mcpOnTransaction.push(args[0] !== pooled);
      return args[2] === fault.memoryId ? Promise.reject(new Error('connection terminated unexpectedly')) : actual.canReadMemory(...args);
    },
  };
});

let server: Server;
let baseUrl: string;
let writerId: string;
let orgId: string;
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
  fault.mcpWatch = null;
  fault.mcpOnTransaction = [];
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'attest-1329', urn: 'attest-1329' } });
  orgId = org.id;
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
  const live = (loc: string) => db.node.findFirstOrThrow({ where: { memoryId, loc, deletedAt: null } });
  const tools: Array<[string, string, () => Record<string, unknown>, () => Promise<unknown>]> = [
    ['hadron_create_node', 'a fresh create', () => ({ urn: `${A}-new`, name: 'n', content: 'x', role: 'guide' }), async () => expect(await live('a-new')).toMatchObject({ name: 'n', content: 'x', authoredByTask: readableTaskId })],
    ['hadron_create_node', 'over a tombstone', () => ({ urn: T, name: 't', content: 'x', role: 'guide' }), async () => expect(await live('t')).toMatchObject({ content: 'x', authoredByTask: readableTaskId })],
    ['hadron_update_node', 'an edit', () => ({ urn: A, content: 'changed' }), async () => expect(await live('a')).toMatchObject({ content: 'changed', authoredByTask: readableTaskId })],
    ['hadron_update_node_data', 'a data merge', () => ({ nodeUrn: A, data: { k: 1 } }), async () => expect(await live('a')).toMatchObject({ data: { k: 1 }, authoredByTask: readableTaskId })],
    ['hadron_replace_text', 'a replace', () => ({ nodeUrns: [A], oldText: 'first', newText: 'second', fields: ['content'] }), async () => expect(await live('a')).toMatchObject({ content: 'second', authoredByTask: readableTaskId })],
    ['hadron_create_parent_node', 'a section re-save', () => ({ urn: P, description: 'renamed' }), async () => expect(await live('p')).toMatchObject({ description: 'renamed', authoredByTask: readableTaskId })],
    ['hadron_move_node', 'a rename', () => ({ urn: A, targetUrn: `${A}-moved`, renameToLeaf: true }), async () => expect(await live('a-moved')).toMatchObject({ name: 'a-moved', authoredByTask: readableTaskId })],
  ];
  it.each(tools)('%s, %s', async (name, _label, args, written) => {
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
    const retried = await call(name, { ...args(), authoredWith: claim });
    expect(retried.isError).not.toBe(true);
    await written();
  });
});

describe('#1329 every MCP writer asks whether the task is readable', () => {
  it.each([
    ['hadron_update_node', () => ({ urn: 'hrn:node:attest-1329:mem:a', content: 'changed' })],
    ['hadron_update_node_data', () => ({ nodeUrn: 'hrn:node:attest-1329:mem:a', data: { k: 1 } })],
    ['hadron_replace_text', () => ({ nodeUrns: ['hrn:node:attest-1329:mem:a'], oldText: 'first', newText: 'second', fields: ['content'] })],
    ['hadron_create_parent_node', () => ({ urn: 'hrn:node:attest-1329:mem:p', description: 'renamed' })],
    ['hadron_move_node', () => ({ urn: 'hrn:node:attest-1329:mem:a', targetUrn: 'hrn:node:attest-1329:mem:a-moved', renameToLeaf: true })],
    ['hadron_create_node', () => ({ urn: 'hrn:node:attest-1329:mem:t', name: 't', content: 'x', role: 'guide' })],
  ] as Array<[string, () => Record<string, unknown>]>)('%s, an exact claim on an unreadable task', async (name, args) => {
    await repoint(hiddenTaskId);
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'a', name: 'a', content: 'first', role: 'guide' } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'p', name: 'p', content: 'first', role: 'guide', nodeType: 'parent' } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 't', name: 't', content: 'gone', role: 'guide', deletedAt: new Date() } });
    const client = new Client({ name: 'attest-1329', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    }));
    try {
      const result = await client.callTool({ name, arguments: { ...args(), authoredWith: { task: HIDDEN_URN, revision: 5 } } }) as { structuredContent?: { error: Record<string, unknown> } };
      expect(result.structuredContent?.error).toEqual(expect.objectContaining({ code: 'AUTHOR_TASK_BROKEN', ...NO_RECOVERY }));
    } finally {
      await client.close();
    }
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

/**
 * Xan's ruling 6661007376, option (a). The MCP read gate and GraphQL's disagree for
 * user-backed principals (hadron-server#3519). On MCP, READABLE promises that
 * hadron_get_node loads the task, so the MCP gate decides there; GraphQL keeps its
 * own gate. The memory here: a holding the writer created, in an App they aren't in.
 */
describe('#1329 on MCP, readable means hadron_get_node can load it', () => {
  const HOLDING_URN = 'hrn:node:attest-1329:holding:task';
  const claim = { task: HOLDING_URN, revision: 4 };
  let holdingMemoryId: string;
  let holdingTaskId: string;

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

  beforeEach(async () => {
    const app = await db.app.create({ data: { organizationId: orgId, name: 'c', urn: 'attest-1329:c' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'ag', urn: 'attest-1329:ag' } as never });
    holdingMemoryId = (await db.memory.create({ data: {
      id: generateId(), organizationId: orgId, urn: 'attest-1329:holding', name: 'holding', class: 'knowledge',
      appId: app.id, userMemoryOfAgentId: agent.id, createdBy: writerId,
    } })).id;
    holdingTaskId = (await db.node.create({ data: { id: generateId(), memoryId: holdingMemoryId, loc: 'task', name: 'Task', isRunnable: true, content: 'how to', revSeq: 4 } })).id;
    await repoint(holdingTaskId);
    const { configId } = await db.nodeRoleRule.findUniqueOrThrow({ where: { id: ruleId } });
    for (const role of ['task', 'review']) {
      await db.nodeRoleRule.create({ data: { id: generateId(), configId, role, authorTaskId: holdingTaskId, authorTaskRequired: true } });
    }
    fault.mcpWatch = holdingMemoryId;
  });

  it('the surfaces differ on this memory, and each answers for its own read', async () => {
    const read = await post(apiKey, 'query($ref: ID!) { node(ref: $ref) { id } }', { ref: HOLDING_URN });
    expect(read.data).toEqual({ node: { id: holdingTaskId } });
    const cli = await viaCliWire();
    expect(cli.errors?.[0]?.extensions).toEqual(expect.objectContaining({ code: 'AUTHORING_ATTESTATION_MISSING', taskAccess: 'READABLE', task: HOLDING_URN }));

    expect((await call('hadron_get_node', { urn: HOLDING_URN })).content[0]!.text).toContain('Memory not found');
    const mcp = await viaMcp();
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent?.error).toEqual(expect.objectContaining({ code: 'AUTHOR_TASK_BROKEN', ...NO_RECOVERY }));
    expect(JSON.stringify(mcp)).not.toContain('holding');
  });

  it('the MCP refusal is byte-identical to a task that does not exist, whatever the claim', async () => {
    const concealed = [JSON.stringify(await viaMcp()), JSON.stringify(await viaMcp(claim)), JSON.stringify(await viaMcp({ task: holdingTaskId, revision: 1 }))];
    await repoint(null);
    expect(concealed).toEqual([JSON.stringify(await viaMcp()), JSON.stringify(await viaMcp()), JSON.stringify(await viaMcp())]);
    // #4125: six MCP round trips plus a repoint. ~1.2 s on a quiet host, 5.3 s on a loaded CI shard (the 5 s default
    // failed it once). 30 s declares what it costs; the suite-wide default is left alone on purpose.
  }, 30_000);

  it('an exact claim is admitted on GraphQL and refused on MCP: the disclosed admission difference', async () => {
    const mcp = await viaMcp(claim);
    expect(mcp.structuredContent?.error.code).toBe('AUTHOR_TASK_BROKEN');
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
    expect((await viaCliWire(claim)).errors).toBeUndefined();
    expect(await db.node.findFirstOrThrow({ where: { memoryId, loc: 'a' } })).toMatchObject({ authoredByTask: holdingTaskId });
  });

  it("is judged on the write's own transaction", async () => {
    await viaMcp();
    expect(fault.mcpOnTransaction).toEqual([true]);
  });

  it('a failure in the MCP read gate is the generic internal error, never "unreadable"', async () => {
    fault.memoryId = holdingMemoryId;
    const mcp = await viaMcp(claim);
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent?.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(mcp)).not.toMatch(/unreadable|author task|connection terminated|author_task_broken/i);
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });

  it("an install write takes the MCP gate too", async () => {
    const app = await db.app.findFirstOrThrow({ where: { urn: 'attest-1329:c' } });
    const agent = await db.agent.findFirstOrThrow({ where: { urn: 'attest-1329:ag' } });
    await db.appMember.create({ data: { appId: app.id, userId: writerId, role: 'owner' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } as never });
    const install = await db.memory.create({ data: {
      id: generateId(), class: 'system', name: 'install', urn: 'attest-1329:install', organizationId: orgId, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true,
    } });
    // The holding reads over MCP once its App is the caller's own, so the task moves to one that does not.
    const elsewhere = await db.app.create({ data: { organizationId: orgId, name: 'd', urn: 'attest-1329:d' } });
    await db.memory.update({ where: { id: holdingMemoryId }, data: { appId: elsewhere.id } });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: install.id } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: holdingTaskId, authorTaskRequired: true } });
    const result = await call('hadron_create_node', {
      urn: 'hrn:node:attest-1329:install:new', name: 'n', content: 'x', role: 'guide', install: { app: app.id, agent: agent.id }, authoredWith: claim,
    });
    expect(result.structuredContent?.error ?? result.content[0]!.text).toEqual(expect.objectContaining({ code: 'AUTHOR_TASK_BROKEN', ...NO_RECOVERY }));
  });

  const M = 'hrn:node:attest-1329:mem';
  const writers: Array<[string, string, Record<string, unknown>]> = [
    ['hadron_create_node', 'a fresh create', { urn: `${M}:new`, name: 'n', content: 'x', role: 'guide', authoredWith: claim }],
    ['hadron_create_node', 'over a tombstone', { urn: `${M}:t`, name: 't', content: 'x', role: 'guide', authoredWith: claim }],
    ['hadron_update_node', 'an edit', { urn: `${M}:a`, content: 'changed', authoredWith: claim }],
    ['hadron_update_node_data', 'a data merge, delegated', { nodeUrn: `${M}:a`, data: { k: 1 }, authoredWith: claim }],
    ['hadron_replace_text', 'a replace, delegated', { nodeUrns: [`${M}:a`], oldText: 'first', newText: 'second', fields: ['content'], authoredWith: claim }],
    ['hadron_create_parent_node', 'a section re-save', { urn: `${M}:p`, description: 'renamed', authoredWith: claim }],
    ['hadron_move_node', 'a rename', { urn: `${M}:a`, targetUrn: `${M}:a-moved`, renameToLeaf: true, authoredWith: claim }],
    ['hadron_move_node', 'a same-slot rename', { urn: `${M}:b`, targetUrn: `${M}:b`, renameToLeaf: true, authoredWith: claim }],
    ['hadron_create_task', 'the task door, delegated', { urn: `${M}:new-task`, name: 'n', content: 'x', authoredWith: claim }],
    ['hadron_update_task', 'the task door, delegated', { urn: `${M}:rt`, content: 'changed', authoredWith: claim }],
    ['hadron_create_review', 'the review door, delegated', { urn: `${M}:new-review`, name: 'n', content: 'x', authoredWith: claim }],
    ['hadron_update_review', 'the review door, delegated', { urn: `${M}:rv`, content: 'changed', authoredWith: claim }],
    ['hadron_update_object', 'an object merge, delegated, no claim', { ref: `${M}:a`, fields: { k: 1 } }],
  ];
  it.each(writers)('%s, %s', async (name, _label, args) => {
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'a', name: 'a', content: 'first', role: 'guide' } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'b', name: 'Other name', content: 'first', role: 'guide' } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'p', name: 'p', content: 'first', role: 'guide', nodeType: 'parent' } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 't', name: 't', content: 'gone', role: 'guide', deletedAt: new Date() } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'rt', name: 'rt', content: 'first', isRunnable: true } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'rv', name: 'rv', content: 'first', role: 'review' } });
    const result = await call(name, args);
    expect(result.structuredContent?.error ?? result.content[0]!.text).toEqual(expect.objectContaining({ code: 'AUTHOR_TASK_BROKEN', ...NO_RECOVERY }));
    expect(fault.mcpOnTransaction).toContain(true);
    expect(fault.mcpOnTransaction).not.toContain(false);
  });
});
