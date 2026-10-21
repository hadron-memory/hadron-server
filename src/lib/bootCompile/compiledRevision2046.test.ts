/**
 * #2046 (S9-1, R38) — compiled_prompt_revisions and readCompiledRevision: one
 * immutable provenance row per compiled revision, read back with THAT
 * revision's text, never the latest compile's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../bootPrompt.js';
import { CompiledRevisionIntegrityError, readCompiledRevision, sha256Hex, type CompiledProvenance } from './provenance.js';

let agentId: string;
let memoryId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'cr-org', urn: 'cr-org' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'cr-org:sys', organizationId: org.id } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'A', urn: 'cr-org:a', organizationId: org.id, systemMemoryId: memoryId } })).id;
});

const provenance = (sourceId: string, revNo: number, text: string): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: sourceId, revNo, hash: sha256Hex(text), selection: { rev: null, approved: true, signed: true } }],
});
const compiledNode = (content: string) => withCompileWrite(() => db.node.create({
  data: { id: generateId(), memoryId, loc: 'boot:compiled', name: 'Compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
}));
const record = (nodeId: string, revNo: number, content: string, sourceRev = revNo) =>
  db.compiledPromptRevision.create({
    data: {
      compiledNodeId: nodeId, compiledRevNo: revNo, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId,
      provenance: provenance('source-node', sourceRev, `source v${sourceRev}`) as never, occurrenceCount: 1,
    },
  });
/** Advance the compiled node to its next revision, keeping the old one as a history row. */
async function recompile(nodeId: string, content: string) {
  const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({ data: { nodeId, memoryId, loc: node.loc, name: node.name, content: node.content, revNo: node.revSeq, tags: [] } });
  await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { content, revSeq: node.revSeq + 1 } }));
}
const sqlCode = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return String((e as { meta?: { code?: string }; code?: string }).meta?.code ?? (e as Error).message); }
};

describe('#2046 S9-1 — the table', () => {
  it('the migration carries prisma/compiled-prompt-revision-invariants.sql verbatim', () => {
    const root = fileURLToPath(new URL('../../../prisma/', import.meta.url));
    const guard = readFileSync(join(root, 'compiled-prompt-revision-invariants.sql'), 'utf8');
    const migration = readFileSync(join(root, 'migrations/20261022000000_compiled_prompt_revisions/migration.sql'), 'utf8');
    expect(migration.endsWith(guard)).toBe(true);
  });

  it('a row is immutable: an UPDATE is refused and the row is unchanged', async () => {
    const node = await compiledNode('v1');
    await record(node.id, 1, 'v1');
    const before = await db.compiledPromptRevision.findUniqueOrThrow({ where: { compiledNodeId_compiledRevNo: { compiledNodeId: node.id, compiledRevNo: 1 } } });
    expect(await sqlCode(db.$executeRaw`UPDATE compiled_prompt_revisions SET occurrence_count = 9 WHERE compiled_node_id = ${node.id}`)).not.toBe('NO_ERROR');
    expect(await db.compiledPromptRevision.findUniqueOrThrow({ where: { compiledNodeId_compiledRevNo: { compiledNodeId: node.id, compiledRevNo: 1 } } })).toEqual(before);
  });

  it('refuses a target shape that does not match its kind, a bad hash and revision 0', async () => {
    const node = await compiledNode('v1');
    const base = { compiledNodeId: node.id, contentHash: sha256Hex('v1'), targetAgentId: agentId, provenance: provenance('s', 1, 's') as never, occurrenceCount: 1 };
    expect(await sqlCode(db.compiledPromptRevision.create({ data: { ...base, compiledRevNo: 1, targetKind: 'APP_AGENT' } }))).not.toBe('NO_ERROR');
    expect(await sqlCode(db.compiledPromptRevision.create({ data: { ...base, compiledRevNo: 1, targetKind: 'AGENT', targetWorkerId: 'w' } }))).not.toBe('NO_ERROR');
    expect(await sqlCode(db.compiledPromptRevision.create({ data: { ...base, compiledRevNo: 1, targetKind: 'AGENT', contentHash: 'nope' } }))).not.toBe('NO_ERROR');
    expect(await sqlCode(db.compiledPromptRevision.create({ data: { ...base, compiledRevNo: 0, targetKind: 'AGENT' } }))).not.toBe('NO_ERROR');
    expect(await db.compiledPromptRevision.count()).toBe(0);
  });

  it('a WORKER row naming a worker that does not exist is refused by the #1162 fence', async () => {
    const node = await compiledNode('v1');
    const app = await db.app.create({ data: { id: generateId(), name: 'App', urn: 'cr-org:app', organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId } });
    const row = { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex('v1'), targetKind: 'WORKER', targetAgentId: agentId, targetAppId: app.id, provenance: provenance('s', 1, 's') as never, occurrenceCount: 1 };
    expect(await sqlCode(db.compiledPromptRevision.create({ data: { ...row, targetWorkerId: generateId() } }))).not.toBe('NO_ERROR');
    const worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId, name: 'Iris', slug: 'iris', signature: '', trailer: '' } });
    expect(await sqlCode(db.compiledPromptRevision.create({ data: { ...row, targetWorkerId: worker.id } }))).toBe('NO_ERROR');
  });

  it('a hard delete of the compiled node takes its rows with it', async () => {
    const node = await compiledNode('v1');
    await record(node.id, 1, 'v1');
    await withCompileWrite(() => db.node.delete({ where: { id: node.id } }));
    expect(await db.compiledPromptRevision.count()).toBe(0);
  });
});

describe('#2046 S9-1 — readCompiledRevision', () => {
  it('reads the current revision from the node itself, with no history row', async () => {
    const node = await compiledNode('v1');
    await record(node.id, 1, 'v1');
    const r = await readCompiledRevision(db, node.id, 1);
    expect(r).toMatchObject({ revNo: 1, content: 'v1', pruned: false, contentHash: sha256Hex('v1'), target: { kind: 'AGENT', agentId } });
    expect(sha256Hex(r!.content!)).toBe(r!.contentHash);
  });

  it('an older revision reports ITS provenance, not the newer compile\'s', async () => {
    const node = await compiledNode('v1');
    await record(node.id, 1, 'v1', 1);
    await recompile(node.id, 'v2');
    await record(node.id, 2, 'v2', 2);
    const one = await readCompiledRevision(db, node.id, 1);
    const two = await readCompiledRevision(db, node.id, 2);
    expect(one).toMatchObject({ content: 'v1', contentHash: sha256Hex('v1') });
    expect(one!.provenance.occurrences[0]).toMatchObject({ revNo: 1, hash: sha256Hex('source v1') });
    expect(two).toMatchObject({ content: 'v2', contentHash: sha256Hex('v2') });
    expect(two!.provenance.occurrences[0]).toMatchObject({ revNo: 2, hash: sha256Hex('source v2') });
  });

  it('a pruned older revision keeps its recorded provenance and reports no content', async () => {
    const node = await compiledNode('v1');
    await record(node.id, 1, 'v1');
    await recompile(node.id, 'v2');
    await record(node.id, 2, 'v2');
    await db.nodeRevision.deleteMany({ where: { nodeId: node.id, revNo: 1 } });
    expect(await readCompiledRevision(db, node.id, 1)).toMatchObject({ content: null, pruned: true, contentHash: sha256Hex('v1') });
  });

  it('a revision with no provenance row is an integrity failure, never the newer row', async () => {
    const node = await compiledNode('v1');
    await recompile(node.id, 'v2');
    await record(node.id, 2, 'v2');
    await expect(readCompiledRevision(db, node.id, 1)).rejects.toBeInstanceOf(CompiledRevisionIntegrityError);
  });

  it('a malformed provenance object is an integrity failure', async () => {
    const node = await compiledNode('v1');
    await db.compiledPromptRevision.create({
      data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex('v1'), targetKind: 'AGENT', targetAgentId: agentId, provenance: { version: 1, occurrences: [] }, occurrenceCount: 0 },
    });
    await expect(readCompiledRevision(db, node.id, 1)).rejects.toBeInstanceOf(CompiledRevisionIntegrityError);
  });

  it('answers null for a missing node or a revision past the current one', async () => {
    const node = await compiledNode('v1');
    await record(node.id, 1, 'v1');
    expect(await readCompiledRevision(db, generateId(), 1)).toBeNull();
    expect(await readCompiledRevision(db, node.id, 2)).toBeNull();
    expect(await readCompiledRevision(db, node.id, 0)).toBeNull();
  });
});
