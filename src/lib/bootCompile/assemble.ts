/**
 * #2046 (S9-2) — the STRICT boot-prompt assembler: a read-only planner.
 *
 * It expands a compile's source the way cor:agt:040:12 and :08 say a compile
 * reads, and either returns a complete plan (the compiled text, the
 * revision-owned provenance occurrences, the Agents whose grants the compile
 * needs) or throws one typed {@link BootCompileRefusal}. It writes nothing:
 * provisioning grants, writing the output and its provenance belong to the
 * deciding transaction (S9-4), which re-plans under its locks.
 *
 * It shares the readers' semantics instead of copying them:
 *   - tags are parsed by S1's `locateIncludeTags` (R77 code literals, R78 v2 URNs);
 *   - a revision is chosen by S2's `selectIncludeRevision` (rev pin, approved,
 *     signed ignored until signing ships, no settings = latest);
 *   - the depth cap is S2's `MAX_RESOLVE_DEPTH` (R75: level 1..10, 11 refused).
 * Where a reader shows the broken-include notice, the compile refuses.
 *
 * Bare-loc lookup (R8, Holger "A"): nearest wins, through the includer's
 * effective memory. A tag within the target's own scope looks in the target
 * App's install memory (App and worker compiles only), then the target Agent's
 * system memory, then each base up the chain. A tag inside a part read from
 * another Agent looks in that Agent's system memory and its bases. A
 * soft-deleted node at a level counts as absent and the lookup continues (R83
 * for the install memory); a base's boot-prompt-role node is never inherited.
 * An install node that shadows an Agent-chain node at the same loc is a
 * `replacement`; it must qualify on its own (no fallback to the Agent's node).
 *
 * Sources (cor:agt:040:08): Agent system memories, each under a grant for the
 * recipient, and the target's own install memory. Anything else refuses as
 * SOURCE_DISALLOWED when the caller could read it, else as INCLUDE_UNAVAILABLE,
 * so a refusal never discloses a memory the caller cannot see.
 */

import { splitNodeUrn } from '@hadron-memory/urn-lib-js';
import { isLifecycleActive } from '@hadron-memory/access-control';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { agentBaseChain } from '../agentBase.js';
import { isBootPromptRole } from '../bootPrompt.js';
import { IncludeSyntaxError, locateIncludeTags, type IncludeTag } from '../includes/parseIncludeTags.js';
import {
  IncludeReadMemo,
  MAX_RESOLVE_DEPTH,
  selectIncludeRevision,
  type IncludeTarget,
} from '../includes/spliceIncludes.js';
import { sha256Hex, type CompiledOccurrence, type CompiledTarget } from './provenance.js';

export type BootCompileRefusalCode =
  | 'BOOT_PROMPT_INCLUDE_UNAVAILABLE'
  | 'BOOT_PROMPT_INCLUDE_RETIRED'
  | 'BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE'
  | 'BOOT_PROMPT_INCLUDE_CYCLE'
  | 'BOOT_PROMPT_INCLUDE_TOO_DEEP'
  | 'BOOT_PROMPT_INCLUDE_SOURCE_DISALLOWED'
  | 'BOOT_PROMPT_GRANT_REQUIRED'
  | 'BOOT_PROMPT_INCLUDE_MALFORMED'
  | 'BOOT_PROMPT_COMPILE_LIMIT_EXCEEDED';

/** A typed refusal. `position` is the includer tag's 1-based line/column, never the target's identity. */
export class BootCompileRefusal extends Error {
  constructor(
    readonly code: BootCompileRefusalCode,
    readonly position: { line: number; column: number } | null = null,
  ) {
    super(code);
    this.name = 'BootCompileRefusal';
  }
}

/** Who the compile is for: an org's grants, or a user-owned Agent/App owner's subscriptions. */
export type CompileRecipient = { kind: 'org'; orgId: string } | { kind: 'user'; userId: string };

export interface AssembleInput {
  target: CompiledTarget;
  /** The target App's install memory, for APP_AGENT and WORKER compiles; null for AGENT. */
  installMemoryId: string | null;
  /** The located source (sourceForCompile): its node and memory. */
  source: { nodeId: string; memoryId: string };
  recipient: CompileRecipient;
  /** Whether the caller could ordinarily read this memory: decides DISALLOWED vs UNAVAILABLE only. */
  callerCanRead: (memoryId: string) => Promise<boolean>;
}

export interface AssembleLimits {
  maxOccurrences: number;
  maxBytes: number;
}

/** Xavier 6258672877: 10,000 include occurrences and 1 MiB of compiled UTF-8 text. */
export const DEFAULT_ASSEMBLE_LIMITS: AssembleLimits = { maxOccurrences: 10_000, maxBytes: 1024 * 1024 };

export interface AssembledGrant {
  agentId: string;
  /** True when a missing same-org grant is to be provisioned by the compile. */
  provision: boolean;
}

export interface AssemblePlan {
  text: string;
  contentHash: string;
  occurrences: CompiledOccurrence[];
  grants: AssembledGrant[];
}

type Db = Pick<PrismaClient, 'node' | 'memory' | 'nodeRevision' | 'agent' | 'agentOrgGrant' | 'agentSubscription' | '$queryRaw'>;

type MemoryKind =
  | { kind: 'encrypted' }
  | { kind: 'install'; appId: string | null }
  | { kind: 'agent'; agentId: string }
  | { kind: 'other' };

const LATEST = { rev: null, approved: false, signed: false } as const;

function positionOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - before.lastIndexOf('\n') };
}

export async function assembleBootPrompt(
  db: Db,
  input: AssembleInput,
  limits: AssembleLimits = DEFAULT_ASSEMBLE_LIMITS,
): Promise<AssemblePlan> {
  const memo = new IncludeReadMemo();
  const kinds = new Map<string, Promise<MemoryKind>>();
  const chains = new Map<string, Promise<string[]>>();
  /** Each Agent's grant decision, taken the first time its memory is admitted (see admitSource). */
  const grantPlans = new Map<string, Promise<AssembledGrant>>();
  const occurrences: CompiledOccurrence[] = [];

  const kindOf = (memoryId: string): Promise<MemoryKind> => {
    let hit = kinds.get(memoryId);
    if (!hit) {
      hit = (async (): Promise<MemoryKind> => {
        const memory = await db.memory.findUnique({
          where: { id: memoryId },
          select: { class: true, isInstallMemory: true, appId: true, deletedAt: true, isEncrypted: true },
        });
        if (!memory || memory.deletedAt) return { kind: 'other' };
        // No decryption or key acquisition while compiling (6258629173): an encrypted memory never enters assembly.
        if (memory.isEncrypted) return { kind: 'encrypted' };
        if (memory.class === 'system' && memory.isInstallMemory) return { kind: 'install', appId: memory.appId };
        const agent = await db.agent.findFirst({ where: { systemMemoryId: memoryId }, select: { id: true } });
        return agent ? { kind: 'agent', agentId: agent.id } : { kind: 'other' };
      })();
      kinds.set(memoryId, hit);
    }
    return hit;
  };

  /** The system memories of an Agent and its bases, nearest first. */
  const agentChain = (agentId: string): Promise<string[]> => {
    let hit = chains.get(agentId);
    if (!hit) {
      hit = (async () => {
        const ids = [agentId, ...(await agentBaseChain(db as never, agentId))];
        const rows = await db.agent.findMany({ where: { id: { in: ids } }, select: { id: true, systemMemoryId: true } });
        const byId = new Map(rows.map((r) => [r.id, r.systemMemoryId]));
        return ids.map((id) => byId.get(id)).filter((m): m is string => !!m);
      })();
      chains.set(agentId, hit);
    }
    return hit;
  };

  /** Is this memory an allowed source? Records the Agent whose grant it needs. */
  async function admitSource(memoryId: string, position: { line: number; column: number } | null): Promise<void> {
    const kind = await kindOf(memoryId);
    if (kind.kind === 'encrypted') throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_UNAVAILABLE', position);
    if (kind.kind === 'install' && memoryId === input.installMemoryId) return;
    if (kind.kind === 'agent') {
      // Qualify the dependency BEFORE anything of it is inspected: node status, revisions and the
      // text all come after this, so a refusal can never describe content the recipient has no
      // entitlement to read (cor:agt:040:08, read under the grant alone).
      let plan = grantPlans.get(kind.agentId);
      if (!plan) {
        plan = planGrant(db, kind.agentId, input.recipient, position);
        grantPlans.set(kind.agentId, plan);
      }
      await plan;
      return;
    }
    throw new BootCompileRefusal(
      (await input.callerCanRead(memoryId)) ? 'BOOT_PROMPT_INCLUDE_SOURCE_DISALLOWED' : 'BOOT_PROMPT_INCLUDE_UNAVAILABLE',
      position,
    );
  }

  /**
   * Whether the recipient may read this memory, decided WITHOUT recording a grant and without
   * throwing: the shadow scan's question. An Agent already admitted answers from its plan; any
   * other is evaluated on the side and left out of the plan, so the scan never provisions a grant
   * or refuses a compile for a memory the output did not read.
   */
  async function admittedQuietly(memoryId: string): Promise<boolean> {
    const kind = await kindOf(memoryId);
    if (kind.kind === 'install') return memoryId === input.installMemoryId;
    if (kind.kind !== 'agent') return false;
    try {
      await (grantPlans.get(kind.agentId) ?? planGrant(db, kind.agentId, input.recipient, null));
      return true;
    } catch (e) {
      if (e instanceof BootCompileRefusal) return false;
      throw e;
    }
  }

  /** The bare-loc lookup chain for a tag written in `includerMemoryId` (R8). */
  async function lookupChain(includerMemoryId: string): Promise<{ memories: string[]; installFirst: boolean }> {
    const targetChain = await agentChain(input.target.agentId);
    const inTargetScope = includerMemoryId === input.installMemoryId || targetChain.includes(includerMemoryId);
    if (inTargetScope) {
      return input.installMemoryId
        ? { memories: [input.installMemoryId, ...targetChain], installFirst: true }
        : { memories: targetChain, installFirst: false };
    }
    const kind = await kindOf(includerMemoryId);
    if (kind.kind === 'agent') return { memories: await agentChain(kind.agentId), installFirst: false };
    return { memories: [includerMemoryId], installFirst: false };
  }

  type Found = { node: { id: string; memoryId: string; content: string | null; revSeq: number; role: string | null }; replacesNodeId?: string };

  /**
   * Nearest live node at `loc` along the chain; RETIRED when only tombstones exist there.
   * Each memory is ADMITTED (its Agent's grant qualified) before its rows are read, so a
   * tombstone or a node in a memory the recipient may not read can never shape the answer.
   */
  async function findByLoc(includerMemoryId: string, loc: string, position: { line: number; column: number }): Promise<Found> {
    const { memories, installFirst } = await lookupChain(includerMemoryId);
    let found: Found | null = null;
    let sawTombstone = false;
    for (const [i, memoryId] of memories.entries()) {
      // Before the hit, every memory is ADMITTED: it may decide the answer, so its grant is qualified
      // and planned. After the hit the output is decided; the scan only looks for the node the install
      // node replaces, and it may not widen what the compile reads, plans or refuses on (Cooper).
      if (found) {
        if (!(await admittedQuietly(memoryId))) continue;
      } else {
        await admitSource(memoryId, position);
      }
      const rows = await db.node.findMany({
        where: { memoryId, loc },
        select: { id: true, memoryId: true, content: true, revSeq: true, role: true, deletedAt: true },
      });
      if (!found && rows.some((r) => r.deletedAt)) sawTombstone = true;
      const row = rows.find((r) => !r.deletedAt);
      if (!row) continue;
      // A base's boot prompt is never inherited (R8); only the child's own and the install's count.
      const isBase = installFirst ? i >= 2 : i >= 1;
      if (isBase && isBootPromptRole(row.role)) continue;
      if (!found) {
        found = { node: row };
        // Only an install node can replace; anything else ends the lookup at its first hit.
        if (!(installFirst && i === 0)) break;
      } else if (!isBootPromptRole(row.role)) {
        // The Agent-chain node the install node shadows: the nearest one that is not a boot prompt.
        found.replacesNodeId = row.id;
        break;
      }
    }
    if (!found) {
      // RETIRED only when a soft-deleted node holds the address; a skipped base boot prompt is just absent.
      throw new BootCompileRefusal(sawTombstone ? 'BOOT_PROMPT_INCLUDE_RETIRED' : 'BOOT_PROMPT_INCLUDE_UNAVAILABLE', position);
    }
    return found;
  }

  async function findByUrn(urn: string, position: { line: number; column: number }): Promise<Found> {
    let parts: { memoryUrn: string; loc: string };
    try { parts = splitNodeUrn(urn); } catch { throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_MALFORMED', position); }
    const memory = await db.memory.findUnique({ where: { urn: parts.memoryUrn }, select: { id: true } });
    if (!memory) throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_UNAVAILABLE', position);
    await admitSource(memory.id, position);
    const row = await db.node.findFirst({
      where: { memoryId: memory.id, loc: parts.loc },
      orderBy: { deletedAt: { sort: 'asc', nulls: 'first' } },
      select: { id: true, memoryId: true, content: true, revSeq: true, role: true, deletedAt: true },
    });
    if (!row) throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_UNAVAILABLE', position);
    if (row.deletedAt) throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_RETIRED', position);
    return { node: row };
  }

  /** Occurrences are bounded as they are recorded; the byte bound is on EMITTED output (see emit). */
  const checkOccurrences = () => {
    if (occurrences.length - 1 > limits.maxOccurrences) throw new BootCompileRefusal('BOOT_PROMPT_COMPILE_LIMIT_EXCEEDED');
  };
  /**
   * The 1 MiB bound is on the compiled OUTPUT (Xavier 6258672877), never on source read: tags
   * vanish from the result, so charging them would refuse a valid result at the boundary.
   * Every output byte leaves through here exactly once, as a literal chunk cut at a tag edge
   * (a character boundary), so the sum of chunk byte lengths IS the final UTF-8 length, and
   * the compile stops at the first chunk that crosses the bound instead of building past it.
   */
  let emitted = 0;
  const emit = (chunk: string): string => {
    emitted += Buffer.byteLength(chunk, 'utf8');
    if (emitted > limits.maxBytes) throw new BootCompileRefusal('BOOT_PROMPT_COMPILE_LIMIT_EXCEEDED');
    return chunk;
  };

  async function expand(text: string, memoryId: string, parent: number, depth: number, trail: ReadonlySet<string>): Promise<string> {
    if (!text.includes('{{>')) return emit(text);
    let tags: Array<IncludeTag & { index: number }>;
    try {
      tags = locateIncludeTags(text);
    } catch (e) {
      if (e instanceof IncludeSyntaxError) {
        const at = text.indexOf(e.raw);
        throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_MALFORMED', at >= 0 ? positionOf(text, at) : null);
      }
      throw e;
    }
    let out = '';
    let cursor = 0;
    for (const tag of tags) {
      const position = positionOf(text, tag.index);
      const level = depth + 1;
      if (level > MAX_RESOLVE_DEPTH) throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_TOO_DEEP', position);
      const found = tag.kind === 'urn' ? await findByUrn(tag.target, position) : await findByLoc(memoryId, tag.target, position);
      if (tag.kind === 'loc') await admitSource(found.node.memoryId, position);
      if (trail.has(found.node.id)) throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_CYCLE', position);
      const target: IncludeTarget = {
        id: found.node.id, memoryId: found.node.memoryId, content: found.node.content, revSeq: found.node.revSeq,
        memory: { id: found.node.memoryId, isEncrypted: false },
      };
      // R79: a pin to a revision the target does not have refuses like a missing include.
      if (tag.settings.rev !== undefined && tag.settings.rev > found.node.revSeq) {
        throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_UNAVAILABLE', position);
      }
      // R79: a pin to a revision that is not stored (never kept, or pruned) is a missing include, with
      // `approved` too. Existence is decided on the pin alone, apart from qualification, so an existing
      // revision that merely fails `approved` stays REVISION_UNAVAILABLE.
      if (tag.settings.rev !== undefined && tag.settings.approved
        && !(await selectIncludeRevision(db, memo, target, { ...tag.settings, approved: false, signed: false }))) {
        throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_UNAVAILABLE', position);
      }
      const selected = await selectIncludeRevision(db, memo, target, tag.settings);
      if (!selected) {
        // An existing revision that does not qualify (approved) is REVISION_UNAVAILABLE; a pin that
        // names no stored revision (never kept, or pruned) is a missing include (R79).
        throw new BootCompileRefusal(
          tag.settings.approved ? 'BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE' : 'BOOT_PROMPT_INCLUDE_UNAVAILABLE', position,
        );
      }
      const order = occurrences.length;
      occurrences.push({
        order, depth: level, parent, kind: found.replacesNodeId ? 'replacement' : 'include',
        nodeId: found.node.id, revNo: selected.revNo, hash: sha256Hex(selected.text),
        ...(found.replacesNodeId ? { replacesNodeId: found.replacesNodeId } : {}),
        position,
        selection: { rev: tag.settings.rev ?? null, approved: tag.settings.approved === true, signed: tag.settings.signed === true },
      });
      checkOccurrences();
      out += emit(text.slice(cursor, tag.index));
      out += await expand(selected.text, found.node.memoryId, order, level, new Set([...trail, found.node.id]));
      cursor = tag.index + tag.raw.length;
    }
    return out + emit(text.slice(cursor));
  }

  // The root source: its latest revision, as written (variables stay literal).
  const root = await db.node.findUnique({
    where: { id: input.source.nodeId },
    select: { id: true, memoryId: true, content: true, revSeq: true },
  });
  if (!root) throw new BootCompileRefusal('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  await admitSource(root.memoryId, null);
  // The Agent being compiled for needs its own entitlement even when the source sits wholly in the install
  // memory (admitted directly above) and traverses none of the Agent's content (cor:agt:040:12, missing grant).
  if (!grantPlans.has(input.target.agentId)) {
    grantPlans.set(input.target.agentId, planGrant(db, input.target.agentId, input.recipient, null));
  }
  await grantPlans.get(input.target.agentId);
  const rootText = root.content ?? '';
  occurrences.push({
    order: 0, depth: 0, parent: null, kind: 'source', nodeId: root.id, revNo: root.revSeq,
    hash: sha256Hex(rootText), selection: { ...LATEST },
  });
  const text = await expand(rootText, root.memoryId, 0, 0, new Set([root.id]));

  const grants = await Promise.all([...grantPlans.keys()].sort().map((id) => grantPlans.get(id)!));
  return { text, contentHash: sha256Hex(text), occurrences, grants };
}

/**
 * The grant one used Agent needs (cor:agt:040:08), decided like an install's
 * (planOrgAgentInstallGrant) without its install prerequisite: an active grant
 * passes; a missing same-org grant is provisioned; a revoked or inactive one is
 * never revived; a foreign PUBLIC Agent needs a subscription the compile never
 * makes; a foreign non-public Agent is concealed. A user recipient needs the
 * owner's own active subscription. Read-only: the provisioning is the plan's,
 * made by the deciding transaction (S9-4).
 */
async function planGrant(
  db: Db,
  agentId: string,
  recipient: CompileRecipient,
  position: { line: number; column: number } | null,
): Promise<AssembledGrant> {
  const refuse = (code: BootCompileRefusalCode): never => { throw new BootCompileRefusal(code, position); };
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
  });
  if (!agent || agent.deletedAt) return refuse('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  const foreign = (): never =>
    refuse(agent.visibility === 'PUBLIC' ? 'BOOT_PROMPT_GRANT_REQUIRED' : 'BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  if (recipient.kind === 'user') {
    if (agent.ownerUserId === recipient.userId) return { agentId, provision: false };
    const sub = await db.agentSubscription.findUnique({ where: { userId_agentId: { userId: recipient.userId, agentId } } });
    if (sub && isLifecycleActive(sub)) return { agentId, provision: false };
    return foreign();
  }
  const grant = await db.agentOrgGrant.findUnique({ where: { orgId_agentId: { orgId: recipient.orgId, agentId } } });
  if (grant && isLifecycleActive(grant)) return { agentId, provision: false };
  if (agent.organizationId === recipient.orgId) {
    if (grant) return refuse('BOOT_PROMPT_GRANT_REQUIRED');
    return { agentId, provision: true };
  }
  return foreign();
}
