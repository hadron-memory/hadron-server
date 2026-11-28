/**
 * #5453 PR B (Ask 5; Holger, 2026-11-27, decision record
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-27-holger-rulings-to-bo-system-nodes-and-roles,
 * section 4b: "The workers must be able to update their boot prompts. [...] The humans then must approve them.",
 * scope "Wider, for now") — a worker session writes a boot prompt SOURCE and a RULE with no grant.
 *
 * What decides is the memory's own write gate (`requireMemoryWriteAccess` on GraphQL, `canWriteToMemory` on MCP),
 * exactly as for any other node of that memory. That gate judges the PERSON behind the session, so a worker
 * session writes a source where its holder may, and nowhere else. Three things are pinned here:
 *
 *  1. every generic door admits a worker session on a source and a rule, in an ordinary memory, an Agent's
 *     system memory and an App's install memory, with no grant row anywhere;
 *  2. a session whose holder may NOT write the memory gets the answer that holder gets as a person: the same
 *     code, the same text, the same extensions, nothing about boot prompts, and for a holder who cannot read
 *     the memory the same answer whether or not the node exists;
 *  3. the compile-only guard is untouched: a worker session is refused every generic write that produces,
 *     edits, re-roles or removes a `prompt.boot.compiled` node.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, insertGrantUnguarded, raw, type World } from '../../../lib/grants/grantFixtures3668.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const COMPILED = 'prompt.boot.compiled';
const SOURCE = 'prompt.boot.source';
const RULE = 'prompt.boot.rule';
const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;

let orgId: string;
let manager: { id: string };
let reader: { id: string };
let stranger: { id: string };
let appId: string;
let workerId: string;
/** `urn` is the memory's URN, so a node URN is `hrn:node:<urn>:<loc>`. */
let plain: { id: string; urn: string };
let agentSys: { id: string; urn: string };
let install: { id: string; urn: string };

const ctxOf = (userId: string): Context => ({ db, userId, roles: [], clientId: `user:${userId}` }) as Context;
const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId, agentId: null }, fn);
const nodeUrn = (memory: { urn: string }, loc: string) => `hrn:node:${memory.urn}:${loc}`;
const put = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: 'You are Basil.', nodeType: 'system', ...extra } });
const compiled = (memoryId: string, loc = 'boot:compiled') => withCompileWrite(() => put(memoryId, loc, { role: COMPILED }));
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return String((e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).message); }
};
/** The whole answer a caller sees: the code, the text and the extensions. `ref` is blanked so two refs compare. */
const answerOf = async (p: Promise<unknown>, ref?: string) => {
  try { await p; return { ok: true as const }; } catch (e) {
    const err = e as { message: string; extensions?: Record<string, unknown> };
    const blank = (s: string) => (ref ? s.split(ref).join('<ref>') : s);
    return { ok: false as const, message: blank(err.message), extensions: JSON.parse(blank(JSON.stringify(err.extensions ?? {}))) };
  }
};
const live = (memoryId: string, loc: string) => db.node.findFirst({ where: { memoryId, loc, deletedAt: null } });
const workerRevisions = (nodeId: string) => db.nodeRevision.count({ where: { nodeId, editedByWorkerId: workerId } });

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'W Org', urn: 'w5453.example' } });
  orgId = org.id;
  const user = (n: number, handle: string) => db.user.create({ data: { githubId: 545310 + n, githubUsername: handle, handle, roles: [] } });
  manager = await user(1, 'w-manager');
  reader = await user(2, 'w-reader');
  stranger = await user(3, 'w-stranger');
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: reader.id, role: 'READER' } });
  plain = await M.createMemory(null, { orgRef: orgId, name: 'w-plain' }, ctxOf(manager.id));
  agentSys = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'w5453.example:agent-sys', organizationId: orgId } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'W agent', urn: 'w5453.example:agent', organizationId: orgId, systemMemoryId: agentSys.id } });
  const { app } = await createDbAppWithKey(db, 'w-app', orgId);
  appId = app.id;
  await createDbAppAgent(db, app.id, agent.id);
  install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'w5453.example:install', organizationId: orgId, appId, installOfAgentId: agent.id, isInstallMemory: true },
  });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Iris', slug: 'iris' } })).id;
});

const MEMORIES: Array<[string, () => { id: string; urn: string }]> = [
  ['an ordinary memory', () => plain],
  ['the Agent\'s system memory', () => agentSys],
  ['the App\'s install memory', () => install],
];

describe.each([['prompt.boot.source', SOURCE], ['prompt.boot.rule', RULE]])('#5453 Ask 5: a worker session writes a %s node with no grant', (_name, role) => {
  it.each(MEMORIES)('in %s it creates, edits, moves and deletes one; each revision records the worker; no grant exists', async (_where, memoryOf) => {
    const memory = memoryOf();
    const me = ctxOf(manager.id);
    expect(await codeOf(asWorker(() => M.createNode(null, { input: { memoryRef: memory.id, loc: 'boot:new', name: 'New', nodeType: 'system', role, content: 'first text' } }, me)))).toBe('NO_ERROR');
    const node = (await live(memory.id, 'boot:new'))!;
    expect(node).toMatchObject({ role, nodeType: 'system', content: 'first text' });
    expect(await codeOf(asWorker(() => M.updateNode(null, { input: { ref: node.id, content: 'edited by the worker', name: 'Renamed' } }, me)))).toBe('NO_ERROR');
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ content: 'edited by the worker', name: 'Renamed', role });
    expect(await codeOf(asWorker(() => M.moveNode(null, { sourceRef: node.id, targetUrn: nodeUrn(memory, 'boot:moved') }, me)))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).loc).toBe('boot:moved');
    expect(await workerRevisions(node.id)).toBeGreaterThan(0);
    expect(await codeOf(asWorker(() => M.deleteNode(null, { nodeRef: node.id }, me)))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).deletedAt).not.toBeNull();
    expect(await db.grant.count()).toBe(0);
  });
});

describe('#5453 Ask 5: the other generic doors, under a worker session, on a source and a rule', () => {
  const me = () => ctxOf(manager.id);

  it('a role change in either direction, onto and off the family, and the bare legacy role', async () => {
    const node = await put(plain.id, 'n:plain', { role: null });
    for (const role of [SOURCE, RULE, 'boot-prompt', SOURCE, 'notes']) {
      expect([role, await codeOf(asWorker(() => M.updateNode(null, { input: { ref: node.id, role } }, me())))]).toEqual([role, 'NO_ERROR']);
      expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).role).toBe(role);
    }
  });

  it('properties, data, a text replace, a node merge and an import all reach a source', async () => {
    const s = await put(plain.id, 'boot:source', { role: SOURCE });
    const other = await put(plain.id, 'boot:other', { role: SOURCE, content: 'folded text' });
    expect(await codeOf(asWorker(() => M.updateNodeProperties(null, { nodeRef: s.id, properties: { tone: 'plain' } }, me())))).toBe('NO_ERROR');
    expect(await codeOf(asWorker(() => M.updateNodeData(null, { nodeRef: s.id, data: { x: 1 } }, me())))).toBe('NO_ERROR');
    await asWorker(() => M.searchReplaceInNodes(null, { input: { nodeRefs: [s.id], fields: ['content'], oldText: 'Basil', newText: 'Eve', dryRun: false } }, me()));
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('You are Eve.');
    expect(await codeOf(asWorker(() => M.importNode(null, { input: { memoryRef: plain.id, loc: 'boot:source', content: 'imported text', contentType: 'text/markdown' } }, me())))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('imported text');
    expect(await codeOf(asWorker(() => M.mergeNodes(null, { input: { source: other.id, target: s.id } }, me())))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toContain('folded text');
  });

  it('a revision restore and an undelete of a source', async () => {
    const s = await put(plain.id, 'boot:source', { role: SOURCE });
    await M.updateNode(null, { input: { ref: s.id, content: 'second text' } }, me());
    const first = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: s.id }, orderBy: { revNo: 'asc' } });
    expect(await codeOf(asWorker(() => M.restoreNodeRevision(null, { nodeRevRef: first.id }, me())))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('You are Basil.');
    await M.deleteNode(null, { nodeRef: s.id }, me());
    expect(await codeOf(asWorker(() => M.restoreNode(null, { nodeRef: s.id }, me())))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).deletedAt).toBeNull();
  });

  it('over MCP: create, update and delete of a source and a rule (an ordinary memory and the Agent\'s system memory)', async () => {
    const mcp = createTestableMcpServer({ userId: manager.id, roles: [], clientId: `user:${manager.id}` });
    const call = (tool: string, args: Record<string, unknown>) => asWorker(() => mcp.callToolText(tool, args).then((t) => String(t), (e: Error) => `ERROR ${e.message}`));
    for (const memory of [plain, agentSys]) {
      for (const [loc, role] of [['boot:mcp-source', SOURCE], ['boot:rules:mcp', RULE]] as const) {
        const urn = nodeUrn(memory, loc);
        expect(await call('hadron_create_node', { urn, name: 'Via MCP', nodeType: 'system', role, content: 'created' })).not.toContain('ERROR');
        expect(await live(memory.id, loc)).toMatchObject({ role, content: 'created' });
        expect(await call('hadron_update_node', { urn, content: 'edited', name: 'Edited via MCP' })).not.toContain('ERROR');
        expect(await live(memory.id, loc)).toMatchObject({ content: 'edited', name: 'Edited via MCP' });
        expect(await call('hadron_delete_node', { urn })).not.toContain('ERROR');
        expect(await live(memory.id, loc)).toBeNull();
      }
    }
  });

  it('a live edit grant is neither needed nor spent: the edit goes through and the grant keeps its one use', async () => {
    const s = await put(install.id, `boot:workers:${workerId}:source`, { role: SOURCE });
    const g = await insertGrantUnguarded({ appId, userId: manager.id } as unknown as World, {
      user_id: null, worker_id: workerId, action: 'bootprompt.source.edit', action_values: { sourceNode: s.id }, max_uses: 1,
      activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: manager.id, issuer_user_id: manager.id,
      expires_at: raw(`${DB_NOW} + interval '1 hour'`),
    } as never);
    for (const content of ['first', 'second']) expect(await codeOf(asWorker(() => M.updateNode(null, { input: { ref: s.id, content } }, me())))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('second');
    expect(await db.grantEvent.count({ where: { grantId: g, action: 'USE' } })).toBe(0);
    expect((await db.grant.findUniqueOrThrow({ where: { id: g } })).useCount).toBe(0);
  });
});

describe('#5453 Ask 5: a worker session\'s clone or merge of a memory that holds sources and rules', () => {
  const seed = async () => {
    await put(plain.id, 'boot:source', { role: SOURCE });
    await put(plain.id, 'boot:rules:core', { role: RULE });
    await put(plain.id, 'notes:plain', { nodeType: 'info' });
    return compiled(plain.id);
  };

  it('a clone is no longer refused, carries the source and the rule, and still copies no compiled node', async () => {
    await seed();
    const clone = await asWorker(() => M.cloneMemory(null, { ref: plain.id, targetUrn: `hrn:mem:${plain.urn}-wclone` }, ctxOf(manager.id)));
    const rows = await db.node.findMany({ where: { memoryId: clone.id }, select: { loc: true, role: true } });
    expect(rows.map((r) => r.loc)).toEqual(expect.arrayContaining(['boot:source', 'boot:rules:core', 'notes:plain']));
    expect(rows.some((r) => r.loc === 'boot:compiled' || r.role === COMPILED)).toBe(false);
  });

  it('a merge is no longer refused, carries the source and the rule, and leaves the compiled node where it is', async () => {
    const c = await seed();
    const target = await M.createMemory(null, { orgRef: orgId, name: 'w-target' }, ctxOf(manager.id));
    expect(await codeOf(asWorker(() => M.mergeMemories(null, { input: { source: plain.id, target: target.id } }, ctxOf(manager.id))))).toBe('NO_ERROR');
    const rows = await db.node.findMany({ where: { memoryId: target.id, deletedAt: null }, select: { loc: true, role: true } });
    expect(rows.map((r) => r.loc)).toEqual(expect.arrayContaining(['boot:source', 'boot:rules:core', 'notes:plain']));
    expect(rows.some((r) => r.loc === 'boot:compiled' || r.role === COMPILED)).toBe(false);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).memoryId).toBe(plain.id);
  });

  it('a merge that folds a plain node onto a source of the target is admitted; onto a compiled target it is still refused', async () => {
    const target = await M.createMemory(null, { orgRef: orgId, name: 'w-collide' }, ctxOf(manager.id));
    const tSource = await put(target.id, 'boot:source', { role: SOURCE, content: 'target source' });
    await put(plain.id, 'boot:source', { role: null, nodeType: 'info', content: 'plain over source' });
    expect(await codeOf(asWorker(() => M.mergeMemories(null, { input: { source: plain.id, target: target.id } }, ctxOf(manager.id))))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: tSource.id } })).deletedAt).toBeNull();
    const again = await M.createMemory(null, { orgRef: orgId, name: 'w-source-2' }, ctxOf(manager.id));
    const tCompiled = await compiled(target.id);
    await put(again.id, 'boot:compiled', { role: null, nodeType: 'info', content: 'forged over compiled' });
    expect(await codeOf(asWorker(() => M.mergeMemories(null, { input: { source: again.id, target: target.id } }, ctxOf(manager.id))))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: tCompiled.id } })).content).toBe('You are Basil.');
  });
});

describe('#5453 Ask 5: a worker session whose holder may NOT write the memory is refused exactly as that holder is', () => {
  /** The four doors of the acceptance, by a ref that names the node whether or not it exists. */
  const doors = (memory: { id: string; urn: string }, loc: string, role: string): Array<[string, (c: Context) => Promise<unknown>]> => [
    ['create', (c) => M.createNode(null, { input: { memoryRef: memory.id, loc, name: 'X', nodeType: 'system', role, content: 'x' } }, c)],
    ['update', (c) => M.updateNode(null, { input: { ref: nodeUrn(memory, loc), content: 'edited' } }, c)],
    ['move', (c) => M.moveNode(null, { sourceRef: nodeUrn(memory, loc), targetUrn: nodeUrn(memory, `${loc}-moved`) }, c)],
    ['delete', (c) => M.deleteNode(null, { nodeRef: nodeUrn(memory, loc) }, c)],
  ];

  it.each([['prompt.boot.source', SOURCE], ['prompt.boot.rule', RULE]])(
    'a %s node, by a holder who reads the memory but may not write it, and by one who cannot read it: the person\'s own answer, door by door',
    async (_name, role) => {
      for (const memory of [plain, agentSys, install]) {
        const existing = await put(memory.id, 'boot:there', { role });
        for (const holder of [reader, stranger]) {
          for (const loc of ['boot:there', 'boot:absent']) {
            for (const [door, run] of doors(memory, loc, role)) {
              const asPerson = await answerOf(run(ctxOf(holder.id)));
              const asSession = await answerOf(asWorker(() => run(ctxOf(holder.id))));
              const where = `${door} ${loc} in ${memory.urn} by ${holder === reader ? 'reader' : 'stranger'}`;
              expect([where, asSession]).toEqual([where, asPerson]);
              expect([where, asSession.ok]).toEqual([where, false]);
              expect([where, JSON.stringify(asSession)]).not.toEqual([where, expect.stringMatching(/boot.prompt|BOOT_PROMPT|worker session/i)]);
            }
          }
        }
        // Nothing was written by any refused call.
        expect(await db.node.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ loc: 'boot:there', content: 'You are Basil.', deletedAt: null });
        expect(await db.node.count({ where: { memoryId: memory.id, loc: { in: ['boot:absent', 'boot:absent-moved', 'boot:there-moved'] } } })).toBe(0);
      }
    },
  );

  it('a holder who cannot read the memory learns nothing: the same answer for a node that exists and one that does not', async () => {
    for (const memory of [plain, agentSys, install]) {
      await put(memory.id, 'boot:there', { role: SOURCE });
      const [there, absent] = [doors(memory, 'boot:there', SOURCE), doors(memory, 'boot:absent', SOURCE)];
      for (let i = 0; i < there.length; i++) {
        const a = await answerOf(asWorker(() => there[i][1](ctxOf(stranger.id))), 'boot:there');
        const b = await answerOf(asWorker(() => absent[i][1](ctxOf(stranger.id))), 'boot:absent');
        expect([there[i][0], memory.urn, a]).toEqual([there[i][0], memory.urn, b]);
      }
    }
  });

  it('over MCP the refusal is the memory\'s own, with no boot-prompt wording, and nothing is written', async () => {
    const s = await put(plain.id, 'boot:there', { role: SOURCE });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['hadron_update_node', { urn: nodeUrn(plain, 'boot:there'), content: 'edited' }],
      ['hadron_update_node', { urn: nodeUrn(plain, 'boot:absent'), content: 'edited' }],
      ['hadron_create_node', { urn: nodeUrn(plain, 'boot:new'), name: 'New', role: SOURCE, content: 'x' }],
      ['hadron_delete_node', { urn: nodeUrn(plain, 'boot:there') }],
    ];
    for (const holder of [reader, stranger]) {
      const mcp = createTestableMcpServer({ userId: holder.id, roles: [], clientId: `user:${holder.id}` });
      const call = (tool: string, args: Record<string, unknown>) => mcp.callToolText(tool, args).then((t) => String(t), (e: Error) => `ERROR ${e.message}`);
      for (const [tool, args] of calls) {
        const asPerson = await call(tool, args);
        const asSession = await asWorker(() => call(tool, args));
        expect([tool, args.urn, asSession]).toEqual([tool, args.urn, asPerson]);
        expect(asSession).not.toMatch(/BOOT_PROMPT|boot prompt|worker session/i);
      }
    }
    expect(await db.node.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ content: 'You are Basil.', deletedAt: null });
    expect(await db.node.count({ where: { memoryId: plain.id, loc: { in: ['boot:new', 'boot:absent'] } } })).toBe(0);
  });
});

describe('#5453 Ask 5 leaves the compile-only guard alone: a worker session and a compiled node, door by door', () => {
  const me = () => ctxOf(manager.id);
  const refused = (fn: () => Promise<unknown>) => asWorker(() => codeOf(fn()));
  const unchanged = async (id: string) => expect(await db.node.findUniqueOrThrow({ where: { id } }))
    .toMatchObject({ content: 'You are Basil.', role: COMPILED, nodeType: 'system', loc: 'boot:compiled', deletedAt: null });

  it.each(MEMORIES)('in %s: create, edit, re-role, retype, delete, move, merge and edge writes are BOOT_PROMPT_COMPILED_WRITE', async (_where, memoryOf) => {
    const memory = memoryOf();
    const c = await compiled(memory.id);
    const s = await put(memory.id, 'boot:source', { role: SOURCE });
    const writes: Array<[string, () => Promise<unknown>]> = [
      ['create', () => M.createNode(null, { input: { memoryRef: memory.id, loc: 'x:made', name: 'X', nodeType: 'system', role: COMPILED } }, me())],
      ['make compiled by role', () => M.updateNode(null, { input: { ref: s.id, role: COMPILED } }, me())],
      ['edit', () => M.updateNode(null, { input: { ref: c.id, content: 'edited' } }, me())],
      ['re-role to a source', () => M.updateNode(null, { input: { ref: c.id, role: SOURCE } }, me())],
      ['re-role to a rule', () => M.updateNode(null, { input: { ref: c.id, role: RULE } }, me())],
      ['strip the role', () => M.updateNode(null, { input: { ref: c.id, role: 'notes' } }, me())],
      ['retype', () => M.updateNode(null, { input: { ref: c.id, nodeType: 'info' } }, me())],
      ['properties', () => M.updateNodeProperties(null, { nodeRef: c.id, properties: { x: 1 } }, me())],
      ['delete', () => M.deleteNode(null, { nodeRef: c.id }, me())],
      ['move', () => M.moveNode(null, { sourceRef: c.id, targetUrn: nodeUrn(memory, 'elsewhere:compiled') }, me())],
      ['merge as source', () => M.mergeNodes(null, { input: { source: c.id, target: s.id } }, me())],
      ['merge as target', () => M.mergeNodes(null, { input: { source: s.id, target: c.id } }, me())],
      ['edge', () => M.createEdge(null, { sourceRef: c.id, targetRef: s.id, name: 'cites' }, me())],
    ];
    for (const [name, write] of writes) expect([name, await refused(write)]).toEqual([name, 'BOOT_PROMPT_COMPILED_WRITE']);
    await unchanged(c.id);
    expect(await db.node.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ role: SOURCE, deletedAt: null });
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'x:made' } })).toBe(0);
  });

  it('a text replace skips it, MCP refuses create, update and delete, and a revision restore and an undelete are refused', async () => {
    const c = await compiled(plain.id);
    await asWorker(() => M.searchReplaceInNodes(null, { input: { nodeRefs: [c.id], fields: ['content'], oldText: 'Basil', newText: 'Eve', dryRun: false } }, me()));
    await unchanged(c.id);
    const mcp = createTestableMcpServer({ userId: manager.id, roles: [], clientId: `user:${manager.id}` });
    const call = (tool: string, args: Record<string, unknown>) => asWorker(() => mcp.callToolText(tool, args).then((t) => String(t), (e: Error) => e.message));
    expect(await call('hadron_update_node', { urn: nodeUrn(plain, 'boot:compiled'), content: 'edited' })).toContain('BOOT_PROMPT_COMPILED_WRITE');
    expect(await call('hadron_delete_node', { urn: nodeUrn(plain, 'boot:compiled') })).toContain('BOOT_PROMPT_COMPILED_WRITE');
    expect(await call('hadron_create_node', { urn: nodeUrn(plain, 'x:mcp'), name: 'X', nodeType: 'system', role: COMPILED })).toContain('BOOT_PROMPT_COMPILED_WRITE');
    await unchanged(c.id);
    // A second compile leaves a first revision to restore.
    await withCompileWrite(() => M.updateNode(null, { input: { ref: c.id, content: 'second compile' } }, me()));
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: c.id } });
    expect(await refused(() => M.restoreNodeRevision(null, { nodeRevRef: rev.id }, me()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('second compile');
    await db.node.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    expect(await refused(() => M.restoreNode(null, { nodeRef: c.id }, me()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).not.toBeNull();
  });
});
