/**
 * #5453 PR A (Asks 6 and 7) — the definition-node migration, run as the real SQL against this worker's database.
 *
 * Each test first puts the database back into the shape it had BEFORE the migration (the old CHECK, no new one),
 * builds its rows through that shape, then runs prisma/migrations/20261128010000_definition_node_roles/migration.sql
 * in one batch, as `prisma migrate deploy` sends it.
 *
 * The case that matters most: a compiled prompt that was approved and signed before the migration is served after
 * it with no re-approval and no re-signing, and nothing about its approval, signature, provenance, `compiled-from`
 * edge or pointer has changed.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { generateId } from './id.js';
import { computeApprovalHash } from './approvalHash.js';
import { modernBootPromptKind } from './bootPrompt.js';
import { loadChatScript, type ScriptNode } from './chatScript.js';
import { sha256Hex, type CompiledProvenance } from './bootCompile/provenance.js';
import { resolveServedBootPrompt } from './bootPrompt/serve.js';
import { ensureCurrentNodeRevisionInTransaction, restorableNodeFields } from './nodeRevisionSnapshot.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from './signing/payload.js';
import { clearSignatureVerifyCache } from './signing/verify.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction } from './signing/requests.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MIGRATION = read('../../prisma/migrations/20261128010000_definition_node_roles/migration.sql');
const BACKFILL = read('../../prisma/definition-node-roles-backfill.sql');
const INVARIANTS = read('../../prisma/boot-prompt-invariants.sql');
const OLD_CHECK = read('../../prisma/migrations/20261019030000_boot_prompt_compiled_check/migration.sql');
const POST_PUSH = read('../../prisma/post-push.sql');

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

async function sql(text: string) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await c.query(text); } finally { await c.end(); }
}
/** The database as it was before #5453: the old CHECK (a compiled TYPE keeps a family role), and not the new one. */
const beforeTheMigration = () => sql(`ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_nodes_compiled_boot_prompt_kind";\n${OLD_CHECK}`);
const migrate = () => sql(MIGRATION);

let orgId: string;
let adminId: string;
let agentId: string;
let agentMem: string;
let installMem: string;
let knowledgeMem: string;
let looseSystemMem: string;
let appId: string;
let workerId: string;

beforeEach(async () => {
  await cleanDb(db);
  await beforeTheMigration();
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.PASSKEY_SIGNING_ENABLED;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'm5453', urn: 'm5453-org' } })).id;
  adminId = (await db.user.create({ data: { githubId: 545331, githubUsername: 'm5453-admin', roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  const memory = async (name: string, data: Record<string, unknown>) =>
    (await db.memory.create({ data: { id: generateId(), name, urn: `m5453-org:${name}`, organizationId: orgId, ...data } as never })).id;
  agentMem = await memory('sys', { class: 'system' });
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Ada', urn: 'm5453-org:ada', organizationId: orgId, systemMemoryId: agentMem } })).id;
  appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: 'm5453-org:app', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
  installMem = await memory('install', { class: 'system', appId, installOfAgentId: agentId, isInstallMemory: true });
  knowledgeMem = await memory('kb', { class: 'knowledge' });
  // A `system` memory that is no Agent's system memory and no install memory: not a placement, so not migrated by loc.
  looseSystemMem = await memory('loose', { class: 'system' });
  workerId = (await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'W', slug: 'w', signature: '', trailer: '' } })).id;
});
afterEach(async () => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_SIGNING_ENABLED;
});
// Leave the worker's database in today's shape for the files that run after this one, whatever a test left behind.
afterAll(async () => { await cleanDb(db); await sql(INVARIANTS); });

const put = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `text of ${loc}`, ...extra } });
const kind = async (id: string) => {
  const n = await db.node.findUniqueOrThrow({ where: { id }, select: { nodeType: true, role: true } });
  return [n.nodeType, n.role];
};

describe('#5453 the migration is its two sources, and never refuses', () => {
  it('carries the data step and the constraint swap verbatim, in that order, and post-push includes both in that order', () => {
    expect(MIGRATION).toContain(BACKFILL);
    expect(MIGRATION).toContain(INVARIANTS);
    expect(MIGRATION.indexOf(BACKFILL)).toBeLessThan(MIGRATION.indexOf(INVARIANTS));
    const a = POST_PUSH.indexOf('\\ir definition-node-roles-backfill.sql');
    const b = POST_PUSH.indexOf('\\ir boot-prompt-invariants.sql');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  it('has no statement that raises: there is nothing for it to refuse on, with or without SQLSTATE HDPRF', () => {
    const code = MIGRATION.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(code).not.toMatch(/HDPRF/);
    // No trigger is switched off and no DDL runs before the constraint swap.
    expect(code.slice(0, code.indexOf('ALTER TABLE "nodes" DROP CONSTRAINT'))).not.toMatch(/\b(ALTER|CREATE|DROP)\s+\w/i);
  });

  it('takes ACCESS EXCLUSIVE on nodes before its first write, so the constraint swap is never a lock upgrade', () => {
    const lock = MIGRATION.indexOf('LOCK TABLE "nodes" IN ACCESS EXCLUSIVE MODE');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(MIGRATION.indexOf('UPDATE "nodes"'));
  });
});

describe('#5453 every row class ends as the table says', () => {
  it('retypes and re-roles by the table, leaves everything else alone, and a second run changes nothing', async () => {
    const rows: Array<[string, string, [string, string | null]]> = [];
    const add = async (what: string, memoryId: string, loc: string, extra: Record<string, unknown>, want: [string, string | null]) => {
      rows.push([what, (await put(memoryId, loc, extra)).id, want]);
    };
    const legacyCompiled = { nodeType: 'compiled-boot-prompt', role: 'boot-prompt' };
    // The boot-prompt family, wherever it lives.
    await add('compiled (Agent)', agentMem, 'boot:compiled', legacyCompiled, ['system', 'prompt.boot.compiled']);
    await add('compiled (worker, install memory)', installMem, `boot:workers:${workerId}:compiled`, legacyCompiled, ['system', 'prompt.boot.compiled']);
    await add('compiled with a dotted family role keeps being compiled', agentMem, 'boot:compiled-dotted', { nodeType: 'compiled-boot-prompt', role: 'boot-prompt.worker' }, ['system', 'prompt.boot.compiled']);
    await add('compiled, soft-deleted', agentMem, 'boot:compiled-gone', { ...legacyCompiled, deletedAt: new Date() }, ['system', 'prompt.boot.compiled']);
    await add('source (Agent)', agentMem, 'boot:source', { role: 'boot-prompt' }, ['system', 'prompt.boot.source']);
    await add('source (worker, install memory)', installMem, `boot:workers:${workerId}:source`, { role: 'boot-prompt' }, ['system', 'prompt.boot.source']);
    await add('source, soft-deleted', agentMem, 'boot:source-gone', { role: 'boot-prompt', deletedAt: new Date() }, ['system', 'prompt.boot.source']);
    await add('source in an ordinary memory', knowledgeMem, 'drafts:prompt', { role: 'boot-prompt' }, ['system', 'prompt.boot.source']);
    await add('source somebody typed keeps the type', agentMem, 'boot:typed-source', { role: 'boot-prompt', nodeType: 'prompt' }, ['system', 'prompt.boot.source']);
    await add('the legacy dotted source leaf is a source', agentMem, 'boot:legacy-dotted-source', { role: 'boot-prompt.source' }, ['system', 'prompt.boot.source']);
    await add('the legacy dotted rule leaf is a rule', agentMem, 'boot:rules:legacy-dotted', { role: 'boot-prompt.rule' }, ['system', 'prompt.boot.rule']);
    await add('node type prompt with no role gets the bare role prompt and type system', agentMem, 'notes:typed-prompt', { nodeType: 'prompt' }, ['system', 'prompt']);
    await add('node type prompt keeps the role it has', agentMem, 'notes:typed-prompt-role', { nodeType: 'prompt', role: 'spec.rule' }, ['system', 'spec.rule']);
    await add('a bare prompt role already in place is left alone', agentMem, 'notes:bare-prompt', { nodeType: 'system', role: 'prompt' }, ['system', 'prompt']);
    await add('a prompt.other role is left alone', agentMem, 'notes:prompt-other', { nodeType: 'info', role: 'prompt.other' }, ['info', 'prompt.other']);
    await add('rule', agentMem, 'boot:rules:core-channel', { role: 'boot-prompt-rule' }, ['system', 'prompt.boot.rule']);
    await add('rule, soft-deleted', agentMem, 'boot:rules:gone', { role: 'boot-prompt-rule', deletedAt: new Date() }, ['system', 'prompt.boot.rule']);
    await add('rule in an ordinary memory', knowledgeMem, 'rules:shared', { role: 'boot-prompt-rule' }, ['system', 'prompt.boot.rule']);
    await add('a family sub-kind of its own keeps it', agentMem, 'boot:coordinator', { role: 'boot-prompt.coordinator' }, ['info', 'boot-prompt.coordinator']);
    // The compiled ROLE on a node no compile wrote: a source, never a compiled prompt.
    await add('forged compiled role on an info node', agentMem, 'boot:forged-info', { role: 'prompt.boot.compiled' }, ['system', 'prompt.boot.source']);
    await add('forged compiled role on a system node', agentMem, 'boot:forged-system', { nodeType: 'system', role: 'prompt.boot.compiled' }, ['system', 'prompt.boot.source']);
    // The chatbot script, by loc, in an Agent system memory and in an install memory.
    await add('conversation', agentMem, 'conversations:welcome', { nodeType: 'system' }, ['system', 'chatbot.conversation']);
    await add('conversation written info', agentMem, 'conversations:intake', {}, ['system', 'chatbot.conversation']);
    await add('conversation, soft-deleted', agentMem, 'conversations:gone', { nodeType: 'system', deletedAt: new Date() }, ['system', 'chatbot.conversation']);
    await add('conversation in an install memory', installMem, 'conversations:welcome', { nodeType: 'system' }, ['system', 'chatbot.conversation']);
    await add('stage', agentMem, 'conversations:welcome:greet', { nodeType: 'system' }, ['system', 'chatbot.stage']);
    await add('prompt template', agentMem, 'prompts:welcome:greet', { nodeType: 'system' }, ['system', 'chatbot.prompt']);
    await add('prompt template, deeper', agentMem, 'prompts:welcome:greet:variant', { nodeType: 'system' }, ['system', 'chatbot.prompt']);
    await add('partial', agentMem, 'prompts:partials:footer', {}, ['system', 'chatbot.prompt']);
    await add('a script node that already has its chatbot role is only retyped', agentMem, 'conversations:roled', { role: 'chatbot.conversation' }, ['system', 'chatbot.conversation']);
    for (const loc of ['boot', 'boot:rules', 'conversations', 'prompts', 'prompts:welcome', 'prompts:partials']) {
      await add(`parent ${loc}`, agentMem, loc, {}, ['system', null]);
    }
    await add('parent in an install memory', installMem, 'boot', {}, ['system', null]);
    // Left alone.
    await add('a script loc with a role of its own', agentMem, 'conversations:notes', { role: 'notes' }, ['info', 'notes']);
    await add('a parent with a role of its own', agentMem, 'prompts:roled', { role: 'notes' }, ['info', 'notes']);
    await add('a record under a script loc', agentMem, 'conversations:record', { nodeType: 'record' }, ['record', null]);
    await add('a custom type under a script loc', agentMem, 'prompts:welcome:transcript', { nodeType: 'transcript' }, ['transcript', null]);
    await add('below a stage', agentMem, 'conversations:welcome:greet:extra', { nodeType: 'system' }, ['system', null]);
    await add('the processes parent', agentMem, 'processes', {}, ['info', null]);
    await add('the tasks parent', agentMem, 'tasks', {}, ['info', null]);
    await add('an ordinary node', agentMem, 'notes:plain', {}, ['info', null]);
    await add('a script loc in an ordinary memory', knowledgeMem, 'conversations:welcome', {}, ['info', null]);
    await add('a parent loc in an ordinary memory', knowledgeMem, 'boot', {}, ['info', null]);
    await add('a script loc in a system memory that is not a placement', looseSystemMem, 'conversations:welcome', {}, ['info', null]);
    // An encrypted Agent system memory: type, role and loc are plaintext columns, so its rows migrate like any other.
    const encMem = (await db.memory.create({ data: { id: generateId(), name: 'enc', urn: 'm5453-org:enc', organizationId: orgId, class: 'system', isEncrypted: true } as never })).id;
    await db.agent.create({ data: { id: generateId(), name: 'Enc', urn: 'm5453-org:enc-agent', organizationId: orgId, systemMemoryId: encMem } });
    await add('source in an encrypted memory', encMem, 'boot:source', { role: 'boot-prompt', content: 'ciphertext-as-stored' }, ['system', 'prompt.boot.source']);
    await add('conversation in an encrypted memory', encMem, 'conversations:welcome', { content: 'ciphertext-as-stored' }, ['system', 'chatbot.conversation']);

    const contentBefore = new Map((await db.node.findMany({ select: { id: true, content: true, loc: true, memoryId: true, deletedAt: true, revSeq: true } })).map((n) => [n.id, n]));
    await migrate();
    for (const [what, id, want] of rows) expect(await kind(id), what).toEqual(want);
    expect(await db.node.count({ where: { nodeType: 'compiled-boot-prompt' } })).toBe(0);
    expect(await db.node.count({ where: { role: { in: ['boot-prompt', 'boot-prompt-rule'] } } })).toBe(0);
    // Nothing but the type, the role and the fingerprint moved: content, address, tombstone and revision number are as they were.
    const after = await db.node.findMany({ select: { id: true, content: true, loc: true, memoryId: true, deletedAt: true, revSeq: true } });
    for (const n of after) expect(n, n.loc).toEqual(contentBefore.get(n.id));

    const snapshot = await db.node.findMany({ orderBy: { id: 'asc' } });
    await migrate();
    expect(await db.node.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
  });

  it('the new CHECK is in place afterwards and the old one is gone', async () => {
    await migrate();
    const names = (await sql(`SELECT conname FROM pg_constraint WHERE conrelid = '"nodes"'::regclass AND conname LIKE 'chk_nodes_compiled_boot_prompt%'`)).rows.map((r) => r.conname);
    expect(names).toEqual(['chk_nodes_compiled_boot_prompt_kind']);
    await expect(put(agentMem, 'x', { nodeType: 'compiled-boot-prompt', role: 'boot-prompt' })).rejects.toThrow(/chk_nodes_compiled_boot_prompt_kind/);
  });

  it('keeps the revision fingerprint in step: a migrated row is not read as changed outside a revisioned writer, and a row that had already drifted still is', async () => {
    const synced = await put(agentMem, 'boot:source', { role: 'boot-prompt' });
    const drifted = await put(agentMem, 'conversations:welcome', { nodeType: 'system' });
    await sql(`UPDATE nodes SET name = 'changed behind the revision system' WHERE id = '${drifted.id}'`);
    await migrate();
    const reconcile = (id: string) => db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: agentMem }));
    expect(await reconcile(synced.id)).toBe(synced.revSeq);
    expect(await db.nodeRevision.count({ where: { nodeId: synced.id } })).toBe(0);
    expect(await reconcile(drifted.id)).toBe(drifted.revSeq + 1);
  });

  it('a rule keeps the approval it had, on the node and on its revisions, though it enters the manager-approved family', async () => {
    const rule = await put(agentMem, 'boot:rules:core', { role: 'boot-prompt-rule' });
    const hash = computeApprovalHash({ title: rule.name, abstract: rule.abstract, content: rule.content });
    await db.node.update({ where: { id: rule.id }, data: { approvedRevNo: 1, approvedAt: new Date(), approvedByInfo: 'a writer, before the migration', approvalHash: hash } });
    const rev = await db.nodeRevision.create({ data: { nodeId: rule.id, memoryId: agentMem, loc: rule.loc, name: rule.name, content: 'older text', revNo: 0, tags: [], approvedAt: new Date(), approvedByInfo: 'w', approvalHash: 'c'.repeat(64) } as never });
    const before = await db.node.findUniqueOrThrow({ where: { id: rule.id }, select: { approvedRevNo: true, approvedAt: true, approvedBy: true, approvedByInfo: true, approvalHash: true } });
    await migrate();
    expect(await kind(rule.id)).toEqual(['system', 'prompt.boot.rule']);
    expect(await db.node.findUniqueOrThrow({ where: { id: rule.id }, select: { approvedRevNo: true, approvedAt: true, approvedBy: true, approvedByInfo: true, approvalHash: true } })).toEqual(before);
    expect((await db.nodeRevision.findUniqueOrThrow({ where: { id: rev.id } })).approvalHash).toBe('c'.repeat(64));
  });

  it('history is left as captured, and a restore of a capture from before the migration writes today\'s kind', async () => {
    const source = await put(agentMem, 'boot:source', { role: 'boot-prompt' });
    const ctx = { db, userId: adminId, roles: [] };
    await resolvers.Mutation.updateNode(null, { input: { ref: source.id, content: 'second text' } }, ctx as never);
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: source.id } });
    expect([rev.nodeType, rev.role]).toEqual(['info', 'boot-prompt']);
    await migrate();
    expect(await db.nodeRevision.findUniqueOrThrow({ where: { id: rev.id } })).toEqual(rev);
    await resolvers.Mutation.restoreNodeRevision(null, { nodeRevRef: rev.id }, ctx as never);
    expect(await db.node.findUniqueOrThrow({ where: { id: source.id }, select: { nodeType: true, role: true, content: true } }))
      .toEqual({ nodeType: 'system', role: 'prompt.boot.source', content: 'text of boot:source' });
  });
});

describe('#5453 the chat engine reads by loc: roles and types on the script change nothing it reads', () => {
  it('the same conversation, stage, prompt template and rule are read before and after the migration', async () => {
    const convo = await put(agentMem, 'conversations:welcome', { nodeType: 'system', data: { stageOrder: ['greet'] }, seq: 1 });
    const stage = await put(agentMem, 'conversations:welcome:greet', { data: { promptRef: 'prompts:welcome:greet' } });
    const next = await put(agentMem, 'conversations:welcome:ask', { nodeType: 'system' });
    await put(agentMem, 'prompts:welcome:greet', { content: 'Say hello to {{person.name}}.' });
    await db.edge.create({ data: { id: generateId(), memoryId: agentMem, loc: 'conversations:welcome:greet->conversations:welcome:ask', sourceId: stage.id, targetId: next.id, priority: 2, condition: { '==': [1, 1] } } as never });
    const readScript = async () => {
      const script = await loadChatScript(db, agentMem, null);
      const strip = (n: ScriptNode | null) => n && { loc: n.loc, name: n.name, content: n.content, data: n.data, seq: n.seq };
      return {
        conversation: strip(await script.node('conversations:welcome')),
        stage: strip(await script.node('conversations:welcome:greet')),
        prompt: strip(await script.node('prompts:welcome:greet')),
        stages: (await script.nodesByPrefix('conversations:welcome:')).map((n) => n.loc).sort(),
        rules: await script.outgoingRules('conversations:welcome:greet'),
      };
    };
    const before = await readScript();
    expect(before.rules).toHaveLength(1);
    await migrate();
    expect(await kind(convo.id)).toEqual(['system', 'chatbot.conversation']);
    expect(await kind(stage.id)).toEqual(['system', 'chatbot.stage']);
    expect(await readScript()).toEqual(before);
  });
});

describe('#5453 what an old capture restores as (modernBootPromptKind)', () => {
  it.each([
    [{ nodeType: 'compiled-boot-prompt', role: 'boot-prompt' }, { nodeType: 'system', role: 'prompt.boot.compiled' }],
    [{ nodeType: 'compiled-boot-prompt', role: 'boot-prompt.worker' }, { nodeType: 'system', role: 'prompt.boot.compiled' }],
    [{ nodeType: 'info', role: 'boot-prompt' }, { nodeType: 'system', role: 'prompt.boot.source' }],
    [{ nodeType: 'info', role: 'boot-prompt-rule' }, { nodeType: 'system', role: 'prompt.boot.rule' }],
    [{ nodeType: null, role: 'boot-prompt' }, { nodeType: null, role: 'prompt.boot.source' }],
    [{ nodeType: 'info', role: 'boot-prompt.rule' }, { nodeType: 'system', role: 'prompt.boot.rule' }],
    [{ nodeType: 'info', role: 'boot-prompt.source' }, { nodeType: 'system', role: 'prompt.boot.source' }],
    [{ nodeType: 'system', role: 'prompt' }, { nodeType: 'system', role: 'prompt' }],
    [{ nodeType: 'system', role: 'prompt.other' }, { nodeType: 'system', role: 'prompt.other' }],
    [{ nodeType: 'system', role: 'boot-prompt.compiled' }, { nodeType: 'system', role: 'prompt.boot.compiled' }],
    [{ nodeType: 'system', role: 'prompt.boot.source' }, { nodeType: 'system', role: 'prompt.boot.source' }],
    [{ nodeType: 'info', role: 'notes' }, { nodeType: 'info', role: 'notes' }],
    [{ nodeType: 'info', role: null }, { nodeType: 'info', role: null }],
  ])('%j -> %j', (captured, want) => {
    expect(modernBootPromptKind(captured)).toEqual(want);
  });

  it('restorableNodeFields never hands back the retired type or the bare role', () => {
    const base = { name: 'n', alias: null, description: null, abstract: null, abstractOriginHash: null, content: 'c', tags: [], objectType: null, isLink: false, properties: null, data: null, seq: null, isRunnable: false, llmModel: null, aiAgent: null, authorshipKind: null, authoredByTask: null, authoredByRevision: null, authoredByHuman: null, authoredAt: null };
    expect(restorableNodeFields({ ...base, nodeType: 'compiled-boot-prompt', role: 'boot-prompt' })).toMatchObject({ nodeType: 'system', role: 'prompt.boot.compiled' });
    expect(restorableNodeFields({ ...base, nodeType: 'info', role: 'boot-prompt' })).toMatchObject({ nodeType: 'system', role: 'prompt.boot.source' });
    expect(restorableNodeFields({ ...base, nodeType: 'info', role: 'boot-prompt-rule' })).toMatchObject({ nodeType: 'system', role: 'prompt.boot.rule' });
  });
});

describe('#5453: a compiled prompt approved and signed before the migration is served after it, unchanged', () => {
  const prov = (hash: string, nodeId: string): CompiledProvenance => ({
    version: 1,
    occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId, revNo: 1, hash, selection: { rev: null, approved: true, signed: false } }],
  });
  /** Everything the serve and its checks read about the compiled node, as stored. */
  const evidence = async (nodeId: string) => ({
    approval: await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { approvedRevNo: true, approvedAt: true, approvedBy: true, approvedByInfo: true, approvalHash: true, revSeq: true, contentRevSeq: true, content: true, name: true } }),
    revisions: await db.nodeRevision.findMany({ where: { nodeId }, orderBy: { id: 'asc' } }),
    signatures: await sql(`SELECT * FROM node_signatures WHERE node_id = '${nodeId}' ORDER BY id`).then((r) => r.rows),
    requests: await sql(`SELECT * FROM signing_requests WHERE node_id = '${nodeId}' ORDER BY id`).then((r) => r.rows),
    compiles: await db.compiledPromptRevision.findMany({ where: { compiledNodeId: nodeId }, orderBy: { compiledRevNo: 'asc' } }),
    edges: await db.edge.findMany({ where: { sourceId: nodeId }, orderBy: { id: 'asc' } }),
    pointers: {
      agent: await db.agent.findUniqueOrThrow({ where: { id: agentId }, select: { bootPromptNodeId: true, bootPromptUrn: true } }),
      worker: await db.worker.findUniqueOrThrow({ where: { id: workerId }, select: { bootPromptNodeId: true, bootPromptUrn: true } }),
    },
  });
  const serve = (surface: 'bind' | 'chat' | 'run') =>
    resolveServedBootPrompt(db, { surface, appId, agent: { id: agentId, name: 'Ada' }, workerId: surface === 'bind' ? workerId : null });

  it.each([[false, 'approval only'], [true, 'signing required and shipped']])('signing=%s (%s): a bind, a chat and a run are served the same revision before and after', async (signing) => {
    // Built entirely in the pre-migration shape: the retired type, the bare role, type `info` on the source.
    const source = await put(agentMem, 'boot:source', { role: 'boot-prompt', content: 'You are {{worker.name}}.' });
    const node = await put(agentMem, 'boot:compiled', { nodeType: 'compiled-boot-prompt', role: 'boot-prompt', name: 'Compiled boot prompt', content: 'You are {{worker.name}}.' });
    await db.compiledPromptRevision.create({ data: {
      compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(node.content!), targetKind: 'AGENT', targetAgentId: agentId,
      provenance: prov(sha256Hex(source.content!), source.id) as never, occurrenceCount: 1,
    } });
    await db.edge.create({ data: { id: generateId(), memoryId: agentMem, loc: 'boot:compiled->boot:source', name: 'compiled-from', sourceId: node.id, targetId: source.id } as never });
    await db.node.update({ where: { id: node.id }, data: {
      approvedRevNo: node.revSeq, approvedAt: new Date(), approvedBy: adminId,
      approvalHash: computeApprovalHash({ title: node.name, abstract: node.abstract, content: node.content }),
    } });
    if (signing) {
      process.env.PASSKEY_SIGNING_ENABLED = 'true';
      await db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });
      const key = softPasskey();
      await insertSoftPasskey(db, adminId, key, { firstWindow: false, label: 'Signer', rpId: RP });
      const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, node.id, {
        memoryId: agentMem, requester: { userId: adminId, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
      }));
      await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
        memoryId: agentMem, signerId: adminId, credentialId: key.credentialId,
        assertion: key.assert({ payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: node.id, approvalHash: req.approvalHash, requestId: req.id }), origin: ORIGIN, rpId: RP }),
        mayWrite: async () => true,
      }));
    }
    await db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: node.id, bootPromptUrn: `m5453-org:sys:boot:compiled` } });

    const before = await evidence(node.id);
    const servedBefore = { bind: await serve('bind'), chat: await serve('chat'), run: await serve('run') };
    expect(servedBefore.bind).toMatchObject({ compiledNodeId: node.id, servedRevSeq: 1, content: 'You are {{worker.name}}.' });
    if (signing) expect(before.signatures).toHaveLength(1);

    await migrate();
    clearSignatureVerifyCache();

    expect(await kind(node.id)).toEqual(['system', 'prompt.boot.compiled']);
    expect(await kind(source.id)).toEqual(['system', 'prompt.boot.source']);
    // No re-approval, no re-signing, no new revision: every stored fact the serve reads is byte-for-byte what it was.
    expect(await evidence(node.id)).toEqual(before);
    expect({ bind: await serve('bind'), chat: await serve('chat'), run: await serve('run') }).toEqual(servedBefore);
    // …and the next read does not cut a "changed outside a revisioned writer" revision past the approved one.
    expect(await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, node.id, { expectedMemoryId: agentMem }))).toBe(1);
    expect(await serve('bind')).toEqual(servedBefore.bind);
  });
});
