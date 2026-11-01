/**
 * #2048 S11a RED PINS ONLY (Marco23993, CHECKED6260473774).
 * Public read/write contracts; no local parser, selector or production shim.
 * Providers S1/S2/S6 and qualification must land before implementation/freeze.
 */
import { ApolloServer } from '@apollo/server';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { buildSchema, isObjectType } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { lintSourceWarnings, lintWarningPageForNodeId } from '../../../lib/bootPromptLint.js';
import { typeDefs } from './typeDefs.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
let httpServer: Server, mcpUrl: string;
beforeAll(async () => {
  httpServer = createHttpServer(await createServer());
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  mcpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  await server.stop();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
});
let userId: string, foreignOrgId: string, memoryId: string, memoryUrn: string, foreignMemoryId: string, foreignMemoryUrn: string;
const ctx = (): Context => ({ db, userId, roles: [] });
const fields = `kind position text targetUrn pinnedRevision newerRevision overriddenNodeLoc workerField`;
const pageSelection = `items { ${fields} } total nextCursor`;
const M = resolvers.Mutation as any;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().slice(-10);
  const org = await db.organization.create({ data: { name: 'Lint home', urn: `lint-${suffix}.test` } });
  const foreign = await db.organization.create({ data: { name: 'Hidden publisher', urn: `hidden-${suffix}.test` } });
  const user = await db.user.create({ data: { handle: 'lint2048-manager', roles: [] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const memory = await db.memory.create({ data: { name: 'Sources', urn: `${org.urn}:sources`, class: 'system', organizationId: org.id } });
  // A boot prompt's source lives in an Agent's system memory, which its org's manager reads (cor:agt:040:05).
  await db.agent.create({ data: { name: 'Lint agent', urn: `${org.urn}:lint-agent`, organizationId: org.id, systemMemoryId: memory.id } });
  const hidden = await db.memory.create({ data: { name: 'Hidden', urn: `${foreign.urn}:sources`, class: 'system', organizationId: foreign.id } });
  await db.agent.create({ data: { name: 'Hidden agent', urn: `${foreign.urn}:hidden-agent`, organizationId: foreign.id, systemMemoryId: hidden.id } });
  foreignOrgId = foreign.id;
  memoryId = memory.id; memoryUrn = memory.urn;
  foreignMemoryId = hidden.id; foreignMemoryUrn = hidden.urn;
});
const target = (loc = 'part') => db.node.create({ data: { memoryId, loc, name: loc, content: 'Part text' } });
const source = (content: string, loc = 'prompt') => db.node.create({ data: { memoryId, loc, name: loc, content, role: 'boot-prompt' } });
async function execute(query: string, variables: Record<string, unknown>, context = ctx()) {
  const response = await server.executeOperation({ query, variables }, { contextValue: context });
  expect(response.body.kind).toBe('single');
  if (response.body.kind !== 'single') throw new Error('Expected one GraphQL response');
  return response.body.singleResult;
}
async function page(id: string, first = 50, after?: string, raw = true) {
  const result = await execute(`query($ref: ID!, $first: Int!, $after: String, $raw: Boolean!) {
    node(ref: $ref, raw: $raw) { id lintWarnings(first: $first, after: $after) { ${pageSelection} } }
  }`, { ref: id, first, after, raw });
  expect(result.errors).toBeUndefined();
  expect(result.data?.node).toMatchObject({ id });
  const value = (result.data?.node as any).lintWarnings;
  expect(value).not.toBeNull(); // unavailable must never pass as an empty warning set
  return value as { items: Array<Record<string, any>>; total: number; nextCursor: string | null };
}

describe('#2048 S11a public nullable/typed contract', () => {
  it('has one nullable paged field on Node and approval receipt, with allowlisted detail fields', () => {
    const schema = buildSchema(typeDefs);
    for (const name of ['Node', 'NodeApprovalReceipt']) {
      const type = schema.getType(name);
      expect(isObjectType(type)).toBe(true);
      if (!isObjectType(type)) throw new Error('Expected object type');
      const lint = type.getFields().lintWarnings;
      expect(lint, `${name}.lintWarnings is missing`).toBeDefined();
      expect(String(lint.type)).toBe('LintWarningPage'); // nullable unavailable, not [] or non-null bubbling
      expect(lint.args.find(arg => arg.name === 'first')?.defaultValue).toBe(50);
    }
    const warning = schema.getType('LintWarning');
    expect(isObjectType(warning)).toBe(true);
    if (!isObjectType(warning)) throw new Error('Expected warning object');
    expect(Object.keys(warning.getFields()).sort()).toEqual(fields.split(' ').sort());
  });

  it('returns a real empty page for an ordinary node, distinct from unavailable', async () => {
    const ordinary = await target();
    expect(await page(ordinary.id)).toEqual({ items: [], total: 0, nextCursor: null });
  });
});

describe('#2048 S11a source warnings, current state and concealment', () => {
  it('raises retired-on-next-read without a subject write or push, then clears when the target returns (R98/R46)', async () => {
    const part = await target();
    const prompt = await source('{{> part}}');
    expect((await page(prompt.id)).items).toEqual([]);
    const before = await db.node.findUniqueOrThrow({ where: { id: prompt.id } });
    await db.node.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    const retired = await page(prompt.id);
    expect(retired.items).toEqual([expect.objectContaining({ kind: 'RETIRED_TARGET', targetUrn: `hrn:node:${memoryUrn}:part` })]);
    expect(await db.node.findUniqueOrThrow({ where: { id: prompt.id } })).toEqual(before);
    await db.node.update({ where: { id: part.id }, data: { deletedAt: null } });
    expect((await page(prompt.id)).items).toEqual([]);
  });

  it('reports a readable include with no approved revision, not a hidden-target diagnosis', async () => {
    await target();
    const prompt = await source('{{> part approved}}');
    expect((await page(prompt.id)).items).toEqual([expect.objectContaining({ kind: 'NO_QUALIFYING_REVISION', targetUrn: `hrn:node:${memoryUrn}:part` })]);
  });

  it('keeps a valid pin and reports a newer approval separately, never RECOMPILE_AVAILABLE for a source', async () => {
    const part = await M.createNode(null, { input: { memoryId, loc: 'part', name: 'Part', content: 'First' } }, ctx());
    await M.approveNode(null, { nodeRef: part.id }, ctx());
    const pinnedRevision = part.revSeq;
    const newer = await M.updateNode(null, { input: { id: part.id, content: 'Second' } }, ctx());
    await M.approveNode(null, { nodeRef: part.id }, ctx());
    const prompt = await source(`{{> part rev=${pinnedRevision} approved}}`);
    const warnings = (await page(prompt.id)).items;
    expect(warnings).toEqual([expect.objectContaining({ kind: 'PINNED_NEWER_APPROVED', pinnedRevision, newerRevision: newer.revSeq })]);
    expect(warnings.some(warning => warning.kind === 'RECOMPILE_AVAILABLE')).toBe(false);
  });

  it('warns about unchecked signing without enforcing a not-yet-shipped signature predicate', async () => {
    await target();
    const prompt = await source('{{> part signed}}');
    expect((await page(prompt.id)).items).toEqual([expect.objectContaining({ kind: 'SIGNING_NOT_CHECKED' })]);
  });

  it('uses the provider parser: code examples are literal, raw/resolved lint is the same', async () => {
    await target();
    const prompt = await source('`{{> absent}}`\n\n```\n{{> absent approved}}\n```\n{{> part signed}}');
    const raw = await page(prompt.id, 50, undefined, true);
    expect(raw.items.map(warning => warning.kind)).toEqual(['SIGNING_NOT_CHECKED']);
    expect(await page(prompt.id, 50, undefined, false)).toEqual(raw);
  });

  it('serializes missing and unreadable targets identically, with no retirement/approval or target identity detail', async () => {
    await db.node.create({ data: { memoryId: foreignMemoryId, loc: 'secret', name: 'Hidden', content: 'Not visible', deletedAt: new Date() } });
    const hidden = await source(`{{> hrn:node:${foreignMemoryUrn}:secret approved}}`, 'hidden-prompt');
    const absent = await source(`{{> hrn:node:${foreignMemoryUrn}:absent approved}}`, 'absent-prompt');
    const hiddenPage = await page(hidden.id);
    expect(hiddenPage).toEqual(await page(absent.id));
    expect(hiddenPage.items).toHaveLength(1);
    expect(hiddenPage.items[0]).toMatchObject({ kind: 'BROKEN_INCLUDE', targetUrn: null, pinnedRevision: null, newerRevision: null, overriddenNodeLoc: null, workerField: null });
    expect(JSON.stringify(hiddenPage)).not.toContain(foreignMemoryUrn);
    expect(JSON.stringify(hiddenPage)).not.toContain('secret');
  });

  it('clamps pages at100, preserves deterministic cursors, and clears warnings on source text replacement', async () => {
    const part = await target();
    const prompt = await source(Array.from({ length: 101 }, () => '{{> part}}').join('\n'));
    await db.node.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    const first = await page(prompt.id, 999);
    expect(first.items).toHaveLength(100);
    expect(first.total).toBe(101);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = await page(prompt.id, 100, first.nextCursor!);
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    expect(new Set([...first.items, ...last.items].map(warning => warning.position)).size).toBe(101);
    expect(await page(prompt.id, 999)).toEqual(first);
    await M.updateNode(null, { input: { id: prompt.id, content: 'No includes remain.' } }, ctx());
    expect(await page(prompt.id)).toEqual({ items: [], total: 0, nextCursor: null });
  });

  it('a selected write/approval payload carries the same non-blocking warnings as a later read', async () => {
    await target();
    const prompt = await source('Original');
    const saved = await execute(`mutation($id: String!) { updateNode(input: { id: $id, content: "{{> part signed}}" }) {
      id lintWarnings { ${pageSelection} }
    } }`, { id: prompt.id });
    expect(saved.errors).toBeUndefined();
    expect((await db.node.findUniqueOrThrow({ where: { id: prompt.id } })).content).toBe('{{> part signed}}');
    const expected = await page(prompt.id);
    expect((saved.data?.updateNode as any).lintWarnings).toEqual(expected);
    expect(expected.items.map(warning => warning.kind)).toEqual(['SIGNING_NOT_CHECKED']);
    const approved = await execute(`mutation($ref: ID!) { approveNode(nodeRef: $ref) { nodeId lintWarnings { ${pageSelection} } } }`, { ref: prompt.id });
    expect(approved.errors).toBeUndefined();
    expect((approved.data?.approveNode as any).lintWarnings).toEqual(await page(prompt.id));
    expect((await db.node.findUniqueOrThrow({ where: { id: prompt.id } })).approvedAt).not.toBeNull();
  });
});

describe('#2048 S11a scope and audience', () => {
  it('an ordinary node with include-shaped text has nothing to lint, and a compiled boot prompt is unavailable, not empty', async () => {
    await target();
    const plain = await db.node.create({ data: { memoryId, loc: 'plain', name: 'plain', content: '{{> part signed}} {{> absent}}' } });
    expect(await page(plain.id)).toEqual({ items: [], total: 0, nextCursor: null });
    const compiled = await db.node.create({ data: { memoryId, loc: 'compiled', name: 'compiled', content: '{{> part signed}}', role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } });
    const result = await execute(`query($ref: ID!) { node(ref: $ref, raw: true) { lintWarnings { total } } }`, { ref: compiled.id });
    expect(result.errors).toBeUndefined();
    expect((result.data?.node as any).lintWarnings).toBeNull();
  });

  it('the same include lints as retired for a caller who can read the target and as position-only for one who cannot', async () => {
    const retired = await db.node.create({ data: { memoryId: foreignMemoryId, loc: 'policy', name: 'policy', content: 'x', deletedAt: new Date() } });
    const prompt = await source(`{{> hrn:node:${foreignMemoryUrn}:policy approved}}`);
    const row = { id: prompt.id, memoryId, content: prompt.content, role: 'boot-prompt', nodeType: null };
    const reader = await db.user.create({ data: { handle: 'lint2048-foreign-manager', roles: [] } });
    await db.orgMember.create({ data: { organizationId: foreignOrgId, userId: reader.id, role: 'ADMIN' } });
    const asReader = await lintSourceWarnings({ db, userId: reader.id, roles: [] }, row);
    expect(asReader).toEqual([expect.objectContaining({ kind: 'RETIRED_TARGET', targetUrn: `hrn:node:${foreignMemoryUrn}:policy` })]);
    const asOutsider = await lintSourceWarnings(ctx(), row);
    expect(asOutsider).toEqual([expect.objectContaining({ kind: 'BROKEN_INCLUDE', targetUrn: null })]);
    expect(retired.deletedAt).not.toBeNull();
  });

  it('lint never blocks: approving a source whose include is retired is recorded, with the warning on the receipt', async () => {
    const part = await target();
    const prompt = await source('{{> part}}');
    await db.node.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    const approved = await execute(`mutation($ref: ID!) { approveNode(nodeRef: $ref) { nodeId lintWarnings { total items { kind } } } }`, { ref: prompt.id });
    expect(approved.errors).toBeUndefined();
    expect((approved.data?.approveNode as any).lintWarnings).toEqual({ total: 1, items: [{ kind: 'RETIRED_TARGET' }] });
    expect((await db.node.findUniqueOrThrow({ where: { id: prompt.id } })).approvedAt).not.toBeNull();
  });
});

describe('#2048 S11a source-content read gate on the id-based projection', () => {
  it('is unavailable for a caller who cannot read the source, and real for one who can', async () => {
    await target();
    const prompt = await source('{{> part signed}}');
    const outsider = await db.user.create({ data: { handle: 'lint2048-outsider', roles: [] } });
    expect(await lintWarningPageForNodeId({ db, userId: outsider.id, roles: [] }, prompt.id)).toBeNull();
    expect(await lintWarningPageForNodeId({ db, userId: outsider.id, roles: [] }, { memoryId, loc: 'prompt' })).toBeNull();
    expect(await lintWarningPageForNodeId(ctx(), prompt.id)).toMatchObject({ total: 1 });
  });
});

describe('#2048 S11a post-commit unavailable is not success', () => {
  it('returns null on target-batch failure without undoing the already committed source write', async () => {
    await target();
    const prompt = await source('Before');
    const committed = await M.updateNode(null, { input: { id: prompt.id, content: '{{> part signed}}' } }, ctx());
    const beforeLint = await db.node.findUniqueOrThrow({ where: { id: prompt.id } });
    const field = (resolvers as any).Node.lintWarnings;
    expect(field, 'registered lint field is missing').toEqual(expect.any(Function));
    const fault = new Error('Synthetic target-batch failure');
    const broken = { ...ctx(), db: { ...db, node: { ...db.node, findMany: async () => { throw fault; } } } } as unknown as Context;
    expect(await field(committed, { first: 50 }, broken)).toBeNull();
    expect(await db.node.findUniqueOrThrow({ where: { id: prompt.id } })).toEqual(beforeLint);
    expect(beforeLint.content).toBe('{{> part signed}}');
  });
});


/** Actual mounted Streamable HTTP, including explicit transport teardown. */
async function callMountedTool(name: string, args: Record<string, unknown>) {
  // Mounted MCP's system-memory positive control uses a real platform admin.
  // The GraphQL concealment cases retain the separate ordinary org-manager caller.
  const driver = await db.user.create({ data: { handle: `lint-transport-${generateId().slice(-10)}`, roles: ['ADMIN'] } });
  const { rawKey } = await mintUserApiKey(db, { userId: driver.id, createdBy: driver.id, label: null, issuedVia: 'test' });
  let session: string | null = null;
  const headers = () => ({ authorization: `Bearer ${rawKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) });
  const post = (body: unknown) => fetch(mcpUrl, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const decode = async (response: Response) => {
    expect(response.status).toBe(200);
    const text = await response.text();
    return JSON.parse(text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('') : text);
  };
  try {
    const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lint2048', version: '1' } } });
    session = initialized.headers.get('mcp-session-id');
    expect(session).toEqual(expect.any(String));
    expect(await decode(initialized)).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26' } });
    const ready = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(ready.status).toBe(202); await ready.text();
    const called = await decode(await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }));
    expect(called.error).toBeUndefined();
    expect(called.result.isError).not.toBe(true); // parser/refusal cannot satisfy warning assertions
    return called.result.content.filter((item: { type: string }) => item.type === 'text').map((item: { text: string }) => item.text).join('\n') as string;
  } finally {
    if (session) {
      const closed = await fetch(mcpUrl, { method: 'DELETE', headers: headers() });
      expect(closed.status).toBe(200); await closed.text();
    }
  }
}

describe('#2048 S11a actual mounted MCP result text', () => {
  it.each(['create', 'update', 'data', 'replace', 'read'])('%s explicitly serializes lint after the intended operation executes', async op => {
    await target();
    const urn = `hrn:node:${memoryUrn}:prompt`;
    if (op !== 'create') await source(op === 'replace' ? 'REPLACE_ME' : '{{> part signed}}');
    const [name, args]: [string, Record<string, unknown>] = op === 'create'
      ? ['hadron_create_node', { urn, name: 'Prompt', role: 'boot-prompt', content: '{{> part signed}}' }]
      : op === 'update' ? ['hadron_update_node', { urn, content: '{{> part signed}}', description: 'Transport update' }]
      : op === 'data' ? ['hadron_update_node_data', { nodeUrn: urn, data: { probe: 'transport' } }]
      : op === 'replace' ? ['hadron_replace_text', { nodeUrns: [urn], fields: ['content'], oldText: 'REPLACE_ME', newText: '{{> part signed}}', dryRun: false }]
      : ['hadron_get_node', { urn }];
    const text = await callMountedTool(name, args);
    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'prompt' } });
    expect(row.content).toBe('{{> part signed}}');
    if (op === 'update') expect(row.description).toBe('Transport update');
    if (op === 'data') expect(row.data).toMatchObject({ probe: 'transport' });
    if (op === 'create') expect(row.role).toBe('boot-prompt');
    expect(text).toContain('Lint warnings (1):');
    expect(text).toContain('[SIGNING_NOT_CHECKED]');
    expect(text).toMatch(/at position \d+:/);
  });
});

describe('#2048 S11a replace-text lints every changed boot source or says it did not', () => {
  it('lints a boot source that follows more than twenty ordinary changed nodes, and discloses a count beyond the cap', async () => {
    await target();
    const ordinary = Array.from({ length: 121 }, (_, i) => ({ memoryId, loc: `a-ordinary-${String(i).padStart(3, '0')}`, name: `o${i}`, content: 'REPLACE_ME' }));
    await db.node.createMany({ data: ordinary });
    await source('REPLACE_ME', 'z-late-prompt');
    const text = await callMountedTool('hadron_replace_text', { nodeUrns: [...ordinary.map(n => `hrn:node:${memoryUrn}:${n.loc}`).slice(0, 20), `hrn:node:${memoryUrn}:z-late-prompt`], fields: ['content'], oldText: 'REPLACE_ME', newText: '{{> part signed}}', dryRun: false });
    expect(text).toContain(`hrn:node:${memoryUrn}:z-late-prompt:`);
    expect(text).toContain('[SIGNING_NOT_CHECKED]');
    expect(text).not.toContain('Lint warnings not checked');
    const all = await callMountedTool('hadron_replace_text', { nodeUrns: ordinary.map(n => `hrn:node:${memoryUrn}:${n.loc}`), fields: ['content'], oldText: 'REPLACE_ME', newText: 'DONE', dryRun: false });
    expect(all).toContain('Lint warnings not checked for 1 of 101 changed node(s)');
  }, 60_000); // 121 seeded nodes and two mounted MCP sessions: well past the 5s default on a CI runner
});


describe('#2048 S11b carried source-lint P3s', () => {
  it('a readable unrelated node cannot authorize the id-based projection of a hidden source', async () => {
    const own = await source('{{> part signed}}');
    const hidden = await db.node.create({ data: { memoryId: foreignMemoryId, loc: 'hidden-source', name: 'secret', content: '{{> absent signed}}', role: 'boot-prompt' } });
    expect(await lintWarningPageForNodeId(ctx(), own.id)).not.toBeNull();
    expect(await lintWarningPageForNodeId(ctx(), hidden.id)).toBeNull();
  });
  it('opens encrypted source and target only with the memory key; unavailable is distinct from empty', async () => {
    const key = generateDataKey();
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    const part = await db.node.create({ data: { memoryId, loc: 'encrypted-part', name: 'part', ...encryptNodeFieldsWithKey({ content: 'private part' }, key) } });
    const prompt = await db.node.create({ data: { memoryId, loc: 'encrypted-source', name: 'source', role: 'boot-prompt', ...encryptNodeFieldsWithKey({ content: '{{> encrypted-part signed}}' }, key) } });
    expect(await lintWarningPageForNodeId(ctx(), prompt.id)).toBeNull();
    sessionKeyCache.set('lint2048-encrypted', memoryId, key);
    try {
      const got = await lintWarningPageForNodeId(ctx(), prompt.id);
      expect(got).toMatchObject({ total: 1, items: [{ kind: 'SIGNING_NOT_CHECKED', targetUrn: `hrn:node:${memoryUrn}:encrypted-part` }] });
      expect(JSON.stringify(got)).not.toContain('private part');
      expect(part.content).not.toBe('private part');
    } finally { sessionKeyCache.evict('lint2048-encrypted'); }
  });
});


describe('#2048 S11b transport and ambiguity controls', () => {
  it('collapses an ambiguous historical include into the same broken warning as a missing include', async () => {
    const one = await target('one'), two = await target('two');
    await db.urnAlias.createMany({ data: [one, two].map(n => ({ entityType: 'NODE' as const, entityId: n.id, reason: 'RENAME' as const, urn: 'old-lint:memory:part' })) });
    const ambiguous = await source('{{> hrn:node:old-lint:memory:part}}');
    const missing = await source('{{> hrn:node:old-lint:memory:absent}}', 'missing');
    expect(await lintWarningPageForNodeId(ctx(), ambiguous.id)).toEqual(await lintWarningPageForNodeId(ctx(), missing.id));
    expect(await lintWarningPageForNodeId(ctx(), ambiguous.id)).toMatchObject({ total: 1, items: [{ kind: 'BROKEN_INCLUDE' }] });
  });


});
