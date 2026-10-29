/**
 * #2712 — a test fixture for an Agent whose boot prompt is SERVED: an approved compiled boot-prompt node in the
 * Agent's system memory with its provenance row, named by the Agent's pointer (cor:agt:040:06/:07). It replaces the
 * literal prompt column fixtures used to set, which #2712 deleted.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';
import { computeApprovalHash } from '../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../lib/bootCompile/provenance.js';

const provenance = (sourceId: string, content: string): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: sourceId, revNo: 1, hash: sha256Hex(content), selection: { rev: null, approved: true, signed: false } }],
});

/** Serve `content` as `agentId`'s approved boot prompt; makes the Agent a system memory when it has none. Returns the compiled node id. */
export async function serveAgentBootPrompt(db: PrismaClient, agentId: string, content: string): Promise<string> {
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, select: { urn: true, organizationId: true, ownerUserId: true, systemMemoryId: true } });
  let memoryId = agent.systemMemoryId;
  if (!memoryId) {
    memoryId = (await db.memory.create({ data: {
      id: generateId(), class: 'system', name: `${agent.urn}-boot`, urn: `${agent.urn}-boot-${generateId().slice(-6).toLowerCase()}`,
      organizationId: agent.organizationId, ownerUserId: agent.ownerUserId,
    } })).id;
    await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: memoryId } });
  }
  const suffix = generateId().slice(-6).toLowerCase();
  // The source the compiled node was compiled from: casting reads the provenance to find the Agents a prompt includes from.
  const source = await db.node.create({ data: { id: generateId(), memoryId: memoryId!, loc: `boot:source-${suffix}`, name: 'source', content, role: 'boot-prompt' } });
  const loc = `boot:compiled-${suffix}`;
  const node = await withCompileWrite(() => db.node.create({ data: {
    id: generateId(), memoryId: memoryId!, loc, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE,
  } }));
  await db.compiledPromptRevision.create({ data: {
    compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId,
    provenance: provenance(source.id, content) as never, occurrenceCount: 1,
  } });
  await db.node.update({ where: { id: node.id }, data: {
    approvedRevNo: node.revSeq, approvedAt: new Date(), approvedByInfo: 'test fixture',
    approvalHash: computeApprovalHash({ title: node.name, abstract: node.abstract, content: node.content }),
  } });
  await db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: node.id, bootPromptUrn: `test:${node.id}` } });
  return node.id;
}

/**
 * Serve a boot prompt for every live Agent that has no pointer yet, so a fixture's binds, chats and runs are serveable
 * (#2712 retired the serving switch: an Agent with no approved prompt is refused BOOT_PROMPT_NOT_SET, cor:agt:040:10).
 * Call it after the fixture's Agents exist; a test about the refusal itself must not.
 */
export async function serveEveryAgent(db: PrismaClient, content = 'Test boot prompt.'): Promise<void> {
  const agents = await db.agent.findMany({ where: { bootPromptNodeId: null, deletedAt: null }, select: { id: true } });
  for (const a of agents) await serveAgentBootPrompt(db, a.id, content);
}
