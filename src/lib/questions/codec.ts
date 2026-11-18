/**
 * #1641 §5.1 — the decision codec. A decision's authoritative payload is the
 * semantic block rendered into its `content` (§5.5); `Node.data` is a parsed
 * cache of that block. This module validates both the stored payload
 * (`hadron.dev/decision/v1`) and the client's ask / amend input, and maps a
 * validation failure to `DECISION_INVALID` with JSON pointers.
 *
 * Every authenticated actor (`askedBy`, `recommendation.by`, `answer.by`) is
 * server-taken from the principal and absent from the input schemas
 * (§7 provenance): a client cannot supply one.
 */
import { z } from 'zod';
import { decisionError } from './index.js';

export const DECISION_CODEC = 'hadron.dev/decision/v1';
export const DECISION_LOG_CODEC = 'hadron.dev/decision-log/v1';

export const TITLE_MAX = 300;
export const LONG_TEXT_MAX = 20_000;
export const QUESTION_MAX = 4_000;
export const SHORT_TEXT_MAX = 2_000;
export const REF_MAX = 300;
export const MAX_PARTS = 20;
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
export type DecisionRef = z.infer<typeof refSchema>;

/** An authenticated actor, taken from the request's principal. */
export const actorSchema = z.strictObject({
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  appId: z.string().nullable(),
});
export type DecisionActor = z.infer<typeof actorSchema>;

export const optionSchema = z.strictObject({
  key: optionKey,
  label: oneLine(TITLE_MAX),
  meaning: text(SHORT_TEXT_MAX).nullable(),
  cost: text(SHORT_TEXT_MAX).nullable(),
});
export type DecisionOption = z.infer<typeof optionSchema>;

export const recommendationSchema = z.strictObject({
  key: optionKey,
  by: actorSchema,
  reason: text(SHORT_TEXT_MAX).nullable(),
  /** A relayed recommendation's original author, as a CLAIM beside the authenticated `by`. */
  attributedTo: oneLine(REF_MAX).nullable(),
});

/**
 * One recorded answer to a part. Written by `answerDecision` (S2); reserved
 * in v1 so the codec needs no change when answers land. `claimedBy` /
 * `recordedBy` carry an imported answer's provenance (§10).
 */
export const answerSchema = z.strictObject({
  key: optionKey.nullable(),
  text: text(LONG_TEXT_MAX).nullable(),
  freeform: z.boolean(),
  by: z.string(),
  at: z.string(),
  via: z.enum(['portal', 'cli', 'mcp', 'chat-recorded', 'import']),
  source: refSchema.nullable(),
  reason: text(SHORT_TEXT_MAX).nullable(),
  claimedBy: oneLine(REF_MAX).nullable(),
  recordedBy: z.string().nullable(),
});
export type DecisionAnswer = z.infer<typeof answerSchema>;

export const partSchema = z.strictObject({
  n: z.number().int().min(1).max(MAX_PARTS),
  question: nonBlank(QUESTION_MAX),
  options: z.array(optionSchema).max(MAX_OPTIONS),
  recommendation: recommendationSchema.nullable(),
  noRecommendation: z.strictObject({ reason: nonBlank(SHORT_TEXT_MAX) }).nullable(),
  answer: answerSchema.nullable(),
  answerHistory: z.array(answerSchema),
});
export type DecisionPart = z.infer<typeof partSchema>;

const lifecycleMark = z.strictObject({ by: actorSchema, at: z.string(), reason: nonBlank(SHORT_TEXT_MAX) });
const decisionLink = z.strictObject({ nodeId: z.string(), code: z.string() });

/** The stored, authenticated payload of a decision (the semantic block, §5.5). */
export const decisionDataSchema = z.strictObject({
  codec: z.literal(DECISION_CODEC),
  renderer: z.string(),
  kind: z.literal('decision'),
  logId: z.string(),
  code: z.string(),
  n: z.number().int().min(1),
  title: oneLine(TITLE_MAX),
  urgency: z.enum(['normal', 'urgent']),
  tier: z.enum(['approved', 'signed']),
  authorizes: z.boolean(),
  /** The authorization a grant decision carries (§11): reserved, structured by the register epic. */
  grant: z.record(z.string(), z.unknown()).nullable(),
  /** Migrated authorization-bearing history (§10): never usable as an authorization. */
  archival: z.boolean(),
  deciders: z.array(z.string()).min(1).max(MAX_DECIDERS),
  askedBy: actorSchema,
  askedAt: z.string(),
  context: text(LONG_TEXT_MAX).nullable(),
  blocks: z.array(refSchema).max(MAX_REFS),
  sources: z.array(refSchema).max(MAX_REFS),
  followUps: z.array(refSchema).max(MAX_REFS),
  parts: z.array(partSchema).min(1).max(MAX_PARTS),
  /** A hint for the card only (§6.3); every relying consumer uses the derived state. */
  status: z.enum(['open', 'answered', 'withdrawn', 'superseded']),
  withdrawn: lifecycleMark.nullable(),
  supersedes: decisionLink.nullable(),
  supersededBy: decisionLink.nullable(),
});
export type DecisionData = z.infer<typeof decisionDataSchema>;

/** The settings a decision log holds (§3.3, §6.1a). Not a decision: never approved. */
export const decisionLogDataSchema = z.strictObject({
  codec: z.literal(DECISION_LOG_CODEC),
  kind: z.literal('decision.log'),
  prefix: z.string().regex(/^[A-Z]{1,3}$/),
  lastCode: z.number().int().min(0),
  defaultDeciders: z.array(z.string()).min(1).max(MAX_DECIDERS),
  eligibleDeciders: z.array(z.string()).max(MAX_DECIDERS),
  /** Q8 audit: each never-answered decision a platform admin purged. */
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
export type DecisionLogData = z.infer<typeof decisionLogDataSchema>;

// ─── Client input ────────────────────────────────────────────────────────────

const optionInput = z.strictObject({
  key: optionKey,
  label: oneLine(TITLE_MAX),
  meaning: text(SHORT_TEXT_MAX).nullish(),
  cost: text(SHORT_TEXT_MAX).nullish(),
});

const recommendationInput = z.strictObject({
  key: optionKey,
  reason: text(SHORT_TEXT_MAX).nullish(),
  attributedTo: oneLine(REF_MAX).nullish(),
});

export const partInputSchema = z.strictObject({
  question: nonBlank(QUESTION_MAX),
  options: z.array(optionInput).max(MAX_OPTIONS).nullish(),
  /** Shorthand for options `[yes, no]`. */
  yesno: z.boolean().nullish(),
  recommendation: recommendationInput.nullish(),
  noRecommendation: z.strictObject({ reason: nonBlank(SHORT_TEXT_MAX) }).nullish(),
});
export type DecisionPartInput = z.infer<typeof partInputSchema>;

export const askInputSchema = z.strictObject({
  title: oneLine(TITLE_MAX),
  urgency: z.enum(['normal', 'urgent']).nullish(),
  tier: z.enum(['approved', 'signed']).nullish(),
  authorizes: z.boolean().nullish(),
  grant: z.record(z.string(), z.unknown()).nullish(),
  /** Narrows the log's default deciders; never widens past its eligible set (Q6). */
  deciders: z.array(z.string()).min(1).max(MAX_DECIDERS).nullish(),
  context: text(LONG_TEXT_MAX).nullish(),
  blocks: z.array(refSchema).max(MAX_REFS).nullish(),
  sources: z.array(refSchema).max(MAX_REFS).nullish(),
  followUps: z.array(refSchema).max(MAX_REFS).nullish(),
  parts: z.array(partInputSchema).min(1).max(MAX_PARTS),
});
export type AskDecisionInput = z.infer<typeof askInputSchema>;

/** A change to one existing part. Omitted fields are unchanged; an answer is never patched (§7). */
export const partPatchSchema = z.strictObject({
  n: z.number().int().min(1),
  question: nonBlank(QUESTION_MAX).nullish(),
  options: z.array(optionInput).max(MAX_OPTIONS).nullish(),
  yesno: z.boolean().nullish(),
  recommendation: recommendationInput.nullish(),
  noRecommendation: z.strictObject({ reason: nonBlank(SHORT_TEXT_MAX) }).nullish(),
});

export const amendInputSchema = z.strictObject({
  title: oneLine(TITLE_MAX).nullish(),
  urgency: z.enum(['normal', 'urgent']).nullish(),
  tier: z.enum(['approved', 'signed']).nullish(),
  context: text(LONG_TEXT_MAX).nullish(),
  blocks: z.array(refSchema).max(MAX_REFS).nullish(),
  sources: z.array(refSchema).max(MAX_REFS).nullish(),
  followUps: z.array(refSchema).max(MAX_REFS).nullish(),
  parts: z.array(partPatchSchema).max(MAX_PARTS).nullish(),
  addParts: z.array(partInputSchema).max(MAX_PARTS).nullish(),
});
export type AmendDecisionInput = z.infer<typeof amendInputSchema>;

// ─── Validation ──────────────────────────────────────────────────────────────

/** One validation failure, addressed by JSON pointer into the input. */
export interface DecisionPointer {
  pointer: string;
  message: string;
}

function pointerOf(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? '' : '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/** `DECISION_INVALID`, carrying every pointer (bounded). */
export function invalidDecision(pointers: DecisionPointer[], what = 'decision'): never {
  const first = pointers[0];
  throw decisionError(
    'DECISION_INVALID',
    `Invalid ${what}${first ? ` at ${first.pointer || '/'}: ${first.message}` : ''}.`,
    { pointers: pointers.slice(0, 50) },
  );
}

/** Parse `input` with `schema`, or throw `DECISION_INVALID` with pointers. */
export function parseOrRefuse<T extends z.ZodType>(schema: T, input: unknown, what = 'decision'): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  return invalidDecision(
    result.error.issues.map((issue) => ({ pointer: pointerOf(issue.path), message: issue.message })),
    what,
  );
}

const YESNO: DecisionOption[] = [
  { key: 'yes', label: 'Yes', meaning: null, cost: null },
  { key: 'no', label: 'No', meaning: null, cost: null },
];

/** The options a part input names: explicit, or the `yesno` shorthand (never both). */
export function optionsOf(
  part: { options?: Array<z.infer<typeof optionInput>> | null; yesno?: boolean | null },
  pointer: string,
): DecisionOption[] | null {
  if (part.yesno && part.options != null) {
    invalidDecision([{ pointer, message: 'give either options or yesno, not both' }]);
  }
  if (part.yesno) return YESNO.map((o) => ({ ...o }));
  if (part.options == null) return null;
  return part.options.map((o) => ({ key: o.key, label: o.label, meaning: o.meaning ?? null, cost: o.cost ?? null }));
}

/**
 * The cross-field rules zod does not express, on a stored part:
 *   - option keys are unique;
 *   - a recommendation names one of the options;
 *   - exactly one of `recommendation` and `noRecommendation` (§8.4: an
 *     absent recommendation is always deliberate and stated).
 */
export function checkPart(part: DecisionPart, pointer: string): void {
  const keys = new Set<string>();
  for (const [i, option] of part.options.entries()) {
    if (keys.has(option.key)) invalidDecision([{ pointer: `${pointer}/options/${i}/key`, message: `duplicate option key "${option.key}"` }]);
    keys.add(option.key);
  }
  if (part.recommendation && part.noRecommendation) {
    invalidDecision([{ pointer, message: 'give either a recommendation or noRecommendation, not both' }]);
  }
  if (!part.recommendation && !part.noRecommendation) {
    throw decisionError(
      'DECISION_RECOMMENDATION_MISSING',
      `Part ${part.n} has no recommendation. Give one, or state why there is none with noRecommendation.`,
      { pointer, part: part.n },
    );
  }
  if (part.recommendation && !keys.has(part.recommendation.key)) {
    invalidDecision([{ pointer: `${pointer}/recommendation/key`, message: `"${part.recommendation.key}" is not one of the part's options` }]);
  }
}
