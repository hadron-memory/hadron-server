/**
 * #2712 — the disposable E2E stack's stock Agents serve an approved compiled boot prompt (cor:agt:040:06/:07). Since
 * #2712 retired the serving switch and the literal prompt column, an Agent with no approved compiled prompt refuses
 * every bind BOOT_PROMPT_NOT_SET (cor:agt:040:10), so scripts/e2e/seed.ts seeds one per Agent through this helper.
 * Shared with src/test/e2eBootPrompt.test.ts, which binds the seed's shape for real (#2725 local review P2).
 *
 * Written directly, the way the seed writes every other fixture: a source node, the compiled node it compiled to, the
 * compile revision's provenance row, approval of revision 1, and the Agent's pointer. Ids come from the caller so the
 * seed stays deterministic.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { computeApprovalHash } from '../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../lib/bootCompile/provenance.js';
import { safeNodeUrnV2 } from '../lib/urnEmit.js';

export const E2E_BOOT_PROMPT = 'You are {{worker.name}}, the synthetic {{worker.role}} fixture.';

export interface E2eBootPromptInput {
  agentId: string;
  /** The Agent's system memory; several Agents may share one, so `slot` keeps their locs apart. */
  memoryId: string;
  slot: string;
  /** Deterministic id for a named part (`source`, `compiled`). */
  idFor: (part: 'source' | 'compiled') => string;
  approvedAt: Date;
  content?: string;
}

/** Seed and point an approved compiled boot prompt for one Agent. Returns the compiled node id. */
export async function seedE2eBootPrompt(db: PrismaClient, input: E2eBootPromptInput): Promise<string> {
  const content = input.content ?? E2E_BOOT_PROMPT;
  const memory = await db.memory.findUniqueOrThrow({ where: { id: input.memoryId }, select: { urn: true } });
  const source = await db.node.create({ data: {
    id: input.idFor('source'), memoryId: input.memoryId, loc: `boot:${input.slot}:source`, name: `${input.slot} boot source`,
    content, role: 'boot-prompt', tags: ['e2e'],
  } });
  const compiled = await withCompileWrite(() => db.node.create({ data: {
    id: input.idFor('compiled'), memoryId: input.memoryId, loc: `boot:${input.slot}:compiled`, name: `${input.slot} boot prompt`,
    content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE, tags: ['e2e'],
  } }));
  const provenance: CompiledProvenance = {
    version: 1,
    occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: source.id, revNo: source.revSeq, hash: sha256Hex(content),
      selection: { rev: null, approved: true, signed: false } }],
  };
  await db.compiledPromptRevision.create({ data: {
    compiledNodeId: compiled.id, compiledRevNo: compiled.revSeq, contentHash: sha256Hex(content), targetKind: 'AGENT',
    targetAgentId: input.agentId, provenance: provenance as never, occurrenceCount: 1,
  } });
  await db.node.update({ where: { id: compiled.id }, data: {
    approvedRevNo: compiled.revSeq, approvedAt: input.approvedAt, approvedByInfo: 'e2e seed',
    approvalHash: computeApprovalHash({ title: compiled.name, abstract: compiled.abstract, content: compiled.content }),
  } });
  await db.agent.update({ where: { id: input.agentId }, data: {
    bootPromptNodeId: compiled.id, bootPromptUrn: safeNodeUrnV2(memory.urn, compiled.loc),
  } });
  return compiled.id;
}
