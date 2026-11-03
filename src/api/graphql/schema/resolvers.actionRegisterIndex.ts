/**
 * #3287 — `Query.actionRegisterIndex`: an App's action-register index, computed
 * at read (ruling 0101 A: no stored edge; ruling 0102 A: one server field the
 * CLI and the portal share). cor:agt:110:04 Relationships, cor:agt:110:03.
 *
 * Every code the App's Team Agent's chain maps, one row each, nearest entry
 * first (step 1 of cor:agt:110:03), with its task loc resolved nearest-first
 * through the ASKING Agent's chain (step 2). Read as the caller, all or nothing
 * (ruling 0107 A): unless the caller can read every system memory on both
 * chains, through the base, the answer is the empty page an App with no Team
 * Agent gets (ruling 0060). Writes nothing and caches nothing.
 *
 * Bounded: one read per fact (the two chains, their Agents, their memories, the
 * caller's readability of all of them, the entries of every Team-chain memory,
 * and the tasks of the page's rows), so the statement count does not grow with
 * the number of codes or the chain depth.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { type Context, pageArgs, requireReadableAgent, withoutRequestCaches } from './resolvers.helpers.js';
import { resolveParticipatedApp } from './resolvers.agentTask.js';
import { locateTeamAgent } from './resolvers.worker.js';
import { agentBaseChains } from '../../../lib/agentBase.js';
import { inheritable, registerTaskLoc } from '../../../lib/actionRegister/lookup.js';
import { emitActionUrnV2, emitEntityUrnV2, registerEntryCode } from '../../../lib/urnEmit.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { filterReadableMemoryIds } from '../../../mcp/access-control.js';
import { currentActor } from '../../../lib/requestActor.js';

type State = 'MAPPED' | 'UNRESOLVED' | 'UNMAPPED';
export type ActionRegisterIndexEntry = {
  code: string; state: State;
  actionUrn: string | null; entryUrn: string | null; definedBy: string | null;
  taskLoc: string | null; taskUrn: string | null;
};
export type ActionRegisterIndexPage = { entries: ActionRegisterIndexEntry[]; total: number; hasMore: boolean };

type Args = { appRef: string; agentRef?: string | null; taskLoc?: string | null; code?: string | null; limit?: number | null; offset?: number | null };
/** One memory-bearing link of an Agent chain, nearest first. `own` is the chain's first Agent's own memory. */
type Link = { agentUrn: string; memoryId: string; own: boolean };
type Entry = { code: string; taskLoc: string | null; link: Link; loc: string };

/** Ruling 0060's answer, and the answer whenever the whole-chain gate fails (ruling 0107). */
const emptyPage = (): ActionRegisterIndexPage => ({ entries: [], total: 0, hasMore: false });

/**
 * The asking Agent (ruling 0106 A, cor:agt:110:03 "Applies to"): `agentRef`
 * must name a live Agent the caller can read that is installed in this App or
 * is the Agent of a worker cast in it. Every other ref (unknown, unreadable,
 * readable but outside this App, readable only through another tenant) is the
 * same `AgentNotFoundError(ref)`; nothing falls back to the caller's own Agent.
 * With no `agentRef`, the caller's own Agent (a worker session or an Agent
 * run); a caller with none is refused BAD_USER_INPUT.
 */
async function askingAgentId(c: Context, appId: string, agentRef: string | null | undefined): Promise<string> {
  if (agentRef == null) {
    const own = currentActor().agentId;
    if (!own) {
      throw new GraphQLError('agentRef is required when the caller has no Agent of its own (a person, or an App key).', {
        extensions: { code: 'BAD_USER_INPUT', argumentName: 'agentRef' },
      });
    }
    return own;
  }
  const { id } = await resolveAgentRef(c.db, agentRef);
  const row = await c.db.agent.findUnique({
    where: { id }, select: { visibility: true, deletedAt: true, organizationId: true, ownerUserId: true },
  });
  await requireReadableAgent(c, row, agentRef);
  const [installed, cast] = await Promise.all([
    c.db.appAgent.findUnique({ where: { appId_agentId: { appId, agentId: id } }, select: { agentId: true } }),
    c.db.worker.findFirst({ where: { appId, agentId: id, retiredAt: null }, select: { id: true } }),
  ]);
  if (!installed && !cast) throw new AgentNotFoundError(agentRef);
  return id;
}

/** The chains of `ids` as memory-bearing links, nearest first; a deleted Agent contributes no memory (as `systemMemoryChain`). */
async function chainsOf(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, Link[]>> {
  const bases = await agentBaseChains(tx, ids);
  const members = new Set(ids);
  for (const chain of bases.values()) for (const id of chain) members.add(id);
  const agents = new Map((await tx.agent.findMany({
    where: { id: { in: [...members] } }, select: { id: true, urn: true, systemMemoryId: true, deletedAt: true },
  })).map((a) => [a.id, a]));
  const out = new Map<string, Link[]>();
  for (const id of ids) {
    const links: Link[] = [];
    for (const memberId of [id, ...(bases.get(id) ?? [])]) {
      const a = agents.get(memberId);
      if (!a || a.deletedAt || !a.systemMemoryId) continue;
      links.push({ agentUrn: a.urn, memoryId: a.systemMemoryId, own: memberId === id });
    }
    out.set(id, links);
  }
  return out;
}

/** Nearest-first pick among rows at one loc: a chain's own first memory serves anything, a base only what is inherited. */
function nearest<R extends { memoryId: string; nodeType: string; role: string | null }>(links: Link[], rows: R[]): { row: R; link: Link } | null {
  for (const link of links) {
    const row = rows.find((r) => r.memoryId === link.memoryId);
    if (row && (link.own || inheritable(row))) return { row, link };
  }
  return null;
}

/** The emitted action URN, or null for a stored code the emitter refuses (as `Node.actionUrn`). */
function actionUrnOf(agentUrn: string, code: string): string | null {
  try { return emitActionUrnV2(agentUrn, code); } catch { return null; }
}

export async function loadActionRegisterIndex(tx: Prisma.TransactionClient, c: Context, args: Args): Promise<ActionRegisterIndexPage> {
  // The App audience gate first (registerRoleCandidates'): nothing is read for a refused App.
  const { app } = await resolveParticipatedApp(c, args.appRef);
  const askingId = await askingAgentId(c, app.id, args.agentRef);
  let teamId: string;
  try {
    const team = await locateTeamAgent(c, app.id, undefined);
    if (!team.systemMemoryId) return emptyPage();
    teamId = team.id;
  } catch (e) {
    if (e instanceof GraphQLError && ['TEAM_AGENT_NOT_FOUND', 'TEAM_AGENT_AMBIGUOUS'].includes(String(e.extensions.code))) return emptyPage();
    throw e;
  }
  const chains = await chainsOf(tx, [teamId, askingId]);
  const teamChain = chains.get(teamId) ?? [];
  const askingChain = chains.get(askingId) ?? [];
  if (!teamChain.length || !teamChain[0]!.own) return emptyPage();

  // Whole-chain gate (ruling 0107 A): every system memory on both chains, read as the caller. A
  // deleted memory counts as unreadable. Leaving out only unreadable rows would let a readable
  // base entry beside an unmapped or unresolved row reveal a nearer node the caller can't read.
  const memoryIds = [...new Set([...teamChain, ...askingChain].map((l) => l.memoryId))];
  const memories = new Map((await tx.memory.findMany({
    where: { id: { in: memoryIds } }, select: { id: true, urn: true, deletedAt: true },
  })).map((m) => [m.id, m]));
  const readable = await filterReadableMemoryIds(tx as never, c as never, memoryIds);
  for (const id of memoryIds) if (!readable.has(id) || !memories.get(id) || memories.get(id)!.deletedAt) return emptyPage();
  const memUrn = (id: string) => memories.get(id)!.urn;

  // Step 1: every entry the Team Agent's chain reaches, nearest per code. The install memory is
  // never on an Agent chain, so it is never read. A nearest malformed entry is UNMAPPED: no farther
  // entry replaces it (cor:agt:110:03).
  const teamMemoryIds = teamChain.map((l) => l.memoryId);
  const entryRows = await tx.$queryRaw<Array<{ memoryId: string; loc: string; data: unknown; nodeType: string; role: string | null }>>`
    SELECT n.memory_id AS "memoryId", n.loc, n.data, n.node_type AS "nodeType", n.role
    FROM nodes n
    WHERE n.memory_id = ANY(${teamMemoryIds}::text[]) AND n.deleted_at IS NULL AND n.loc LIKE 'register:%'`;
  const byCode = new Map<string, typeof entryRows>();
  for (const r of entryRows) {
    const code = registerEntryCode(r.loc);
    if (code === null) continue;
    const list = byCode.get(code) ?? [];
    list.push(r);
    byCode.set(code, list);
  }
  let entries: Entry[] = [];
  for (const [code, rows] of byCode) {
    const hit = nearest(teamChain, rows);
    if (hit) entries.push({ code, taskLoc: registerTaskLoc(hit.row.data, code), link: hit.link, loc: hit.row.loc });
  }
  // Code order (code-point), so a page boundary is stable.
  entries.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  if (args.code != null) entries = entries.filter((e) => e.code === args.code);
  if (args.taskLoc != null) entries = entries.filter((e) => e.taskLoc === args.taskLoc);

  // Counted after the gate and the filters; the page is filled from these rows only.
  const { take, skip } = pageArgs(args);
  const page = entries.slice(skip, skip + take);

  // Step 2: each page row's task loc, nearest first through the asking Agent's chain. A nearest
  // node that isn't runnable is UNRESOLVED: no farther task is used.
  const locs = [...new Set(page.flatMap((e) => (e.taskLoc ? [e.taskLoc] : [])))];
  const askingMemoryIds = askingChain.map((l) => l.memoryId);
  const taskRows = locs.length && askingMemoryIds.length
    ? await tx.$queryRaw<Array<{ memoryId: string; loc: string; isRunnable: boolean | null; nodeType: string; role: string | null }>>`
        SELECT n.memory_id AS "memoryId", n.loc, n.is_runnable AS "isRunnable", n.node_type AS "nodeType", n.role
        FROM nodes n
        WHERE n.memory_id = ANY(${askingMemoryIds}::text[]) AND n.loc = ANY(${locs}::text[]) AND n.deleted_at IS NULL`
    : [];

  const out: ActionRegisterIndexEntry[] = page.map((e) => {
    if (!e.taskLoc) return { code: e.code, state: 'UNMAPPED', actionUrn: null, entryUrn: null, definedBy: null, taskLoc: null, taskUrn: null };
    const hit = nearest(askingChain, taskRows.filter((t) => t.loc === e.taskLoc));
    const taskUrn = hit && hit.row.isRunnable ? `hrn:node:${memUrn(hit.row.memoryId)}:${hit.row.loc}` : null;
    return {
      code: e.code,
      state: taskUrn ? 'MAPPED' : 'UNRESOLVED',
      actionUrn: actionUrnOf(e.link.agentUrn, e.code),
      entryUrn: `hrn:node:${memUrn(e.link.memoryId)}:${e.loc}`,
      definedBy: emitEntityUrnV2('agent', e.link.agentUrn),
      taskLoc: e.taskLoc,
      taskUrn,
    };
  });
  return { entries: out, total: entries.length, hasMore: skip + page.length < entries.length };
}

export const actionRegisterIndexQueries = {
  actionRegisterIndex: async (_: unknown, args: Args, ctx: Context): Promise<ActionRegisterIndexPage> =>
    ctx.db.$transaction(
      (tx) => loadActionRegisterIndex(tx, withoutRequestCaches(ctx, tx), args),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 },
    ),
};
