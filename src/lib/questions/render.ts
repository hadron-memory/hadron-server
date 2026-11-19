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
import type { QuestionActor, QuestionAnswer, QuestionData, QuestionLogData, QuestionPart, QuestionRef } from './codec.js';

/** The renderer every door writes with today. */
export const CURRENT_QUESTION_RENDERER = 'decision-md/1';

/** RFC 8785 encoding of a question payload (the semantic block's body). */
export function canonicalQuestionJson(value: unknown): string {
  return canonicalizeTeamJson(value);
}

const BLOCK_OPEN = '```hadron-decision\n';
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

function answerText(answer: QuestionAnswer): string {
  const choice = answer.key != null ? `**${answer.key}**` : '*free text*';
  const said = answer.text != null ? `: ${answer.text}` : '';
  const who = answer.claimedBy != null
    ? `recorded by user ${answer.recordedBy ?? answer.by}; answered by ${answer.claimedBy} per the record`
    : `by user ${answer.by}`;
  const source = answer.source ? `, source ${refText(answer.source)} (claimed)` : '';
  const reason = answer.reason != null ? ` Reason: ${answer.reason}` : '';
  return `${choice}${said} (${who}, ${answer.at}, via ${answer.via}${source}).${reason}`;
}

function renderPart(code: string, part: QuestionPart): string[] {
  const lines = [`## ${code}-${part.n}: ${part.question.split('\n')[0]}`, ''];
  if (part.question.includes('\n')) lines.push(part.question, '');
  if (part.options.length === 0) lines.push('*Free-text answer.*', '');
  for (const option of part.options) {
    lines.push(`- **${option.key}**: ${option.label}`);
    if (option.meaning != null) lines.push(`  - Meaning: ${option.meaning}`);
    if (option.cost != null) lines.push(`  - Cost: ${option.cost}`);
  }
  if (part.options.length > 0) lines.push('');
  if (part.recommendation) {
    const rec = part.recommendation;
    const relayed = rec.attributedTo != null ? `, attributed to ${rec.attributedTo} (claimed)` : '';
    lines.push(`**Recommendation:** ${rec.key} (by ${actorText(rec.by)}${relayed})${rec.reason != null ? `. ${rec.reason}` : ''}`);
  } else if (part.noRecommendation) {
    lines.push(`**No recommendation:** ${part.noRecommendation.reason}`);
  }
  lines.push('');
  for (const [i, prior] of part.answerHistory.entries()) lines.push(`**Earlier answer ${i + 1}:** ${answerText(prior)}`, '');
  lines.push(part.answer ? `**Answer:** ${answerText(part.answer)}` : '**Answer:** not yet answered.', '');
  return lines;
}

function refSection(title: string, refs: QuestionRef[]): string[] {
  if (refs.length === 0) return [];
  return [`## ${title}`, '', ...refs.map((r) => `- ${refText(r)}`), ''];
}

/** `decision-md/1`: the markdown body (without the semantic block). */
function renderMarkdownV1(d: QuestionData): string {
  const lines: string[] = [`# ${d.code}: ${d.title}`, ''];
  lines.push(
    `**Status:** ${d.status} · **Urgency:** ${d.urgency} · **Tier:** ${d.tier} · **Authorizes:** ${d.authorizes ? 'yes' : 'no'}${d.archival ? ' · **Archival record (not usable as an authorization)**' : ''}`,
    `**Asked by:** ${actorText(d.askedBy)} at ${d.askedAt}`,
    `**Deciders:** ${d.deciders.map((u) => `user ${u}`).join(', ')}`,
    '',
  );
  if (d.withdrawn) lines.push(`**Withdrawn** by ${actorText(d.withdrawn.by)} at ${d.withdrawn.at}: ${d.withdrawn.reason}`, '');
  if (d.supersedes) lines.push(`**Supersedes** ${d.supersedes.code}.`, '');
  if (d.supersededBy) lines.push(`**Superseded by** ${d.supersededBy.code}.`, '');
  if (d.context != null && d.context.trim() !== '') lines.push('## Context', '', d.context, '');
  for (const part of d.parts) lines.push(...renderPart(d.code, part));
  lines.push(...refSection("What's waiting on it", d.blocks));
  lines.push(...refSection('Sources', d.sources));
  lines.push(...refSection('Spec follow-ups', d.followUps));
  if (d.grant) lines.push('## Grant', '', 'See the semantic block below.', '');
  lines.push('---', `Rendered by ${d.renderer}. The block below is the authenticated record; this text is its rendering.`, '');
  return lines.join('\n');
}

/** Retained renderers, by declared version. Never remove an entry. */
const RENDERERS: Readonly<Record<string, (d: QuestionData) => string>> = {
  'decision-md/1': renderMarkdownV1,
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
  if (!render) throw new Error(`unknown decision renderer ${d.renderer}`);
  return `${render(d)}\n${BLOCK_OPEN}${canonicalQuestionJson(d)}${BLOCK_CLOSE}`;
}

/** The one-line abstract of a question. */
export function renderQuestionAbstract(d: QuestionData): string {
  const parts = d.parts.length === 1 ? '1 part' : `${d.parts.length} parts`;
  return `Decision ${d.code} (${d.status}, ${d.urgency}, ${d.tier} tier, ${parts}): ${d.title}`.slice(0, 2000);
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
  const open = body.lastIndexOf(`\n${BLOCK_OPEN}`);
  if (open < 0) return null;
  const json = body.slice(open + 1 + BLOCK_OPEN.length);
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
    `A decision log. Codes are \`${d.prefix}\` plus letters, issued in sequence and never reused; ${d.lastCode} issued so far.`,
    '',
    `**Default deciders:** ${d.defaultDeciders.map((u) => `user ${u}`).join(', ')}`,
    `**Also eligible:** ${d.eligibleDeciders.length > 0 ? d.eligibleDeciders.map((u) => `user ${u}`).join(', ') : 'none'}`,
    '',
  ];
  if (d.purges.length > 0) {
    lines.push('## Purged unanswered asks', '');
    for (const p of d.purges) lines.push(`- ${p.code}: purged by user ${p.by} at ${p.at} (${p.reason}); content sha256 ${p.contentHash}`);
    lines.push('');
  }
  return lines.join('\n');
}
