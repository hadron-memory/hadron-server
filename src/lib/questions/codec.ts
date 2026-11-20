/**
 * #1641 §5.1 — the question codec. A question's authoritative payload is the
 * semantic block rendered into its `content` (§5.5); `Node.data` is a parsed
 * cache of that block. This module validates both the stored payload
 * (`hadron.dev/question/v1`) and the client's ask / amend input, and maps a
 * validation failure to `QUESTION_INVALID` with JSON pointers.
 *
 * Every authenticated actor (`askedBy`, `recommendation.by`, `answer.by`) is
 * server-taken from the principal and absent from the input schemas
 * (§7 provenance): a client cannot supply one.
 */
import { z } from 'zod';
import { questionError } from './index.js';

export const QUESTION_CODEC = 'hadron.dev/question/v1';
/** The pre-#4426 stored codec: never written again; read only to purge a stranded node. */
export const LEGACY_DECISION_CODEC = 'hadron.dev/decision/v1';
export const QUESTION_LOG_CODEC = 'hadron.dev/question-log/v1';
export const LEGACY_DECISION_LOG_CODEC = 'hadron.dev/decision-log/v1';
export const MAX_ANSWERS = 50;

export const TITLE_MAX = 300;
export const LONG_TEXT_MAX = 20_000;
export const QUESTION_MAX = 4_000;
export const SHORT_TEXT_MAX = 2_000;
export const REF_MAX = 300;
export const MAX_OPTIONS = 26;
export const MAX_REFS = 50;
export const MAX_DECIDERS = 20;

/** CRLF and lone CR become LF, so stored text renders and hashes one way. */
const lf = (s: string) => s.replace(/\r\n?/g, '\n');

const text = (max: number) => z.string().max(max).transform(lf);
const nonBlank = (max: number) =>
  z.string().max(max).transform(lf).refine((s) => s.trim().length > 0, { message: 'must not be blank' });
const oneLine = (max: number) =>
  nonBlank(max).refine((s) => !s.includes('\n'), { message: 'must be a single line' });

/** An option key: a short identifier (`A`, `yes`, `option-2`). */
const optionKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'an option key is 1-32 letters, digits, "-" or "_", starting with a letter or digit');

/** A reference: exactly one of an external ref (`hadron-server#1640`, `team:6783`), a node id or URN, or a spec citation. */
export const refSchema = z.union([
  z.strictObject({ ref: oneLine(REF_MAX) }),
  z.strictObject({ node: oneLine(REF_MAX) }),
  z.strictObject({ spec: oneLine(REF_MAX) }),
]);
export type QuestionRef = z.infer<typeof refSchema>;

/** An authenticated actor, taken from the request's principal. */
export const actorSchema = z.strictObject({
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  appId: z.string().nullable(),
});
export type QuestionActor = z.infer<typeof actorSchema>;

export const optionSchema = z.strictObject({
  key: optionKey,
  label: oneLine(TITLE_MAX),
  whyChoose: text(SHORT_TEXT_MAX).nullable(),
  whyNot: text(SHORT_TEXT_MAX).nullable(),
  risks: text(SHORT_TEXT_MAX).nullable(),
});
export type QuestionOption = z.infer<typeof optionSchema>;

export const recommendationSchema = z.strictObject({
  key: optionKey,
  /** Taken from the caller, never from input. */
  by: actorSchema,
  /** Required: "one recommendation with a reason". */
  reason: nonBlank(SHORT_TEXT_MAX),
});

/** One entry of the answer list. Entries are appended, never edited or removed. */
export const answerEntrySchema = z.strictObject({
  kind: z.enum(['answer', 'retraction']),
  /** The chosen option; null for text only, and for a retraction. */
  key: optionKey.nullable(),
  /** Free text; null for a retraction. */
  text: text(LONG_TEXT_MAX).nullable(),
  reason: text(SHORT_TEXT_MAX).nullable(),
  /** The answering user's id. */
  by: z.string(),
  /** ISO 8601, server clock. */
  at: z.string(),
  via: z.enum(['portal', 'cli', 'mcp', 'api']),
});
export type AnswerEntry = z.infer<typeof answerEntrySchema>;

const lifecycleMark = z.strictObject({ by: actorSchema, at: z.string(), reason: nonBlank(SHORT_TEXT_MAX) });

/** An ISO 8601 UTC instant as `Date#toISOString` writes it: nothing else (a free string would reach the rendered card). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isoInstant = z.string().max(40).refine((v) => ISO_INSTANT.test(v) && !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 UTC instant');

/** The stored, authenticated payload of a question (the semantic block, §5.5). One question per node (#4426). */
export const questionDataSchema = z.strictObject({
  codec: z.literal(QUESTION_CODEC),
  renderer: z.string(),
  kind: z.literal('question'),
  logId: z.string(),
  code: z.string(),
  n: z.number().int().min(1),
  /** The question itself, one line. */
  title: oneLine(TITLE_MAX),
  background: text(LONG_TEXT_MAX).nullable(),
  whyNow: text(SHORT_TEXT_MAX).nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  tier: z.enum(['answered', 'approved', 'signed']),
  authorizes: z.boolean(),
  /** The authorization a grant question carries (§11): reserved, structured by the register epic. */
  grant: z.record(z.string(), z.unknown()).nullable(),
  deciders: z.array(z.string()).min(1).max(MAX_DECIDERS),
  /** Explicit only; routing, not authority. The default is computed at read (S4). */
  assignee: z.string().nullable(),
  askedBy: actorSchema,
  askedAt: z.string(),
  /** ISO 8601. */
  neededBy: isoInstant.nullable(),
  defaultAction: text(SHORT_TEXT_MAX).nullable(),
  /** The asker's agent task this question blocks. Reserved: always null until slice S7 sets it. */
  taskId: z.string().nullable(),
  blocks: z.array(refSchema).max(MAX_REFS),
  sources: z.array(refSchema).max(MAX_REFS),
  specsTouched: z.array(refSchema).max(MAX_REFS),
  specsMustChange: z.array(refSchema).max(MAX_REFS),
  options: z.array(optionSchema).max(MAX_OPTIONS),
  recommendation: recommendationSchema.nullable(),
  noRecommendation: z.strictObject({ reason: nonBlank(SHORT_TEXT_MAX) }).nullable(),
  answers: z.array(answerEntrySchema).max(MAX_ANSWERS),
  /** A hint for display; never read for the state. */
  status: z.enum(['open', 'answered', 'withdrawn']),
  withdrawn: lifecycleMark.nullable(),
});
export type QuestionData = z.infer<typeof questionDataSchema>;

/** The answer that stands: the last entry when it is an answer; null when there is none or the last entry is a retraction. */
export function currentAnswer(d: Pick<QuestionData, 'answers'>): AnswerEntry | null {
  const last = d.answers[d.answers.length - 1];
  return last && last.kind === 'answer' ? last : null;
}

/** Whether the question ever had an answer (a later retraction does not undo this). */
export function everAnswered(d: Pick<QuestionData, 'answers'>): boolean {
  return d.answers.some((a) => a.kind === 'answer');
}

/** The settings a question log holds (§3.3, §6.1a). Not a question: never approved. */
export const questionLogDataSchema = z.strictObject({
  codec: z.enum([QUESTION_LOG_CODEC, LEGACY_DECISION_LOG_CODEC]),
  kind: z.enum(['question.log', 'decision.log']),
  prefix: z.string().regex(/^[A-Z]{1,3}$/),
  lastCode: z.number().int().min(0),
  defaultDeciders: z.array(z.string()).min(1).max(MAX_DECIDERS),
  eligibleDeciders: z.array(z.string()).max(MAX_DECIDERS),
  /** Q8 audit: each never-answered question a platform admin purged. */
  purges: z.array(z.strictObject({
    code: z.string(),
    n: z.number().int().min(1),
    by: z.string(),
    at: z.string(),
    reason: nonBlank(SHORT_TEXT_MAX),
    contentHash: z.string(),
  })),
  /** The operation that wrote this revision of the log, so its history is its audit trail (Q6). */
  lastAction: z.strictObject({
    op: z.enum(['create', 'set-deciders', 'purge']),
    by: actorSchema,
    at: z.string(),
    reason: text(SHORT_TEXT_MAX).nullable(),
  }),
});
export type QuestionLogData = z.infer<typeof questionLogDataSchema>;

// ─── Client input ────────────────────────────────────────────────────────────

const optionInput = z.strictObject({
  key: optionKey,
  label: oneLine(TITLE_MAX),
  whyChoose: text(SHORT_TEXT_MAX).nullish(),
  whyNot: text(SHORT_TEXT_MAX).nullish(),
  risks: text(SHORT_TEXT_MAX).nullish(),
});

const recommendationInput = z.strictObject({
  key: optionKey,
  reason: nonBlank(SHORT_TEXT_MAX),
});

const noRecommendationInput = z.strictObject({ reason: nonBlank(SHORT_TEXT_MAX) });
const priorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
const tierEnum = z.enum(['answered', 'approved', 'signed']);

export const askInputSchema = z.strictObject({
  title: oneLine(TITLE_MAX),
  background: text(LONG_TEXT_MAX).nullish(),
  whyNow: text(SHORT_TEXT_MAX).nullish(),
  priority: priorityEnum.nullish(),
  tier: tierEnum.nullish(),
  authorizes: z.boolean().nullish(),
  grant: z.record(z.string(), z.unknown()).nullish(),
  /** Narrows the log's default deciders; never widens past its eligible set (Q6). */
  deciders: z.array(z.string()).min(1).max(MAX_DECIDERS).nullish(),
  assignee: z.string().nullish(),
  neededBy: isoInstant.nullish(),
  defaultAction: text(SHORT_TEXT_MAX).nullish(),
  blocks: z.array(refSchema).max(MAX_REFS).nullish(),
  sources: z.array(refSchema).max(MAX_REFS).nullish(),
  specsTouched: z.array(refSchema).max(MAX_REFS).nullish(),
  specsMustChange: z.array(refSchema).max(MAX_REFS).nullish(),
  options: z.array(optionInput).max(MAX_OPTIONS).nullish(),
  /** Shorthand for options `[yes, no]`. Not together with options. */
  yesno: z.boolean().nullish(),
  recommendation: recommendationInput.nullish(),
  noRecommendation: noRecommendationInput.nullish(),
});
export type AskQuestionInput = z.infer<typeof askInputSchema>;

/** A change to the question. Omitted fields are unchanged; an answer is never patched (§7). */
export const amendInputSchema = z.strictObject({
  title: oneLine(TITLE_MAX).nullish(),
  background: text(LONG_TEXT_MAX).nullish(),
  whyNow: text(SHORT_TEXT_MAX).nullish(),
  priority: priorityEnum.nullish(),
  tier: tierEnum.nullish(),
  assignee: z.string().nullish(),
  neededBy: isoInstant.nullish(),
  defaultAction: text(SHORT_TEXT_MAX).nullish(),
  blocks: z.array(refSchema).max(MAX_REFS).nullish(),
  sources: z.array(refSchema).max(MAX_REFS).nullish(),
  specsTouched: z.array(refSchema).max(MAX_REFS).nullish(),
  specsMustChange: z.array(refSchema).max(MAX_REFS).nullish(),
  options: z.array(optionInput).max(MAX_OPTIONS).nullish(),
  yesno: z.boolean().nullish(),
  recommendation: recommendationInput.nullish(),
  noRecommendation: noRecommendationInput.nullish(),
});
export type AmendQuestionInput = z.infer<typeof amendInputSchema>;

// ─── Validation ──────────────────────────────────────────────────────────────

/** One validation failure, addressed by JSON pointer into the input. */
export interface QuestionPointer {
  pointer: string;
  message: string;
}

function pointerOf(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? '' : '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/** `QUESTION_INVALID`, carrying every pointer (bounded). */
export function invalidQuestion(pointers: QuestionPointer[], what = 'question'): never {
  const first = pointers[0];
  throw questionError(
    'QUESTION_INVALID',
    `Invalid ${what}${first ? ` at ${first.pointer || '/'}: ${first.message}` : ''}.`,
    { pointers: pointers.slice(0, 50) },
  );
}

/** Parse `input` with `schema`, or throw `QUESTION_INVALID` with pointers. */
export function parseOrRefuse<T extends z.ZodType>(schema: T, input: unknown, what = 'question'): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  return invalidQuestion(
    result.error.issues.map((issue) => ({ pointer: pointerOf(issue.path), message: issue.message })),
    what,
  );
}

const YESNO: QuestionOption[] = [
  { key: 'yes', label: 'Yes', whyChoose: null, whyNot: null, risks: null },
  { key: 'no', label: 'No', whyChoose: null, whyNot: null, risks: null },
];

/** The options an input names: explicit, or the `yesno` shorthand (never both). */
export function optionsOf(
  input: { options?: Array<z.infer<typeof optionInput>> | null; yesno?: boolean | null },
  pointer: string,
): QuestionOption[] | null {
  if (input.yesno && input.options != null) {
    invalidQuestion([{ pointer, message: 'give either options or yesno, not both' }]);
  }
  if (input.yesno) return YESNO.map((o) => ({ ...o }));
  if (input.options == null) return null;
  return input.options.map((o) => ({
    key: o.key,
    label: o.label,
    whyChoose: o.whyChoose ?? null,
    whyNot: o.whyNot ?? null,
    risks: o.risks ?? null,
  }));
}

/**
 * The cross-field rules zod does not express, on a stored question (#4426 §1):
 *   - option keys are unique;
 *   - with options: exactly one of `recommendation` and `noRecommendation`
 *     (§8.4: an absent recommendation is always deliberate and stated), and
 *     a recommendation names one of the options;
 *   - with no options (a free-text question): neither;
 *   - `defaultAction` only with `neededBy`;
 *   - `assignee`, when set, is one of the deciders, or the account one of them was merged into (`QUESTION_ASSIGNEE_NOT_DECIDER`);
 *   - every answer entry is well formed and names an existing option;
 *   - an authorizing question is of the signed tier, and only it carries a grant.
 */
export function checkQuestion(
  d: QuestionData,
  pointer = '',
  /** Whether two user ids are the same person (a merge may have made a stored id a merged-away one, #1715, #4525). */
  sameUser: (a: string, b: string) => boolean = (a, b) => a === b,
): void {
  const keys = new Set<string>();
  for (const [i, option] of d.options.entries()) {
    if (keys.has(option.key)) invalidQuestion([{ pointer: `${pointer}/options/${i}/key`, message: `duplicate option key "${option.key}"` }]);
    keys.add(option.key);
  }
  if (d.options.length > 0) {
    if (d.recommendation && d.noRecommendation) {
      invalidQuestion([{ pointer, message: 'give either a recommendation or noRecommendation, not both' }]);
    }
    if (!d.recommendation && !d.noRecommendation) {
      throw questionError(
        'QUESTION_RECOMMENDATION_MISSING',
        `Question ${d.code} has no recommendation. Give one, or state why there is none with noRecommendation.`,
        { pointer },
      );
    }
    if (d.recommendation && !keys.has(d.recommendation.key)) {
      invalidQuestion([{ pointer: `${pointer}/recommendation/key`, message: `"${d.recommendation.key}" is not one of the question's options` }]);
    }
  } else if (d.recommendation || d.noRecommendation) {
    invalidQuestion([{ pointer: `${pointer}/${d.recommendation ? 'recommendation' : 'noRecommendation'}`, message: 'a question with no options holds no recommendation' }]);
  }
  if (d.defaultAction != null && d.neededBy == null) {
    invalidQuestion([{ pointer: `${pointer}/defaultAction`, message: 'defaultAction needs neededBy' }]);
  }
  if (d.assignee != null && !d.deciders.some((id) => sameUser(id, d.assignee as string))) {
    throw questionError(
      'QUESTION_ASSIGNEE_NOT_DECIDER',
      `The assignee must be one of the question's deciders: only a decider can answer it.`,
      { userId: d.assignee },
    );
  }
  for (const [i, entry] of d.answers.entries()) {
    const at = `${pointer}/answers/${i}`;
    if (entry.kind === 'answer') {
      if (entry.key == null && (entry.text == null || entry.text.trim() === '')) {
        invalidQuestion([{ pointer: at, message: 'an answer needs a key or text' }]);
      }
      if (entry.key != null && !keys.has(entry.key)) {
        invalidQuestion([{ pointer: `${at}/key`, message: `"${entry.key}" is not one of the question's options` }]);
      }
    } else if (entry.key != null || entry.text != null) {
      invalidQuestion([{ pointer: at, message: 'a retraction carries no key or text' }]);
    }
  }
  if (d.authorizes && d.tier !== 'signed') {
    throw questionError('QUESTION_TIER_TOO_LOW', 'A question that authorizes something needs the signed tier.', { pointer: `${pointer}/tier` });
  }
  if (d.grant != null && !d.authorizes) {
    invalidQuestion([{ pointer: `${pointer}/grant`, message: 'grant is only for a question that authorizes' }]);
  }
}
