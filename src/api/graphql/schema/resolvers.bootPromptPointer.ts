import { readInstallBootPrompt } from '../../../lib/appInstallations.js';
/**
 * #2045 (S8, cor:agt:040:07) — the boot-prompt pointer READ fields on Agent,
 * AppAgent and Worker: `bootPromptRef` (the canonical URN of what the pointer
 * names now) and `bootPromptTargetDeleted` (null with no pointer, true when the
 * target is soft- or hard-deleted, false otherwise).
 *
 * Both fields of an owner sit behind ONE exposure gate, the owner's own, and a
 * masked reader sees null in both (6258606109 §5). A deleted target is never a
 * reason to widen it:
 *
 *  - Agent: a caller who may read the Agent's system memory. A PUBLIC Agent's
 *    outsider reaches the Agent object (#551) but not this.
 *  - AppAgent: the App's participants.
 *  - Worker: the worker read gate (`maySeeWorkerInternals`), like the rest of
 *    its working state.
 *
 * Every field derives through `resolveBootPromptPointer`, the seam S10's serve
 * and S11's lint share, so no surface re-derives a pointer.
 */
import type { Context } from './resolvers.helpers.js';
import { isAppParticipant, isMemoryReadableCached, loadApp } from './resolvers.helpers.js';
import { maySeeWorkerInternals, workerServeTarget } from './resolvers.worker.js';
import {
  resolveBootPromptPointer,
  type ResolvedBootPromptPointer,
  type StoredBootPromptPointer,
} from '../../../lib/bootPromptPointer.js';
import { previewServedBootPrompt, resolveServedBootPrompt, type BootPromptServeOutcome } from '../../../lib/bootPrompt/serve.js';
import { resolveAppInstallation } from '../../../lib/appInstallations.js';
import { mayReadAsAppParticipant } from '../../../lib/auth/appParticipantRead.js';
import { personalOrgAgentServeAllowed } from '../../../lib/auth/personalOrgAgentInstall.js';
import { noWorkerVariables } from '../../../lib/bootPrompt/variables.js';
import { clientReportedChatModel } from '../../../lib/bootPrompt/chatModel.js';
import { applyPlatformVariables } from '../../../lib/personaDescription.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AgentNotFoundError, AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { canChatWithAgent } from './agentChatAccess.js';

type Pointer = Partial<StoredBootPromptPointer>;

/** The parent's stored pair, re-read when a slim select left it out (never treated as "no pointer"). */
async function storedPair(
  parent: Pointer,
  load: () => Promise<StoredBootPromptPointer | null>,
): Promise<StoredBootPromptPointer> {
  if (parent.bootPromptNodeId !== undefined && parent.bootPromptUrn !== undefined) {
    return { bootPromptNodeId: parent.bootPromptNodeId, bootPromptUrn: parent.bootPromptUrn };
  }
  return (await load()) ?? { bootPromptNodeId: null, bootPromptUrn: null };
}

/** Resolve once per stored pointer per request; both fields and every sibling row share it. */
function resolvedFor(ctx: Context, pair: StoredBootPromptPointer): Promise<ResolvedBootPromptPointer | null> {
  if (pair.bootPromptNodeId === null) return Promise.resolve(null);
  const holder = ctx as Context & { bootPromptPointerCache?: Map<string, Promise<ResolvedBootPromptPointer | null>> };
  const cache = (holder.bootPromptPointerCache ??= new Map());
  const key = `${pair.bootPromptNodeId}\u0000${pair.bootPromptUrn ?? ''}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = resolveBootPromptPointer(ctx.db, pair);
    cache.set(key, pending);
  }
  return pending;
}

async function agentPointer(
  a: Pointer & { id: string; systemMemoryId?: string | null },
  ctx: Context,
): Promise<ResolvedBootPromptPointer | null> {
  const row = await storedPair(a, () =>
    ctx.db.agent.findUnique({ where: { id: a.id }, select: { bootPromptNodeId: true, bootPromptUrn: true } }));
  if (row.bootPromptNodeId === null) return null;
  if (!(await maySeeAgentPointer(a, ctx))) return null;
  return resolvedFor(ctx, row);
}

async function appAgentPointer(
  aa: Pointer & { appId: string; agentId: string },
  ctx: Context,
): Promise<ResolvedBootPromptPointer | null> {
  const row = await readInstallBootPrompt(ctx.db,aa.appId,aa.agentId) ?? {bootPromptNodeId:null,bootPromptUrn:null};
  if (row.bootPromptNodeId === null) return null;
  if (!(await maySeeAppAgentPointer(aa, ctx))) return null;
  return resolvedFor(ctx, row);
}

async function workerPointer(
  w: Pointer & { id: string; appId: string },
  ctx: Context,
): Promise<ResolvedBootPromptPointer | null> {
  const row = await storedPair(w, () =>
    ctx.db.worker.findUnique({ where: { id: w.id }, select: { bootPromptNodeId: true, bootPromptUrn: true } }));
  if (row.bootPromptNodeId === null) return null;
  if (!(await maySeeWorkerInternals(ctx, w.appId))) return null;
  return resolvedFor(ctx, row);
}

/**
 * #2045 / #2708 (cor:agt:040:07/:10) — the ONE exposure gate per owner, shared by the pointer fields above and
 * `bootPromptServe`. `bootPromptServe` judges it whether or not a pointer is set: the pointer fields may answer null for "no pointer" before gating because
 * null is their masked value too, whereas `bootPromptServe` answers NOT_SET for "no pointer", which only a caller who
 * passes the gate may learn.
 */
async function maySeeAgentPointer(a: { id: string; systemMemoryId?: string | null }, ctx: Context): Promise<boolean> {
  const systemMemoryId = a.systemMemoryId !== undefined
    ? a.systemMemoryId
    : (await ctx.db.agent.findUnique({ where: { id: a.id }, select: { systemMemoryId: true } }))?.systemMemoryId ?? null;
  return !!systemMemoryId && (await isMemoryReadableCached(ctx, systemMemoryId));
}

async function maySeeAppAgentPointer(aa: { appId: string }, ctx: Context): Promise<boolean> {
  const app = await loadApp(ctx, aa.appId);
  return !!app && !app.deletedAt && (await isAppParticipant(ctx, app));
}

async function agentNameOf(ctx: Context, agentId: string, known?: string): Promise<string> {
  if (known !== undefined) return known;
  return (await ctx.db.agent.findUnique({ where: { id: agentId }, select: { name: true } }))?.name ?? '';
}

/** The GraphQL shape: the decision's identity fields (never the text), or the refusal code. */
function serveOutcomeView(outcome: BootPromptServeOutcome) {
  if (!outcome.served) return { served: null, refusal: outcome.refusal };
  const { pointerLevel, compiledNodeId, servedRevSeq, provenanceRevSeq, compiledContentHash } = outcome.served;
  return { served: { pointerLevel, compiledNodeId, servedRevSeq, provenanceRevSeq, compiledContentHash }, refusal: null };
}

/**
 * Each target asks the bind's own resolver (`previewServedBootPrompt`) the question its level can answer:
 *  - Agent: the Agent pointer alone (no App, no worker), saying nothing about installs or workers that override it.
 *  - AppAgent: a non-customised worker of that App, or a chatbot chat in it (install pointer, then the Agent's).
 *  - Worker: that worker's next bind (`workerServeTarget`, the target `serveBindInTransaction` uses).
 * Null when the caller may not see the target's pointer; that gate is judged before anything is resolved.
 */
const bootPromptServeResolvers = {
  Agent: async (a: { id: string; name?: string; systemMemoryId?: string | null }, _: unknown, ctx: Context) => {
    if (!(await maySeeAgentPointer(a, ctx))) return null;
    const name = await agentNameOf(ctx, a.id, a.name);
    return serveOutcomeView(await previewServedBootPrompt(ctx.db, { surface: 'bind', appId: null, agent: { id: a.id, name }, workerId: null }));
  },
  AppAgent: async (aa: { appId: string; agentId: string }, _: unknown, ctx: Context) => {
    if (!(await maySeeAppAgentPointer(aa, ctx))) return null;
    const name = await agentNameOf(ctx, aa.agentId);
    return serveOutcomeView(await previewServedBootPrompt(ctx.db, { surface: 'bind', appId: aa.appId, agent: { id: aa.agentId, name }, workerId: null }));
  },
  Worker: async (w: { id: string; appId: string; agentId?: string }, _: unknown, ctx: Context) => {
    if (!(await maySeeWorkerInternals(ctx, w.appId))) return null;
    const agentId = w.agentId ?? (await ctx.db.worker.findUnique({ where: { id: w.id }, select: { agentId: true } }))?.agentId;
    if (!agentId) return null;
    const name = await agentNameOf(ctx, agentId);
    return serveOutcomeView(await previewServedBootPrompt(ctx.db, workerServeTarget({ id: w.id, appId: w.appId, agentId }, name)));
  },
};

const fields = <P>(
  pointer: (parent: P, ctx: Context) => Promise<ResolvedBootPromptPointer | null>,
  bootPromptServe: (parent: P, args: unknown, ctx: Context) => Promise<ReturnType<typeof serveOutcomeView> | null>,
) => ({
  bootPromptRef: async (parent: P, _: unknown, ctx: Context) => (await pointer(parent, ctx))?.urn ?? null,
  bootPromptTargetDeleted: async (parent: P, _: unknown, ctx: Context) => (await pointer(parent, ctx))?.deleted ?? null,
  bootPromptServe,
});

export const bootPromptPointerFieldResolvers = {
  Agent: fields(agentPointer, bootPromptServeResolvers.Agent),
  AppAgent: fields(appAgentPointer, bootPromptServeResolvers.AppAgent),
  Worker: fields(workerPointer, bootPromptServeResolvers.Worker),
};

/**
 * #3843 (cor:agt:040:05, :10; cor:dmo:150:08) — `Query.agentServedBootPrompt`, and through it MCP
 * `hadron_agent_boot_prompt`: the compiled boot prompt a chat or run with this Agent (in this App) would be given NOW,
 * rendered, for a caller that binds no worker (an MCP-only agent; cor:agt:020:03 is untouched because nothing binds).
 *
 * A pure read. It calls the serve resolver every surface uses (`resolveServedBootPrompt`, #2047) with no worker, fills
 * the platform variables exactly as a chat does (`noWorkerVariables`: the Agent's values, the client-reported model or
 * empty) and appends no derived blocks (those are composed on worker paths only). It records nothing: no ServedPrompt,
 * no session, no run, and it never reads the caller's session, so the answer is the current serve, not what a session
 * was given. A concurrent approval can change the answer between two calls.
 *
 * Every gate is judged BEFORE anything is resolved, and every failure answers exactly as a nonexistent `agentRef`
 * (`AgentNotFoundError(agentRef)`), so a masked caller learns nothing, not even NOT_SET:
 *  - Agent only: `maySeeAgentPointer` (the caller may read the Agent's system memory), as `Agent.bootPromptServe`.
 *  - Agent + App: the App exists and is live (neither deleted nor uninstalled, whichever ref form named it) and the caller participates in THAT App (`mayReadAsAppParticipant`: a
 *    person by `isAppParticipant`, an App key for its own App only); the Agent is installed there; the serve licence
 *    and text audience hold (`personalOrgAgentServeAllowed`, #3653, so a lapsed licence is masked as a chat masks it,
 *    never the typed INSTALL_LICENSE_INACTIVE); and the caller may chat with the Agent (`canChatWithAgent`).
 * Past the gate, a refusal is the serve's own typed BOOT_PROMPT_* error with `surface: 'chat'`, thrown, never an empty
 * string. There is no worker argument: a worker's text is `Worker.prompt`, and a worker read over MCP was cut (#3208).
 */
export async function readAgentServedBootPrompt(
  ctx: Context,
  args: { agentRef: string; appRef?: string | null; llmModel?: string | null },
): Promise<{
  decision: { pointerLevel: string; compiledNodeId: string; servedRevSeq: number; provenanceRevSeq: number; compiledContentHash: string };
  text: string;
}> {
  const llmModel = clientReportedChatModel(args.llmModel);
  const masked = () => new AgentNotFoundError(args.agentRef);
  const { id } = await resolveAgentRef(ctx.db, args.agentRef);
  const agent = await ctx.db.agent.findUnique({
    where: { id },
    select: { id: true, name: true, urn: true, personaRole: true, systemMemoryId: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
  });
  if (!agent || agent.deletedAt) throw masked();

  let appId: string | null = null;
  if (args.appRef == null) {
    if (!(await maySeeAgentPointer(agent, ctx))) throw masked();
  } else {
    try {
      appId = (await resolveAppRef(ctx.db, args.appRef)).id;
    } catch (err) {
      if (err instanceof AppNotFoundError) throw masked();
      throw err;
    }
    const app = await loadApp(ctx, appId);
    // Live means not deleted AND not uninstalled: resolveAppRef drops uninstalled rows on a URN only, not on an id.
    if (!app || app.deletedAt || app.uninstalledAt || !(await mayReadAsAppParticipant(ctx, app))) throw masked();
    if (!(await resolveAppInstallation(ctx.db, appId, agent.id))) throw masked();
    if (!(await personalOrgAgentServeAllowed(ctx.db, app, agent.id, ctx.userId))) throw masked();
    if (!(await canChatWithAgent(ctx, agent))) throw masked();
  }

  const served = await resolveServedBootPrompt(ctx.db, { surface: 'chat', appId, agent: { id: agent.id, name: agent.name }, workerId: null });
  const { pointerLevel, compiledNodeId, servedRevSeq, provenanceRevSeq, compiledContentHash } = served;
  return {
    decision: { pointerLevel, compiledNodeId, servedRevSeq, provenanceRevSeq, compiledContentHash },
    text: applyPlatformVariables(served.content, noWorkerVariables(agent, llmModel)),
  };
}

export const agentServedBootPromptQueries = {
  agentServedBootPrompt: (_: unknown, args: { agentRef: string; appRef?: string | null; llmModel?: string | null }, ctx: Context) =>
    readAgentServedBootPrompt(ctx, args),
};
