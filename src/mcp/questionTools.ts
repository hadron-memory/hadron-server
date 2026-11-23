/**
 * #4430 (Questions S6, epic #1641) — the question tools on the MCP surface (hrn:node:hadronmemory.com:specs:cor:dmo:140:09):
 * list a memory's or App's question logs, ask, read, list, amend, withdraw, answer and take an answer back.
 *
 * Every tool is a thin call into the SAME resolvers GraphQL serves (`resolvers.questions.ts`): the gates, the refusal
 * codes and the writes are computed once, so the MCP, portal and CLI surfaces cannot drift. Nothing here re-checks or
 * re-derives any of them; the renderer reads every field through `questionFieldResolvers` as the portal does.
 *
 * WHO ACTS (cor:dmo:140:03): the caller as the server took it, never supplied. The actor comes from `currentActor()`,
 * which the request handler fills from the validated session binding (the `X-Hadron-Session` header a worker session the
 * CLI started presents), so a worker asks AS that worker and a person on a plain session acts as themselves. No tool takes
 * an identity argument. The answer surface (`via`) is set to MCP by the handler and is not an argument either.
 *
 * NOT offered on MCP (cor:dmo:140:09, :05): approval and supersession (by ruling), creating a log or changing its deciders
 * (a manager's setup act: portal and CLI), purge (platform admin), `verifyQuestion`, and the reserved `grant` input.
 */
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { HadronMcpServer as McpServer } from './hadronMcpServer.js';
import { publicErrorExtensions } from '../lib/errorDiagnostics.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { questionFieldResolvers, type QuestionView, type QuestionLogView } from '../api/graphql/schema/resolvers.questions.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';
import { UrnNotQualifiedError } from '../lib/urn.js';
import { AmbiguousLegacyUrnError } from '../lib/entityRef/errors.js';
import { userUrn } from '../lib/userHandle.js';
import type { AuthContext } from '../middleware/auth.js';
import type { PrismaClient } from '../generated/prisma/index.js';

type Resolver<A, R> = (parent: unknown, args: A, ctx: Context) => Promise<R>;
type Input = Record<string, unknown>;
const Q = resolvers.Query as unknown as {
  questionLogs: Resolver<{ appRef?: string | null; memoryRef?: string | null }, QuestionLogView[]>;
  question: Resolver<{ ref?: string | null; code?: string | null; logRef?: string | null }, QuestionView | null>;
  questions: Resolver<Input, { items: QuestionView[]; total: number }>;
};
const M = resolvers.Mutation as unknown as {
  askQuestion: Resolver<{ logRef: string; input: Input }, QuestionView>;
  amendQuestion: Resolver<{ ref: string; input: Input; expectedRevision: number; reason: string }, QuestionView>;
  withdrawQuestion: Resolver<{ ref: string; reason: string; expectedRevision: number }, QuestionView>;
  answerQuestion: Resolver<{ ref: string; input: Input; expectedRevision: number }, QuestionView>;
  retractQuestionAnswer: Resolver<{ ref: string; expectedRevision: number; reason?: string | null; via?: string | null }, QuestionView>;
};
const F = questionFieldResolvers.Question as unknown as Record<string, (v: QuestionView, a: unknown, ctx: Context) => unknown>;
const L = questionFieldResolvers.QuestionLog as unknown as Record<string, (v: QuestionLogView, a: unknown, ctx: Context) => unknown>;

/** The surface every answer and retraction made through these tools records (cor:dmo:140:03 "on which surface"). */
export const MCP_ANSWER_VIA = 'MCP';
/** How many earlier answer entries a read prints before summarising the rest. */
const EARLIER_ENTRIES_SHOWN = 5;
const NO_LOG = 'This App has no question log yet. A manager of the memory or an owner of the App creates one (portal: the App\'s Questions tab; CLI: hadron question log create).';
/** One answer for a question that is missing and one the caller cannot read: the resolver returns null for both. */
const NOT_FOUND_TEXT = '[question_not_found] No readable question.';
class QuestionNotFound extends Error {}
const DELIVER = 'Give this link to the person who should answer; nothing is sent to them.';
const NO_AGENT_ANSWERS = 'Only a person who is one of the question\'s deciders can answer, acting as themselves. A worker or agent session is refused [question_not_decider]: an agent does not answer its own question.';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** A refusal is a failed call: isError is set (#1789). */
function refused(text: string) {
  return { isError: true as const, ...textResult(text) };
}

/**
 * A resolver refusal as `[<lower_snake_code>] <message>` plus its public extensions as `key: value` lines, the comment
 * tools' convention. A ref that cannot be resolved as written is the caller's input. Anything else is a server fault and
 * is rethrown, never dressed up as a success or a refusal.
 */
export function questionErrorText(e: unknown) {
  if (e instanceof GraphQLError && isTrustedRefusal(e)) {
    const { code, ...rest } = publicErrorExtensions(e.extensions ?? {});
    const extras = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return refused([`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, ...extras].join('\n'));
  }
  if (e instanceof UrnNotQualifiedError || e instanceof AmbiguousLegacyUrnError) return refused(`[bad_user_input] ${e.message}`);
  throw e;
}

type ActorRef = { id: string; name: string | null; handle: string | null; urn: string | null } | null;
type QActor = { userId: string | null; workerId: string | null; appId: string | null; user: ActorRef; worker: ActorRef; app: ActorRef };

function refLabel(ref: ActorRef, kind: string, id: string | null): string {
  if (kind === 'user') return `user ${(ref?.handle ? userUrn(ref.handle) : null) ?? ref?.name ?? id ?? 'unknown'}`;
  return `${kind} ${ref?.name ?? id ?? 'unknown'}${ref?.urn ? ` (${ref.urn})` : ''}`;
}

function actorLabel(a: QActor | null): string {
  if (!a) return 'unknown';
  if (a.workerId) return `${refLabel(a.worker, 'worker', a.workerId)}${a.userId ? ` for ${refLabel(a.user, 'user', a.userId)}` : ''}`;
  if (a.userId) return refLabel(a.user, 'user', a.userId);
  if (a.appId) return refLabel(a.app, 'app', a.appId);
  return 'unknown';
}

type AnswerOut = { kind: string; key: string | null; text: string | null; reason: string | null; byUserId: string; by: ActorRef; at: string; via: string };
function answerLine(a: AnswerOut): string {
  const what = a.kind === 'RETRACTION' ? 'took the answer back' : `${a.key ?? '(free text)'}${a.text ? `: ${a.text}` : ''}`;
  return `${what} — ${refLabel(a.by, 'user', a.byUserId)}, ${a.at}, via ${a.via}${a.reason ? ` (reason: ${a.reason})` : ''}`;
}

/** One question as text, every field through the GraphQL field resolvers (the same projection the portal reads). */
export async function renderQuestion(v: QuestionView, ctx: Context): Promise<string> {
  const f = (name: string) => F[name](v, {}, ctx);
  const [urn, portalUrl, askedBy, assignee, recommendation, answer, answers, withdrawn, deciders] = await Promise.all([
    f('urn') as Promise<string>, f('portalUrl') as Promise<string | null>, f('askedBy') as Promise<QActor>,
    f('effectiveAssignee') as Promise<ActorRef>, f('recommendation') as Promise<{ key: string; reason: string } | null>,
    f('answer') as Promise<AnswerOut | null>, f('answers') as Promise<AnswerOut[]>,
    f('withdrawn') as Promise<{ at: string; reason: string; by: QActor } | null>,
    f('deciders') as Promise<ActorRef[]>,
  ]);
  const options = f('options') as Array<{ key: string; label: string; whyChoose: string | null; whyNot: string | null; risks: string | null }>;
  const lines = [
    `${f('code')} · ${f('title')}`,
    `State: ${f('state')} · answered: ${f('answered') ? 'yes' : 'no'} · priority ${f('priority')} · tier ${f('tier')}`,
    `Asked by ${actorLabel(askedBy)}${f('askedAt') ? ` at ${f('askedAt')}` : ''}`,
    `Assignee: ${assignee ? refLabel(assignee, 'user', f('effectiveAssigneeId') as string) : 'none'}`,
  ];
  if (f('authorizes')) lines.push('Authorizes: yes (the answer authorizes an act)');
  if (f('neededBy')) lines.push(`Needed by: ${f('neededBy')}`);
  if (f('defaultAction')) lines.push(`If no answer in time: ${f('defaultAction')}`);
  if (deciders.length) lines.push(`Deciders: ${deciders.map((d) => refLabel(d, 'user', d?.id ?? null)).join(', ')}`);
  if (f('background')) lines.push(`Background: ${f('background')}`);
  if (f('whyNow')) lines.push(`Why now: ${f('whyNow')}`);
  for (const [label, field] of [['Blocks', 'blocks'], ['Sources', 'sources'], ['Specs touched', 'specsTouched'], ['Specs that must change', 'specsMustChange']] as const) {
    const list = f(field) as Array<{ ref: string | null; node: string | null; spec: string | null }>;
    if (list.length) lines.push(`${label}: ${list.map((r) => r.spec ?? r.node ?? r.ref).join(', ')}`);
  }
  if (options.length) {
    lines.push('Options:');
    for (const o of options) {
      lines.push(`- ${o.key}: ${o.label}`);
      if (o.whyChoose) lines.push(`    why choose: ${o.whyChoose}`);
      if (o.whyNot) lines.push(`    why not: ${o.whyNot}`);
      if (o.risks) lines.push(`    risks: ${o.risks}`);
    }
  }
  if (recommendation) lines.push(`Recommendation: ${recommendation.key} (${recommendation.reason})`);
  else if (f('noRecommendationReason')) lines.push(`No recommendation: ${f('noRecommendationReason')}`);
  lines.push(`Answer: ${answer ? answerLine(answer) : 'none'}`);
  // The standing answer in full; at most the five most recent earlier entries, then a count of the rest.
  const earlier = answer ? answers.slice(0, -1) : answers;
  if (earlier.length) {
    const shown = earlier.slice(-EARLIER_ENTRIES_SHOWN);
    lines.push(`Earlier entries (${earlier.length}):`, ...shown.map((a) => `- ${answerLine(a)}`));
    if (earlier.length > shown.length) lines.push(`… ${earlier.length - shown.length} earlier entries not shown`);
  }
  if (withdrawn) lines.push(`Withdrawn by ${actorLabel(withdrawn.by)} at ${withdrawn.at}: ${withdrawn.reason}`);
  lines.push(`URN: ${urn}`);
  if (portalUrl) lines.push(`Link: ${portalUrl}`);
  lines.push(`Next write to it: expectedRevision ${v.row.revSeq} (current revision ${v.row.revSeq}).`);
  return lines.join('\n');
}

async function questionLine(v: QuestionView, ctx: Context): Promise<string> {
  const urn = await (F.urn(v, {}, ctx) as Promise<string>);
  const answeredAt = F.answeredAt(v, {}, ctx) as string | null;
  return `- ${F.code(v, {}, ctx)} · ${F.state(v, {}, ctx)} · ${F.priority(v, {}, ctx)} · answered ${answeredAt ?? '—'} · ${F.title(v, {}, ctx)} · ${urn}`;
}

/** The ask input: every AskQuestionInput field the caller gave, unchanged. `grant` is reserved and not offered. */
function pick(args: Input, keys: readonly string[]): Input {
  const out: Input = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}
const ASK_FIELDS = ['title', 'background', 'whyNow', 'priority', 'tier', 'authorizes', 'deciders', 'assignee', 'neededBy', 'defaultAction',
  'blocks', 'sources', 'specsTouched', 'specsMustChange', 'options', 'yesno', 'recommendation', 'noRecommendation', 'taskRef'] as const;
const AMEND_FIELDS = ['title', 'background', 'whyNow', 'priority', 'tier', 'assignee', 'neededBy', 'defaultAction',
  'blocks', 'sources', 'specsTouched', 'specsMustChange', 'options', 'yesno', 'recommendation', 'noRecommendation'] as const;
const LIST_FIELDS = ['appRef', 'logRef', 'awaitingMe', 'askedByMe', 'answered', 'state', 'priority', 'assigneeId', 'unassigned',
  'answeredSince', 'sort', 'limit', 'offset'] as const;

/**
 * Register the question tools on one MCP server instance. `auth` is the connection's principal; each call builds the
 * GraphQL Context from it, including `impersonation`, so an impersonated caller meets QUESTION_IMPERSONATION_REFUSED here
 * exactly as on GraphQL (belt and braces: /mcp already rejects an impersonation JWT at session init).
 */
export function registerQuestionTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    appKeyId: auth.appKeyId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });
  const run = async (fn: (ctx: Context) => Promise<string>) => {
    try {
      return textResult(await fn(ctxOf()));
    } catch (e) {
      // A missing and an unreadable question read alike (no existence oracle), and both are a failed call (#1789).
      if (e instanceof QuestionNotFound) return refused(NOT_FOUND_TEXT);
      return questionErrorText(e);
    }
  };

  server.tool(
    'hadron_list_question_logs',
    'List the question logs of an App or a memory (cor:dmo:140:09): one line per log with its name, code prefix, URN and memory. '
      + 'Use a log\'s URN as logRef in hadron_ask_question. Needs read access to the memory.',
    SHAPE_HADRON_LIST_QUESTION_LOGS,
    async ({ appRef, memoryRef }) => run(async (ctx) => {
      const logs = await Q.questionLogs({}, { appRef: appRef ?? null, memoryRef: memoryRef ?? null }, ctx);
      if (!logs.length) return NO_LOG;
      const lines = await Promise.all(logs.map(async (l) =>
        `- ${L.name(l, {}, ctx)} · prefix ${L.prefix(l, {}, ctx)} · ${await (L.urn(l, {}, ctx) as Promise<string>)} · memory ${L.memoryId(l, {}, ctx)}`));
      return `${logs.length} question log${logs.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
    }),
  );

  server.tool(
    'hadron_ask_question',
    'Ask a human a question in a question log (cor:dmo:140:09): it gets a code, a URN and a portal link. Asking notifies nobody: '
      + 'whoever asks delivers the link. Needs write access to the log\'s memory. If your session is bound to a worker, the question '
      + 'is asked by that worker. Read the answer later with hadron_get_question, or pull with hadron_list_questions (askedByMe, answeredSince).',
    SHAPE_HADRON_ASK_QUESTION,
    async ({ logRef, ...rest }) => run(async (ctx) => {
      const v = await M.askQuestion({}, { logRef, input: pick(rest, ASK_FIELDS) }, ctx);
      return `Asked ${F.code(v, {}, ctx)}.\n${DELIVER}\n\n${await renderQuestion(v, ctx)}`;
    }),
  );

  server.tool(
    'hadron_get_question',
    'Read one question (cor:dmo:140:09): its state, options, recommendation, standing answer and recent history, URN and link. '
      + 'Give ref, or code with logRef. A question you cannot read is not found, with no detail.',
    SHAPE_HADRON_GET_QUESTION,
    async ({ ref, code, logRef }) => run(async (ctx) => {
      const v = await Q.question({}, { ref: ref ?? null, code: code ?? null, logRef: logRef ?? null }, ctx);
      if (!v) throw new QuestionNotFound();
      return renderQuestion(v, ctx);
    }),
  );

  server.tool(
    'hadron_list_questions',
    'List questions (cor:dmo:140:09): one line each with code, state, priority, answered time, title and URN; the first line is '
      + '"N of TOTAL". Scope by logRef or appRef, or use awaitingMe for the questions you decide. To pull answers to the questions '
      + 'you asked, pass askedByMe: true with answeredSince (the time of your last check).',
    SHAPE_HADRON_LIST_QUESTIONS,
    async (args) => run(async (ctx) => {
      const page = await Q.questions({}, pick(args as Input, LIST_FIELDS), ctx);
      const lines = await Promise.all(page.items.map((v) => questionLine(v, ctx)));
      return [`${page.items.length} of ${page.total}`, ...lines].join('\n');
    }),
  );

  server.tool(
    'hadron_amend_question',
    'Change an unanswered question\'s wording or details (cor:dmo:140:05): the asker or a decider. Name the revision you read; '
      + 'a stale one is refused [node_write_conflict] with currentRevision.',
    SHAPE_HADRON_AMEND_QUESTION,
    async ({ ref, expectedRevision, reason, ...rest }) => run(async (ctx) => {
      const v = await M.amendQuestion({}, { ref, input: pick(rest, AMEND_FIELDS), expectedRevision, reason }, ctx);
      return `Amended.\n\n${await renderQuestion(v, ctx)}`;
    }),
  );

  server.tool(
    'hadron_withdraw_question',
    'Withdraw a question (cor:dmo:140:05). The asker may withdraw it while no answer stands; after an answer only a decider may.',
    SHAPE_HADRON_WITHDRAW_QUESTION,
    async ({ ref, expectedRevision, reason }) => run(async (ctx) => {
      const v = await M.withdrawQuestion({}, { ref, reason, expectedRevision }, ctx);
      return `Withdrawn.\n\n${await renderQuestion(v, ctx)}`;
    }),
  );

  server.tool(
    'hadron_answer_question',
    `Answer a question with one of its options, free text, or both (cor:dmo:140:05). ${NO_AGENT_ANSWERS} The answer is recorded as given on MCP.`,
    SHAPE_HADRON_ANSWER_QUESTION,
    async ({ ref, expectedRevision, optionKey, text, reason }) => run(async (ctx) => {
      const v = await M.answerQuestion({}, {
        ref, expectedRevision, input: { optionKey: optionKey ?? null, text: text ?? null, reason: reason ?? null, via: MCP_ANSWER_VIA },
      }, ctx);
      return `Answered.\n\n${await renderQuestion(v, ctx)}`;
    }),
  );

  server.tool(
    'hadron_retract_question_answer',
    `Take the standing answer back (cor:dmo:140:05): the question is OPEN again and the answer stays in its history. ${NO_AGENT_ANSWERS}`,
    SHAPE_HADRON_RETRACT_QUESTION_ANSWER,
    async ({ ref, expectedRevision, reason }) => run(async (ctx) => {
      const v = await M.retractQuestionAnswer({}, { ref, expectedRevision, reason: reason ?? null, via: MCP_ANSWER_VIA }, ctx);
      return `Answer taken back.\n\n${await renderQuestion(v, ctx)}`;
    }),
  );
}

// ── #2260: parameter shapes, built ONCE per process (pure data, no session state) ──────────────

const PRIORITY = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const TIER = z.enum(['ANSWERED', 'APPROVED', 'SIGNED']);
const STATE = z.enum(['OPEN', 'ANSWERED_UNCONFIRMED', 'DECIDED', 'STALE', 'TAMPERED', 'UNVERIFIABLE', 'WITHDRAWN']);
const SORT = z.enum(['PORTAL_DEFAULT', 'CODE', 'ASKED_AT_DESC', 'ASKED_AT_ASC', 'PRIORITY_DESC', 'ANSWERED_AT_DESC']);
const REF = z.object({
  ref: z.string().optional().describe('A link or free reference.'),
  node: z.string().optional().describe('A node URN.'),
  spec: z.string().optional().describe('A spec citation.'),
});
const refs = (what: string) => z.array(REF).optional().describe(`${what}: each item is one of ref, node or spec.`);
const questionRef = z.string().describe('The question: its URN or id.');
const expectedRevision = z.number().int().describe('The question\'s current revision (the one its last read or write printed). A stale value is refused [node_write_conflict].');

const QUESTION_FIELDS = {
  title: z.string().describe('The question, as one line the person can answer.'),
  background: z.string().optional().describe('What the person needs to know to answer.'),
  whyNow: z.string().optional().describe('Why this needs an answer now.'),
  priority: PRIORITY.optional().describe('How urgent it is. Default NORMAL.'),
  tier: TIER.optional().describe('How settled an answer must be: ANSWERED, APPROVED or SIGNED.'),
  assignee: z.string().optional().describe('Optional; a user id among the question\'s deciders; leave empty and the question goes to your holder.'),
  neededBy: z.string().optional().describe('When an answer is needed, as an ISO date-time.'),
  defaultAction: z.string().optional().describe('What happens if no one answers in time.'),
  blocks: refs('What this question blocks'),
  sources: refs('Where the question comes from'),
  specsTouched: refs('Specs the answer touches'),
  specsMustChange: refs('Specs that must change with the answer'),
  options: z.array(z.object({
    key: z.string().describe('A short option id the answer names.'),
    label: z.string().describe('The option, in a few words.'),
    whyChoose: z.string().optional().describe('Why someone would choose it.'),
    whyNot: z.string().optional().describe('Why someone would not.'),
    risks: z.string().optional().describe('What could go wrong.'),
  })).optional().describe('The choices, each {key, label, whyChoose, whyNot, risks}. The three texts are optional and separate: think about each.'),
  yesno: z.boolean().optional().describe('True for a plain yes/no question (options yes and no).'),
  recommendation: z.object({
    key: z.string().describe('The option you recommend.'),
    reason: z.string().describe('Why.'),
  }).optional().describe('Exactly one of recommendation and noRecommendation when you give options; a recommendation needs a reason.'),
  noRecommendation: z.object({ reason: z.string().describe('Why you make no recommendation.') })
    .optional().describe('Exactly one of recommendation and noRecommendation when you give options.'),
};

const SHAPE_HADRON_LIST_QUESTION_LOGS = {
  appRef: z.string().optional().describe('The App whose question logs to list: its URN or id. Give this or memoryRef.'),
  memoryRef: z.string().optional().describe('The memory whose question logs to list: its URN or id. Give this or appRef.'),
};

const SHAPE_HADRON_ASK_QUESTION = {
  logRef: z.string().describe('The question log to ask in: its URN or id (hadron_list_question_logs finds it).'),
  ...QUESTION_FIELDS,
  authorizes: z.boolean().optional().describe('True when the answer authorizes an act; such a question must be at the SIGNED tier.'),
  deciders: z.array(z.string()).optional().describe('User ids who may answer, among the log\'s eligible deciders. Default: the log\'s default deciders.'),
  // #4431 (Questions S7): the asking worker\'s own open task this question blocks; an answer then wakes that task\'s assignee.
  taskRef: z.string().optional().describe('The agent task this question blocks: its id or handle (e.g. AT3.405). Only a worker session, naming its own open task in the App of the log\'s memory; anything else is QUESTION_INVALID at /taskRef. An answer then wakes the task\'s current assignee (the nudge names the task and the question code, never the answer); taking an answer back wakes nobody.'),
};

const SHAPE_HADRON_GET_QUESTION = {
  ref: z.string().optional().describe('The question: its URN or id. Give this, or code with logRef.'),
  code: z.string().optional().describe('The question\'s code (e.g. QA), with logRef.'),
  logRef: z.string().optional().describe('The log the code belongs to: its URN or id.'),
};

const SHAPE_HADRON_LIST_QUESTIONS = {
  appRef: z.string().optional().describe('Every question log of this App: its URN or id.'),
  logRef: z.string().optional().describe('One question log: its URN or id.'),
  awaitingMe: z.boolean().optional().describe('Only the open questions you decide.'),
  askedByMe: z.boolean().optional().describe('Only questions you (or your worker) asked.'),
  answered: z.boolean().optional().describe('Only answered (true) or unanswered (false) questions.'),
  state: z.array(STATE).optional().describe('Only questions in these states.'),
  priority: z.array(PRIORITY).optional().describe('Only questions with these priorities.'),
  assigneeId: z.string().optional().describe('Only questions routed to this user id.'),
  unassigned: z.boolean().optional().describe('Only questions routed to no one.'),
  answeredSince: z.string().optional().describe('Only questions answered at or after this ISO date-time: with askedByMe, your pull for new answers.'),
  sort: SORT.optional().describe('The order. Default PORTAL_DEFAULT.'),
  limit: z.number().int().min(0).max(50).optional().describe('Questions per page (default 20, max 50).'),
  offset: z.number().int().nonnegative().optional().describe('Page offset.'),
};

/** The amend fields the resolver CLEARS on null (amendQuestion); every other field ignores null, so only these accept it. */
const clearable = (description: string) => z.string().nullable().optional().describe(`${description} null clears it; omit to keep it.`);
const SHAPE_HADRON_AMEND_QUESTION = {
  ref: questionRef,
  expectedRevision,
  reason: z.string().describe('Why you change it (kept in the revision history).'),
  ...QUESTION_FIELDS,
  title: QUESTION_FIELDS.title.optional(),
  background: clearable('What the person needs to know to answer.'),
  whyNow: clearable('Why this needs an answer now.'),
  neededBy: clearable('When an answer is needed, as an ISO date-time.'),
  defaultAction: clearable('What happens if no one answers in time.'),
  assignee: clearable('A user id among the question\'s deciders.'),
};

const SHAPE_HADRON_WITHDRAW_QUESTION = {
  ref: questionRef,
  expectedRevision,
  reason: z.string().describe('Why you withdraw it.'),
};

const SHAPE_HADRON_ANSWER_QUESTION = {
  ref: questionRef,
  expectedRevision,
  optionKey: z.string().optional().describe('The option you choose, by its key. Give this, text, or both.'),
  text: z.string().optional().describe('A free-text answer, alone or beside an option.'),
  reason: z.string().optional().describe('Why you answer so.'),
};

const SHAPE_HADRON_RETRACT_QUESTION_ANSWER = {
  ref: questionRef,
  expectedRevision,
  reason: z.string().optional().describe('Why you take the answer back.'),
};
