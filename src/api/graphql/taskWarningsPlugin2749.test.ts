/**
 * #2749 — the response-level warning carrier, exercised through the real Apollo plugin hooks and the real mutation
 * delegates on a private synthetic database. Pins existing behavior (cor:agt:110:02, cor:dmo:150:07):
 *  - the per-request reset: a Context reused by a later request inherits nothing, even from a late owner callback;
 *  - a root field that errors AFTER its write committed carries no warning, a sibling keeps its own, and a write
 *    rolled back by an outer transaction never advises;
 *  - the encrypted merge and restore paths and an existing section's save advise through the real response carrier;
 *  - the final response cap is MAX_WARNINGS_PER_RESPONSE over a mixed task + include response.
 */
import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from './schema/resolvers.js';
import { typeDefs } from './schema/typeDefs.js';
import { taskWarningsPlugin } from './taskWarningsPlugin.js';
import { writeNodeCore } from './schema/resolvers.mutation.node.js';
import { MAX_WARNINGS_PER_RESPONSE } from './schema/resolvers.taskWarnings.js';
import { attachIncludePinWarnings, captureIncludePinWarningLifetime } from '../../lib/includes/plainPinWarnings.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { generateDataKey } from '../../lib/crypto.js';
import { encryptNodeFields, decryptNodeFields } from '../../lib/nodeCrypto.js';
import { createTestableMcpServer } from '../../mcp/server.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const WARNING = {
  code: 'include.pin.unkept',
  text: 'A pinned include revision carries no recorded approval or signature and may be automatically pruned, breaking the include.',
};

let userId: string;
let orgId: string;
let memoryId: string;
let memoryUrn: string;
let encryptedId: string;
let appId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const pin = (loc = 'target') => `{{> ${loc} rev=1}}`;
const urnPin = () => `{{> hrn:node:${memoryUrn}:target rev=1}}`;

/** Test-local seams around the REAL delegates: they run after the real write has committed. */
const hooks: { after: ((name: string, args: any, c: Context, result: unknown) => Promise<unknown>) | null } = { after: null };
const wrap = (name: 'createNode' | 'updateNode') => async (parent: unknown, args: any, c: Context, info: unknown) => {
  const result = await M[name](parent, args, c, info);
  return hooks.after ? hooks.after(name, args, c, result) : result;
};
const server = new ApolloServer<Context>({
  typeDefs,
  resolvers: { ...resolvers, Mutation: { ...resolvers.Mutation, createNode: wrap('createNode'), updateNode: wrap('updateNode') } } as never,
  plugins: [taskWarningsPlugin],
});
const run = async (query: string, variables: Record<string, unknown> = {}, contextValue: Context = ctx()) => {
  const r = await server.executeOperation({ query, variables }, { contextValue });
  if (r.body.kind !== 'single') throw new Error('single expected');
  return r.body.singleResult;
};
const CREATE = 'mutation($i:CreateNodeInput!){createNode(input:$i){id}}';
const UPDATE = 'mutation($i:UpdateNodeInput!){updateNode(input:$i){id}}';

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  hooks.after = null;
  const org = await db.organization.create({ data: { id: generateId(), name: 'Plugin 2749', urn: 'plugin2749.example' } });
  orgId = org.id;
  const user = await db.user.create({ data: { githubId: 274901, githubUsername: 'plugin2749', handle: 'plugin2749', roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
  const memory = await M.createMemory(null, { orgId, name: 'plugin2749' }, ctx());
  memoryId = memory.id;
  memoryUrn = memory.urn;
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'target text' } });
  const encrypted = await db.memory.create({
    data: { name: 'sealed', urn: 'plugin2749.example:sealed', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
  });
  encryptedId = encrypted.id;
  const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Team', urn: 'plugin2749.example:team' } });
  appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
});

describe('request reset', () => {
  it('a Context reused by a later request inherits nothing, even from the first request\'s late owner callback', async () => {
    const c = ctx();
    let stale: ReturnType<typeof captureIncludePinWarningLifetime> | undefined;
    hooks.after = async (name, args, cc, result) => {
      if (name === 'createNode') stale = captureIncludePinWarningLifetime(cc);
      return result;
    };
    const first = await run(CREATE, { i: { memoryId, loc: 'plain', name: 'Plain', content: 'no pins here' } }, c);
    expect(first.errors).toBeUndefined();
    expect(first.extensions?.warnings).toBeUndefined();
    expect(stale).toBeDefined();

    // The first request's owner callback fires while a second request runs on the SAME Context object.
    hooks.after = async (name, args, cc, result) => {
      if (name === 'updateNode') attachIncludePinWarnings(cc, { memoryId }, pin(), undefined, cc, stale!);
      return result;
    };
    const id = (first.data as any).createNode.id;
    const second = await run(UPDATE, { i: { id, description: 'metadata only' } }, c);
    expect(second.errors).toBeUndefined();
    expect(second.extensions?.warnings).toBeUndefined();

    // Positive control: the same attach with a lifetime captured inside this request is delivered.
    hooks.after = async (name, args, cc, result) => {
      if (name === 'updateNode') attachIncludePinWarnings(cc, { memoryId }, pin(), undefined, cc, captureIncludePinWarningLifetime(cc));
      return result;
    };
    const third = await run(UPDATE, { i: { id, description: 'metadata again' } }, c);
    expect(third.extensions?.warnings).toEqual([{ path: 'updateNode', ...WARNING }]);
  });
});

describe('a field that errors after its write committed, and a rolled-back write', () => {
  it('the errored alias keeps its committed write and original error but loses its warning; the earlier sibling keeps hers', async () => {
    hooks.after = async (name, args, _c, result) => {
      if (name === 'createNode' && args.input.name === 'boom') throw new GraphQLError('late failure after commit', { extensions: { code: 'LATE_FAILURE' } });
      return result;
    };
    const r = await run(
      'mutation($a:CreateNodeInput!,$b:CreateNodeInput!){b:createNode(input:$b){id} a:createNode(input:$a){id}}',
      { a: { memoryId, loc: 'a', name: 'boom', content: pin() }, b: { memoryId, loc: 'b', name: 'fine', content: pin() } },
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors![0]).toMatchObject({ message: 'late failure after commit', path: ['a'], extensions: { code: 'LATE_FAILURE' } });
    expect(r.data).toBeNull(); // createNode is non-null, so its error nulls the mutation root
    expect(await db.node.count({ where: { memoryId, loc: { in: ['a', 'b'] } } })).toBe(2);
    expect(r.extensions?.warnings).toEqual([{ path: 'b', ...WARNING }]);
  });

  const outerWrite = async (commit: boolean, c: Context) => {
    const effects: Array<() => void> = [];
    try {
      await db.$transaction(async (tx) => {
        await writeNodeCore({ memoryId, loc: 'nested', name: 'Nested', content: pin() } as never, c, 'create', {
          governedContext: 'node-write',
          transaction: { tx, pooledDb: db, afterCommit: (effect) => effects.push(effect) },
        });
        if (!commit) throw new Error('injected rollback');
      });
    } catch (e) {
      if ((e as Error).message !== 'injected rollback') throw e;
      return;
    }
    for (const effect of effects) effect();
  };

  it('a nested write rolled back by an outer transaction persists nothing and advises nothing; the committed twin advises', async () => {
    const control = await M.createNode(null, { input: { memoryId, loc: 'control', name: 'Control', content: 'plain' } }, ctx());
    for (const commit of [false, true]) {
      await db.node.deleteMany({ where: { memoryId, loc: 'nested' } });
      hooks.after = async (name, _args, c) => {
        if (name === 'updateNode') await outerWrite(commit, c);
        return control;
      };
      const r = await run(UPDATE, { i: { id: control.id, description: `round ${commit}` } });
      expect(r.errors).toBeUndefined();
      expect(await db.node.count({ where: { memoryId, loc: 'nested', deletedAt: null } })).toBe(commit ? 1 : 0);
      expect(r.extensions?.warnings).toEqual(commit ? [{ path: 'updateNode', ...WARNING }] : undefined);
    }
  });
});

describe('encrypted merge and restore, and a section save', () => {
  const encrypted = (content: string) => encryptNodeFields({ content }, { id: encryptedId, isEncrypted: true }).content!;
  const sealedNode = (loc: string, content: string) =>
    db.node.create({ data: { id: generateId(), memoryId: encryptedId, loc, name: loc, content: encrypted(content) } });

  it('mergeNodes into an encrypted target advises on the merged plaintext and saves it encrypted', async () => {
    sessionKeyCache.set('s2749', encryptedId, generateDataKey());
    const source = await sealedNode('src', urnPin());
    const target = await sealedNode('tgt', 'base text');
    const r = await run(
      'mutation($i:MergeNodesInput!){mergeNodes(input:$i){id content}}',
      { i: { source: source.id, target: target.id, include: ['CONTENT'] } },
    );
    expect(r.errors).toBeUndefined();
    expect(r.extensions?.warnings).toEqual([{ path: 'mergeNodes', ...WARNING }]);
    expect((r.data as any).mergeNodes.content).toBe('base text\n\ntarget text'); // returned view splices the include
    const row = await db.node.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.content).not.toContain('{{>'); // ciphertext at rest
    expect(row.content).not.toContain('base text');
    expect(decryptNodeFields({ content: row.content }, { id: encryptedId, isEncrypted: true }).content).toBe(`base text\n\n${urnPin()}`);
  });

  it('a merge that adds no pin to the encrypted target advises nothing', async () => {
    sessionKeyCache.set('s2749', encryptedId, generateDataKey());
    const source = await sealedNode('src', 'more plain text');
    const target = await sealedNode('tgt', 'base text');
    const r = await run('mutation($i:MergeNodesInput!){mergeNodes(input:$i){id}}', { i: { source: source.id, target: target.id, include: ['CONTENT'] } });
    expect(r.errors).toBeUndefined();
    expect(r.extensions?.warnings).toBeUndefined();
  });

  it('restoreNodeRevision of an encrypted pinned revision advises; restoring an unpinned revision does not', async () => {
    sessionKeyCache.set('s2749', encryptedId, generateDataKey());
    const node = await sealedNode('doc', 'v1 plain');
    const update = (content: string) => M.updateNode(null, { input: { id: node.id, content } }, ctx());
    await update(urnPin()); // revision 2 carries the pin once the next write snapshots it
    await update('v3 plain');
    const revision = (revNo: number) => db.nodeRevision.findFirstOrThrow({ where: { nodeId: node.id, revNo } });
    const restore = (revisionId: string) =>
      run('mutation($id:ID!){restoreNodeRevision(revisionId:$id){id content}}', { id: revisionId });

    const unpinned = await restore((await revision(1)).id);
    expect(unpinned.errors).toBeUndefined();
    expect(unpinned.extensions?.warnings).toBeUndefined();
    expect((unpinned.data as any).restoreNodeRevision.content).toBe('v1 plain');
    const stored = async () => {
      const row = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(row.content).not.toContain('{{>'); // ciphertext at rest, never the plaintext
      expect(row.content).not.toContain('plain');
      return decryptNodeFields({ content: row.content }, { id: encryptedId, isEncrypted: true }).content;
    };
    expect(await stored()).toBe('v1 plain');
    const pinned = await restore((await revision(2)).id);
    expect(pinned.errors).toBeUndefined();
    expect((pinned.data as any).restoreNodeRevision.content).toBe('target text'); // returned view splices the include
    expect(await stored()).toBe(urnPin());
    expect(pinned.extensions?.warnings).toEqual([{ path: 'restoreNodeRevision', ...WARNING }]);
  });

  it('a section save that introduces a pin advises through the MCP carrier; re-saving the same pin does not', async () => {
    const client = createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });
    const urn = `hrn:node:${memoryUrn}:section`;
    expect(await client.callToolText('hadron_create_parent_node', { urn, name: 'Section', description: 'no pins' })).not.toContain('include.pin.unkept');
    const saved = await client.callToolText('hadron_create_parent_node', { urn, name: 'Section', description: pin() });
    expect(saved).toContain(`Warning [${WARNING.code}]: ${WARNING.text}`);
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'section' } })).content).toContain(pin());
    expect(await client.callToolText('hadron_create_parent_node', { urn, name: 'Section', description: pin() })).not.toContain('include.pin.unkept');
  });
});

describe('the final response cap', () => {
  it('a mixed task + include response over the cap carries exactly the first MAX_WARNINGS_PER_RESPONSE, in order, with data and no errors', async () => {
    const TASKS = 15;
    const NODES = 15;
    const task = (i: number) => `t${i}: createAgentTask(input: { appRef: "${appId}", title: "task ${i}" }) { id }`;
    const node = (i: number) => `n${i}: createNode(input: { memoryId: "${memoryId}", loc: "pinned-${i}", name: "pinned ${i}", content: "${pin()}" }) { id }`;
    const aliases = [
      ...Array.from({ length: TASKS }, (_, i) => task(i)),
      ...Array.from({ length: NODES }, (_, i) => node(i)),
    ];
    expect(TASKS + NODES).toBeGreaterThan(MAX_WARNINGS_PER_RESPONSE);
    const r = await run(`mutation { ${aliases.join(' ')} }`);
    expect(r.errors).toBeUndefined();
    expect(Object.keys(r.data as object)).toHaveLength(TASKS + NODES);
    expect(Object.values(r.data as Record<string, { id: string }>).every((v) => !!v.id)).toBe(true);
    const warnings = r.extensions?.warnings as { path: string; code: string }[];
    expect(warnings.map((w) => `${w.path}:${w.code}`)).toEqual([
      ...Array.from({ length: TASKS }, (_, i) => `t${i}:task.create.no-source`),
      ...Array.from({ length: MAX_WARNINGS_PER_RESPONSE - TASKS }, (_, i) => `n${i}:${WARNING.code}`),
    ]);
    // Every write committed even where its advice was cut.
    expect(await db.node.count({ where: { memoryId, loc: { startsWith: 'pinned-' } } })).toBe(NODES);
  });
});
