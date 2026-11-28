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
import { BOOT_PROMPT_COMPILED_ROLE, BOOT_PROMPT_NODE_TYPE, BOOT_PROMPT_SOURCE_ROLE, withCompileWrite } from '../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../lib/bootCompile/provenance.js';
import { ensureInstallRegisterRows } from '../lib/registerInstall.js';
import { listAppInstallations } from '../lib/appInstallations.js';
import { safeNodeUrnV2 } from '../lib/urnEmit.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { workerNames } from './e2eWorkerNames.js';

export const E2E_STOCK_ROLES = ['coordinator', 'qa-engineer'] as const;

/** #3160: the one conversation the seed gives the stock Agents, so stack QA can start a chat with `coordinator`. */
export const E2E_CONVERSATION = 'welcome';
export const E2E_CONVERSATION_PROMPT = 'Greet the tester and say this is a disposable E2E fixture.';

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
    content, role: BOOT_PROMPT_SOURCE_ROLE, nodeType: BOOT_PROMPT_NODE_TYPE, tags: ['e2e'],
  } });
  const compiled = await withCompileWrite(() => db.node.create({ data: {
    id: input.idFor('compiled'), memoryId: input.memoryId, loc: `boot:${input.slot}:compiled`, name: `${input.slot} boot prompt`,
    content, role: BOOT_PROMPT_COMPILED_ROLE, nodeType: BOOT_PROMPT_NODE_TYPE, tags: ['e2e'],
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

/**
 * The E2E seed's stock Agents for one org's team App: per role an Agent on the org's shared system memory, its install,
 * its read grant on the App memory, the worker's working memory, the worker, and its served boot prompt. scripts/e2e/seed.ts
 * calls exactly this, and src/test/e2eBootPrompt.test.ts binds what it builds, so the two cannot drift apart.
 */
export async function seedE2eStockAgents(db: PrismaClient, o: {
  org: string; organizationId: string; appId: string; systemMemoryId: string; appMemoryId: string;
  id: (name: string) => string; approvedAt: Date;
}): Promise<void> {
  for (const role of E2E_STOCK_ROLES) {
    const agentId = o.id(`${o.org}:${role}`);
    await db.agent.create({ data: { id: agentId, organizationId: o.organizationId,
      urn: `${o.org}:${role}`, name: role, personaRole: role,
      systemMemoryId: o.systemMemoryId, visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId: o.appId, agentId } });
    await db.agentMemoryItem.create({ data: { id: o.id(`${o.org}:${role}:item`),
      agentId, memoryId: o.appMemoryId, role: 'read' } });
    const workerMemoryId = o.id(`${o.org}:${role}:worker-memory`);
    await db.memory.create({ data: { id: workerMemoryId, organizationId: o.organizationId, appId: o.appId,
      urn: `${o.org}:${role}-working`, name: `${role} working`, class: 'app', tags: ['e2e'] } });
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: o.id(`${o.org}:${role}:worker`), appId: o.appId, agentId,
      name: workerNames[role],
      slug: role === 'coordinator' ? 'test-coordinator' : 'test-reviewer', role, memoryId: workerMemoryId } });
  }
  // Only after EVERY Agent is attached: attaching an Agent to a system memory ends every boot-prompt approval already in
  // it (boot_prompt_approval_entry_agent, prisma/boot-prompt-approval-invariants.sql), and the stock Agents share one.
  for (const role of E2E_STOCK_ROLES) {
    await seedE2eBootPrompt(db, { agentId: o.id(`${o.org}:${role}`), memoryId: o.systemMemoryId, slot: role, approvedAt: o.approvedAt,
      idFor: part => o.id(`${o.org}:${role}:boot-${part}`) });
  }
  // #3160: one ordinary top-level conversation (cor:cht:020:01 step 1: neither setup nor fallback) with one stage, in the
  // shared system memory, so an unnamed `startChat` on the coordinator (under the team App, named by appRef or carried by
  // an App credential, #5394) opens it instead of AGENT_HAS_NO_CONVERSATIONS.
  // The root `conversations` node, the conversation (data.stageOrder) and its one stage carrying the prompt.
  const conv = async (loc: string, data: object | null, content: string | null) => {
    await db.node.create({ data: { id: o.id(`${o.org}:${loc}`), memoryId: o.systemMemoryId, loc, name: loc.split(':').pop()!,
      nodeType: 'system', data: data as never, content, tags: ['e2e'] } });
  };
  await conv('conversations', null, null);
  await conv(`conversations:${E2E_CONVERSATION}`, { stageOrder: ['greet'] }, null);
  await conv(`conversations:${E2E_CONVERSATION}:greet`, {}, E2E_CONVERSATION_PROMPT);
}

/**
 * #4506 — the install-default register rows a real install writes (cor:dmo:090:04: App-owned, attendee = the installed
 * Agent, role BOTH; the register is attention, not permission). The seed builds Apps, Channels and Agents with raw
 * writes, so without this the register is empty and every register-gated path (`markOwnTeamChatRead`) refuses
 * CHANNEL_NOT_FOUND on a fresh stack. Call AFTER the App's default Channel is set (the helper is a no-op without one).
 * Idempotent (`ON CONFLICT DO NOTHING`).
 */
export async function seedE2eInstallRegister(db: PrismaClient, appId: string, opts: { agentId?: string } = {}): Promise<number> {
  return ensureInstallRegisterRows(db, appId, opts);
}

/**
 * The seed's self-check for #4506: the ids of installed Agents of `appId` that have NO live App-owned row on the App's
 * default Channel. An empty array is the pass; a merely non-empty register is not enough.
 */
export async function e2eRegisterGaps(db: PrismaClient, appId: string): Promise<string[]> {
  const app = await db.app.findUniqueOrThrow({ where: { id: appId }, select: { defaultChannelId: true } });
  const installs = await listAppInstallations(db, appId);
  const have = new Set((await db.registerEntry.findMany({
    where: { appId, channelId: app.defaultChannelId ?? '', role: 'BOTH', deletedAt: null, attendeeAgentId: { not: null } },
    select: { attendeeAgentId: true },
  })).map(r => r.attendeeAgentId));
  return installs.filter(i => !have.has(i.agentId)).map(i => i.agentId);
}
