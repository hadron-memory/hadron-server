/**
 * #5284 (S4 of #4360; Proposed hrn:node:hadronmemory.com:specs:cor:dmo:050:24) — `agentInstructions`: one call that
 * answers the role task to follow, with its body, or that no task fits.
 *
 * Order: the register first (with an event code, asked in an App: cor:agt:110:03), then the scored search of the
 * Agent's task list on abstracts (cor:dmo:050:15, {@link matchAgentTasks}), where only tasks at or above the floor
 * ({@link taskMatchMinScore}) count, best first, at most three. A register entry that maps while its task is not
 * in the asking Agent's list (a stale mapping) never matches by REGISTER: it falls through — with no phrase the
 * answer is NO_MATCH with the register still MAPPED, with a phrase the search arm decides as usual — the mapping
 * is reported either way, the task is never invented (#5360 B3). A task the search could
 * not score (the keyword
 * fallback when no embedding is available) can never be shown to reach the floor, so it is never a match: the answer
 * is NO_MATCH with those tasks as `nearest` (Victor's FIT on #5284, R4). On NO_MATCH asked in an App, the register's
 * `instructions.no-match` entry may name a fallback task (R6, cor:agt:110:01).
 *
 * Gates, never a new one: with `appRef`, `resolveParticipatedApp` then `askingAgentId` (live, readable, installed or
 * cast in the App: actionRegisterIndex's rule); then, in every case, the task list's own gate on the Agent's system
 * memory (`gatedAgent`, via {@link openAgentTasks}), so an unknown and an unreadable Agent are refused alike. The
 * asking Agent defaults to the caller's own (`currentActor().agentId`, from the validated session binding or run),
 * never anything the client asserts. Ranked tasks are re-read and re-authorized by the list; what is served is
 * re-verified again when hydrated (`serve`), and the decision is taken on what survives.
 *
 * Nothing is recorded, and nothing here logs: never the phrase, the event code or a task loc (the register read's
 * own failure line is a fixed category).
 */
import { GraphQLError } from 'graphql';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { requireReadableAgent } from '../../api/graphql/schema/resolvers.helpers.js';
import { resolveParticipatedApp } from '../../api/graphql/schema/resolvers.agentTask.js';
import { askingAgentId } from '../../api/graphql/schema/resolvers.actionRegisterIndex.js';
import { resolveActionAnswer, type ActionAnswer } from '../actionRegister/answer.js';
import { openAgentTasks, type AgentTaskEntry } from '../agentDefinitionLists.js';
import { resolveAgentRef } from '../entityRef/agentRef.js';
import { currentActor } from '../requestActor.js';
import { assertQueryLength, MAX_QUERY_CHARS } from '../retrieval/tsquery.js';
import { MAX_ATOM_LEN } from '../urn.js';
import { emitEntityUrnV2 } from '../urnEmit.js';
import { taskMatchMinScore } from './floor.js';

/** The most candidates (best plus runners-up) and nearest tasks one answer names. */
export const INSTRUCTIONS_LIST_MAX = 3;
/** R6 (cor:agt:110:01, reserved): the register code that names the task for a phrase no task matches. */
export const NO_MATCH_CODE = 'instructions.no-match';

export type InstructionsArgs = { agentRef?: string | null; appRef?: string | null; phrase?: string | null; eventCode?: string | null };
type Entry = AgentTaskEntry & { score?: number | null };
export type AgentInstructionsAnswer<S> = {
  state: 'MATCHED' | 'NO_MATCH';
  route: 'REGISTER' | 'SEARCH' | null;
  register: ActionAnswer | null;
  candidates: S[];
  instructions: string | null;
  nearest: S[];
  fallback: S | null;
};

/**
 * `serve` hydrates entries as the list surface serves them (re-verified, decrypted, in order, dropping any that no
 * longer pass); `body` returns the content of a served task exactly as `Node.content` resolves it for the caller.
 */
export type InstructionsSurface<S> = {
  serve: (agentId: string, entries: Entry[]) => Promise<S[]>;
  body: (served: S) => Promise<string | null>;
};

const badInput = (message: string, argumentName?: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT', ...(argumentName ? { argumentName } : {}) } });

export async function loadAgentInstructions<S>(ctx: Context, args: InstructionsArgs, surface: InstructionsSurface<S>): Promise<AgentInstructionsAnswer<S>> {
  // 1. Input, judged before any read. #5360 B2: the phrase's upper bound is the ONE bound every search surface
  // shares — assertQueryLength's refusal itself (MAX_QUERY_CHARS, the number `agentTaskList` and `findNodes`
  // already refuse at; Holger's "512 for both", 2026-11-27), so one number carries one refusal, not two messages;
  // the old separate 500 cap is gone. #5360 B1: the event code is trimmed and bounded by the register loc atom
  // bound — a code longer than an atom can be is refused here, never carried into a register read.
  const phrase = args.phrase == null ? null : args.phrase.trim();
  const eventCode = args.eventCode == null ? null : args.eventCode.trim();
  if (phrase == null && eventCode == null) throw badInput('Give a phrase, an eventCode or both.');
  if (phrase != null && !phrase) {
    throw badInput(`phrase must be 1 to ${MAX_QUERY_CHARS} characters after trimming.`, 'phrase');
  }
  if (phrase != null) {
    // The upper bound is refused by the shared helper's own error (argumentName grafted on): one refusal.
    try { assertQueryLength(phrase); } catch (e) { throw badInput((e as Error).message, 'phrase'); }
  }
  if (eventCode != null && (eventCode.length < 1 || eventCode.length > MAX_ATOM_LEN)) {
    throw badInput(`eventCode must be 1 to ${MAX_ATOM_LEN} characters after trimming (the register loc atom bound, cor:agt:110:01).`, 'eventCode');
  }
  if (eventCode != null && !args.appRef) throw badInput('eventCode needs appRef: a register is read only in an App.', 'eventCode');

  // 2. Who is asking, through the existing gates.
  let appId: string | null = null;
  let agentId: string;
  let ref: string;
  if (args.appRef) {
    ({ app: { id: appId } } = await resolveParticipatedApp(ctx, args.appRef));
    agentId = await askingAgentId(ctx, appId, args.agentRef);
    ref = args.agentRef ?? await ownAgentRef(ctx, agentId);
  } else if (args.agentRef != null) {
    agentId = (await resolveAgentRef(ctx.db, args.agentRef)).id;
    ref = args.agentRef;
  } else {
    agentId = ownAgentId();
    ref = await ownAgentRef(ctx, agentId);
  }
  const tasks = await openAgentTasks(ctx.db, ctx, agentId, ref);

  // 3. The register arm.
  let register: ActionAnswer | null = null;
  if (eventCode != null && appId) {
    register = await resolveActionAnswer(ctx, appId, eventCode, agentId);
    if (register.state === 'MAPPED') {
      const hit = await entryForUrn(ctx, tasks.entries, register.taskUrn);
      const served = hit ? await surface.serve(agentId, [hit]) : [];
      if (served.length) return { state: 'MATCHED', route: 'REGISTER', register, candidates: served, instructions: await surface.body(served[0]), nearest: [], fallback: null };
    }
  }

  // 4. The search arm: only a scored task at or above the floor matches.
  let nearestEntries: Entry[] = [];
  if (phrase != null) {
    const { vectorAvailable, ranked } = await tasks.rank(phrase);
    const floor = taskMatchMinScore();
    const above = vectorAvailable ? ranked.filter(t => t.score != null && t.score >= floor) : [];
    if (above.length) {
      const served = await surface.serve(agentId, above.slice(0, INSTRUCTIONS_LIST_MAX));
      if (served.length) return { state: 'MATCHED', route: 'SEARCH', register, candidates: served, instructions: await surface.body(served[0]), nearest: [], fallback: null };
    }
    nearestEntries = ranked.filter(t => !above.includes(t)).slice(0, INSTRUCTIONS_LIST_MAX);
  }

  // 5. No match: no candidates, no body; the nearest for diagnosis, and the register's fallback in an App (R6).
  let fallback: S | null = null;
  if (appId) {
    const answer = await resolveActionAnswer(ctx, appId, NO_MATCH_CODE, agentId);
    const hit = answer.state === 'MAPPED' ? await entryForUrn(ctx, tasks.entries, answer.taskUrn) : null;
    fallback = hit ? (await surface.serve(agentId, [{ ...hit, score: null }]))[0] ?? null : null;
  }
  const nearest = nearestEntries.length ? await surface.serve(agentId, nearestEntries) : [];
  return { state: 'NO_MATCH', route: null, register, candidates: [], instructions: null, nearest, fallback };
}

/** The caller's own Agent, from the validated binding or run; a caller with none must name one. */
function ownAgentId(): string {
  const own = currentActor().agentId;
  if (!own) {
    throw badInput('agentRef is required when the caller has no Agent of its own (a person, or an App key).', 'agentRef');
  }
  return own;
}

/**
 * The ref the refusals name for the caller's own Agent: its emitted URN, never its raw id (askingAgentId's rule).
 * Without an App this is also where the Agent's own read gate runs, so a stale or unreadable own Agent is refused
 * like any other before the list gate.
 */
async function ownAgentRef(ctx: Context, agentId: string): Promise<string> {
  const row = await ctx.db.agent.findUnique({
    where: { id: agentId },
    select: { urn: true, visibility: true, deletedAt: true, organizationId: true, ownerUserId: true },
  });
  const ref = row ? emitEntityUrnV2('agent', row.urn) : 'implicit asking Agent';
  await requireReadableAgent(ctx, row, ref);
  return ref;
}

/** The listed task a register answer names (`hrn:node:<memory urn>:<loc>`), or null when the list has none. */
async function entryForUrn(ctx: Context, entries: AgentTaskEntry[], taskUrn: string | null): Promise<Entry | null> {
  if (!taskUrn) return null;
  const memories = await ctx.db.memory.findMany({
    where: { id: { in: [...new Set(entries.map(e => e.node.memoryId))] } },
    select: { id: true, urn: true },
  });
  const urnOf = new Map(memories.map(m => [m.id, m.urn]));
  const hit = entries.find(e => `hrn:node:${urnOf.get(e.node.memoryId)}:${e.node.loc}` === taskUrn);
  return hit ? { ...hit, score: null } : null;
}
