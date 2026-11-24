/**
 * #5109 — spec content lint, the server half of hadron-cli#3127 (business rules live in the server, cor:api:240:01).
 *
 * Two checks, both pure functions of one node's stored text, so they are computed on read, never stored, and a
 * client that reads the node's findings is judged by the node's own read gate (the field hangs off `Node`):
 *
 *  1. STRUCTURAL (ERROR). A Rule spec needs a non-empty `## Why We Need This Rule` section
 *     (authority: specs-engineer-system:authoring:rule:template). A spec that is retired (tagged `superseded`, or
 *     carrying the retirement banner `retirementBanner` writes) is not law and is skipped.
 *  2. SENTENCE (WARNING). In a spec body above the `---` divider, a sentence that restricts something and gives no
 *     reason in its paragraph or through a link to a ruling or a Why section is reported with the sentence (authority:
 *     the platform owner's rule of 2026-11-24, hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:
 *     2026-11-24-holger-ruling-limiting-rules-need-a-reason). It has false positives, so it never rises above a warning
 *     here; the word lists below are the whole of what "restricts" and "reason" mean.
 *
 * A node that is not a spec has no findings. A spec not written in the authoring frame (a legacy `cor:... — title`
 * heading) is still a spec: it is recognised by its role or its citation-shaped loc, not by its heading.
 */

export type SpecLintRule = 'RULE_WHY_MISSING' | 'RULE_WHY_EMPTY' | 'LIMIT_WITHOUT_REASON';
export type SpecLintSeverity = 'ERROR' | 'WARNING';

export interface SpecLintFinding {
  /** The spec's citation (its loc). */
  citation: string;
  rule: SpecLintRule;
  severity: SpecLintSeverity;
  message: string;
  /** The offending sentence for LIMIT_WITHOUT_REASON; null for a structural finding. */
  sentence: string | null;
  /** 1-based line of the sentence's paragraph, or of the Why heading; null when there is none to point at. */
  line: number | null;
}

export interface SpecLintSubject {
  loc: string;
  name?: string | null;
  role?: string | null;
  tags?: readonly string[] | null;
  content: string | null;
}

export const SPEC_LINT_MAX_FINDINGS = 200;
const SENTENCE_MAX_CHARS = 300;
const SUPERSEDED_TAG = 'superseded';
const WHY_HEADING = /^##[ \t]+Why We Need This Rule[ \t]*#*[ \t]*$/i;
const RETIRED_BANNER = /^>\s*\*\*⚠️\s*(Superseded|Withdrawn|Rescinded)/m;
const CITATION_LOC = /^[a-z]{3}:[a-z]{2,4}(?::\d+)+$/;

/** True for a node the spec lint applies to: a `spec.*` role, or a loc shaped like a corpus citation. */
export function isSpecSubject(s: SpecLintSubject): boolean {
  return (s.role ?? '').startsWith('spec.') || CITATION_LOC.test(s.loc);
}

function isRuleSpec(s: SpecLintSubject): boolean {
  return s.role === 'spec.rule' || /^Rule:\s/.test(s.name ?? '');
}

function isRetired(s: SpecLintSubject, body: string): boolean {
  return (s.tags ?? []).includes(SUPERSEDED_TAG) || RETIRED_BANNER.test(body);
}

/** Line index of the first `---` divider, or -1. Fenced code is not scanned for it. */
function dividerLine(lines: string[]): number {
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    else if (!fenced && /^---\s*$/.test(lines[i])) return i;
  }
  return -1;
}

/** The Why section's lines (heading excluded) up to the next heading of level 1 or 2 or the divider. */
function whySection(lines: string[]): { found: boolean; headingLine: number; body: string } {
  const at = lines.findIndex((l) => WHY_HEADING.test(l));
  if (at < 0) return { found: false, headingLine: -1, body: '' };
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,2}[ \t]/.test(lines[i]) || /^---\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return { found: true, headingLine: at, body: out.join('\n') };
}

// What "restricts something" means: the issue's list and its forms. Word-bounded and case-insensitive.
const RESTRICTS = new RegExp(
  '\\b(?:exclud(?:e|es|ed|ing)|never|refus(?:e|es|ed|al|als|ing)|only|must not|may not|not allowed|not permitted|'
  + 'hidden|hide|hides|forbid|forbids|forbidden|prohibit|prohibits|prohibited|cannot|can not|can’t|can\'t)\\b',
  'i',
);

// What counts as a reason in the same paragraph. A link to a ruling or a Why section marks the sentence justified
// elsewhere (see LINK_REASON).
const REASON = new RegExp(
  '\\b(?:because|so that|since|why|to keep|to prevent|to avoid|in order to|otherwise|which is why|as a result of)\\b',
  'i',
);
const LINK_REASON = /\[\[[^\]]*(?:ruling|decision|why)[^\]]*\]\]|\]\([^)]*(?:ruling|decision|why)[^)]*\)|Why We Need This Rule/i;

interface Paragraph { line: number; text: string }

/** Paragraphs of the body above the divider: blank-line separated, one per list item, with code, headings,
 *  tables and the Why section left out (the Why section is the reason, not a restriction needing one). */
function paragraphs(lines: string[], end: number): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  let fenced = false;
  let inWhy = false;
  const flush = () => { if (cur && cur.text.trim()) out.push(cur); cur = null; };
  for (let i = 0; i < end; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { flush(); fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^#{1,6}[ \t]/.test(l)) {
      flush();
      inWhy = WHY_HEADING.test(l);
      continue;
    }
    if (inWhy) continue;
    if (!l.trim()) { flush(); continue; }
    if (/^\s*\|/.test(l) || /^\s*<[^>]*>\s*$/.test(l)) { flush(); continue; }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(l)) {
      flush();
      cur = { line: i + 1, text: l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') };
    } else if (cur) {
      cur.text += ' ' + l.trim();
    } else {
      cur = { line: i + 1, text: l.trim() };
    }
  }
  flush();
  return out;
}

function sentencesOf(text: string): string[] {
  // Links and inline code are blanked for splitting so a dot inside one never ends a sentence.
  const masked = text.replace(/\[\[[^\]]*\]\]|\]\([^)]*\)|`[^`]*`/g, (m) => 'x'.repeat(m.length));
  const out: string[] = [];
  let from = 0;
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    out.push(text.slice(from, m.index + 1).trim());
    from = m.index + 1;
  }
  if (text.slice(from).trim()) out.push(text.slice(from).trim());
  return out.filter(Boolean);
}

export function lintSpec(s: SpecLintSubject): SpecLintFinding[] {
  if (!isSpecSubject(s)) return [];
  const body = (s.content ?? '').replace(/\r\n?/g, '\n');
  if (isRetired(s, body)) return [];
  const lines = body.split('\n');
  const findings: SpecLintFinding[] = [];

  if (isRuleSpec(s)) {
    const why = whySection(lines);
    const stripped = why.body.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!why.found) {
      findings.push({
        citation: s.loc, rule: 'RULE_WHY_MISSING', severity: 'ERROR', sentence: null, line: null,
        message: 'A Rule spec needs a "## Why We Need This Rule" section.',
      });
    } else if (stripped === '') {
      findings.push({
        citation: s.loc, rule: 'RULE_WHY_EMPTY', severity: 'ERROR', sentence: null, line: why.headingLine + 1,
        message: 'The "## Why We Need This Rule" section is empty.',
      });
    }
  }

  const divider = dividerLine(lines);
  const end = divider < 0 ? lines.length : divider;
  for (const p of paragraphs(lines, end)) {
    if (REASON.test(p.text) || LINK_REASON.test(p.text)) continue;
    for (const sentence of sentencesOf(p.text)) {
      if (!RESTRICTS.test(sentence)) continue;
      if (findings.length >= SPEC_LINT_MAX_FINDINGS) return findings;
      findings.push({
        citation: s.loc, rule: 'LIMIT_WITHOUT_REASON', severity: 'WARNING', line: p.line,
        sentence: sentence.length > SENTENCE_MAX_CHARS ? sentence.slice(0, SENTENCE_MAX_CHARS - 1) + '…' : sentence,
        message: 'This sentence restricts something and gives no reason: no because/so that/since/why in its paragraph and no link to a ruling or a Why section.',
      });
    }
  }
  return findings;
}
