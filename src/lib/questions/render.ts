/**
 * #1641 §5.2 / §5.5 — a question's `content` is RENDERED from its payload, so
 * the approval hash (#1591) and later the signature (#1614), which cover
 * title, abstract and content only, cover exactly what the human saw and
 * answered.
 *
 * `content` = the human-readable markdown + a trailing fenced semantic block
 * holding the RFC 8785 (JCS) encoding of the whole payload. The block makes
 * the authenticated text lossless: two questions that differ in any
 * authority-bearing field differ in authenticated text.
 *
 * Renderers are versioned pure functions and RETAINED: a question is always
 * verified with the renderer it declares, so a new renderer never marks
 * history tampered, and an unknown one is UNVERIFIABLE (fail closed).
 */
import { canonicalizeTeamJson } from '../teamSpec/canonicalize.js';
import { currentAnswer, type AnswerEntry, type QuestionActor, type QuestionData, type QuestionLogData, type QuestionOption, type QuestionRef } from './codec.js';

/** The renderer every door writes with today. */
export const CURRENT_QUESTION_RENDERER = 'question-md/1';

/** RFC 8785 encoding of a question payload (the semantic block's body). */
export function canonicalQuestionJson(value: unknown): string {
  return canonicalizeTeamJson(value);
}

const BLOCK_OPEN = '```hadron-question\n';
/** The pre-#4426 fence. Only ever READ (so a stranded legacy node is UNVERIFIABLE, not TAMPERED); never written. */
const LEGACY_BLOCK_OPEN = '```hadron-decision\n';
const BLOCK_CLOSE = '\n```\n';

function actorText(actor: QuestionActor): string {
  if (actor.workerId) return `worker ${actor.workerId}${actor.userId ? ` (user ${actor.userId})` : ''}`;
  if (actor.userId) return `user ${actor.userId}`;
  if (actor.appId) return `app ${actor.appId}`;
  return 'unknown';
}

function refText(ref: QuestionRef): string {
  if ('ref' in ref) return ref.ref;
  if ('node' in ref) return `node ${ref.node}`;
  return `spec ${ref.spec}`;
}

function answerText(answer: AnswerEntry): string {
  const reason = answer.reason != null ? ` Reason: ${answer.reason}` : '';
  const meta = `by user ${answer.by}, ${answer.at}, via ${answer.via}`;
  if (answer.kind === 'retraction') return `Taken back (${meta}).${reason}`;
  const choice = answer.key != null ? `**${answer.key}**` : '*free text*';
  const said = answer.text != null ? `: ${answer.text}` : '';
  return `${choice}${said} (${meta}).${reason}`;
}

function refSection(title: string, refs: QuestionRef[]): string[] {
  if (refs.length === 0) return [];
  return [`## ${title}`, '', ...refs.map((r) => `- ${refText(r)}`), ''];
}

function optionLines(option: QuestionOption): string[] {
  const lines = [`- **${option.key}**: ${option.label}`];
  if (option.whyChoose != null) lines.push(`  - Why choose: ${option.whyChoose}`);
  if (option.whyNot != null) lines.push(`  - Why not: ${option.whyNot}`);
  if (option.risks != null) lines.push(`  - Risks: ${option.risks}`);
  return lines;
}

/** `question-md/1`: the markdown body (without the semantic block). */
function renderMarkdownV1(d: QuestionData): string {
  const lines: string[] = [`# ${d.code}: ${d.title}`, ''];
  lines.push(
    `**Status:** ${d.status} · **Priority:** ${d.priority} · **Tier:** ${d.tier} · **Authorizes:** ${d.authorizes ? 'yes' : 'no'}`,
    `**Asked by:** ${actorText(d.askedBy)} at ${d.askedAt}`,
    `**Deciders:** ${d.deciders.map((u) => `user ${u}`).join(', ')}`,
  );
  if (d.assignee != null) lines.push(`**Assignee:** user ${d.assignee}`);
  if (d.neededBy != null) {
    lines.push(`**Needed by:** ${d.neededBy}.${d.defaultAction != null ? ` If unanswered: ${d.defaultAction}` : ''}`);
  }
  if (d.withdrawn) lines.push(`**Withdrawn** by ${actorText(d.withdrawn.by)} at ${d.withdrawn.at}: ${d.withdrawn.reason}`);
  lines.push('');
  const hasBackground = d.background != null && d.background.trim() !== '';
  if (hasBackground || d.whyNow != null) {
    lines.push('## Explanation', '');
    if (hasBackground) lines.push(d.background as string, '');
    if (d.whyNow != null) lines.push(`**Why now:** ${d.whyNow}`, '');
  }
  // #4431: the agent task the question blocks, by its id (the renderer is a pure function of the payload, which holds
  // the id only). A question with no task renders exactly as before, so question-md/1 history is unchanged.
  if (d.taskId != null) {
    lines.push('## What this question is blocking', '', `**Blocks task:** ${d.taskId}`, '');
    if (d.blocks.length > 0) lines.push(...d.blocks.map((r) => `- ${refText(r)}`), '');
  } else {
    lines.push(...refSection('What this question is blocking', d.blocks));
  }
  if (d.specsTouched.length > 0 || d.specsMustChange.length > 0) {
    lines.push('## Specs', '');
    for (const r of d.specsTouched) lines.push(`- Touches: ${refText(r)}`);
    for (const r of d.specsMustChange) lines.push(`- Must change once answered: ${refText(r)}`);
    lines.push('');
  }
  lines.push(...refSection('Sources', d.sources));
  if (d.authorizes) lines.push('## Grants', '', 'This question authorizes something. See the record below.', '');
  lines.push('## Options', '');
  if (d.options.length === 0) lines.push('*Free-text answer.*');
  for (const option of d.options) lines.push(...optionLines(option));
  lines.push('');
  if (d.recommendation) {
    const rec = d.recommendation;
    lines.push(`**Recommendation:** ${rec.key} (by ${actorText(rec.by)}). ${rec.reason}`, '');
  } else if (d.noRecommendation) {
    lines.push(`**No recommendation:** ${d.noRecommendation.reason}`, '');
  }
  const standing = currentAnswer(d);
  lines.push('## Answer', '');
  lines.push(standing ? `**Answer:** ${answerText(standing)}` : '**Answer:** not yet answered.', '');
  const earlier = d.answers.filter((a) => a !== standing);
  if (earlier.length > 0) {
    lines.push('### Earlier entries', '');
    for (const [i, entry] of earlier.entries()) lines.push(`${i + 1}. ${entry.kind === 'answer' ? 'Answered ' : ''}${answerText(entry)}`);
    lines.push('');
  }
  lines.push('---', `Rendered by ${d.renderer}. The block below is the authenticated record; this text is its rendering.`, '');
  return lines.join('\n');
}

/** Retained renderers, by declared version. Never remove an entry. */
const RENDERERS: Readonly<Record<string, (d: QuestionData) => string>> = {
  'question-md/1': renderMarkdownV1,
};

/** Whether `renderer` is a version this server can verify. */
export function isKnownRenderer(renderer: string): boolean {
  return Object.prototype.hasOwnProperty.call(RENDERERS, renderer);
}

/**
 * The full `content` of a question with its declared renderer: markdown,
 * then the semantic block. Throws for an unknown renderer (a door only ever
 * writes the current one).
 */
export function renderQuestion(d: QuestionData): string {
  const render = RENDERERS[d.renderer];
  if (!render) throw new Error(`unknown question renderer ${d.renderer}`);
  return `${render(d)}\n${BLOCK_OPEN}${canonicalQuestionJson(d)}${BLOCK_CLOSE}`;
}

/** The one-line abstract of a question. */
export function renderQuestionAbstract(d: QuestionData): string {
  return `Question ${d.code} (${d.status}, ${d.priority}, ${d.tier} tier): ${d.title}`.slice(0, 2000);
}

/** The node name of a question: `<code>: <title>`. */
export function questionName(d: Pick<QuestionData, 'code' | 'title'>): string {
  return `${d.code}: ${d.title}`;
}

/**
 * Extract the semantic block from `content`. Located by its fixed suffix, so
 * text inside the markdown cannot forge a second block; the integrity check
 * then compares the WHOLE content with a re-render.
 *
 * @returns the parsed JSON, or null when there is no well-formed block.
 */
export function extractQuestionBlock(content: string | null): unknown | null {
  if (content == null || !content.endsWith(BLOCK_CLOSE)) return null;
  const body = content.slice(0, -BLOCK_CLOSE.length);
  const current = body.lastIndexOf(`\n${BLOCK_OPEN}`);
  const legacy = body.lastIndexOf(`\n${LEGACY_BLOCK_OPEN}`);
  if (current < 0 && legacy < 0) return null;
  const open = Math.max(current, legacy);
  const json = body.slice(open + 1 + (open === current ? BLOCK_OPEN : LEGACY_BLOCK_OPEN).length);
  if (json.includes('\n')) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** The rendered content of a question LOG: its settings, for readers. Not authenticated. */
export function renderQuestionLog(name: string, d: QuestionLogData): string {
  const lines = [
    `# ${name}`,
    '',
    `A question log. Codes are \`${d.prefix}\` plus letters, issued in sequence and never reused; ${d.lastCode} issued so far.`,
    '',
    `**Default deciders:** ${d.defaultDeciders.map((u) => `user ${u}`).join(', ')}`,
    `**Also eligible:** ${d.eligibleDeciders.length > 0 ? d.eligibleDeciders.map((u) => `user ${u}`).join(', ') : 'none'}`,
    '',
  ];
  if (d.purges.length > 0) {
    lines.push('## Purged unanswered questions', '');
    for (const p of d.purges) lines.push(`- ${p.code}: purged by user ${p.by} at ${p.at} (${p.reason}); content sha256 ${p.contentHash}`);
    lines.push('');
  }
  return lines.join('\n');
}
