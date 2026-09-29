/**
 * Minting a draft spec corpus (#1448, contract §5:
 * https://github.com/hadron-memory/hadron-server/issues/1447#issuecomment-5895948862;
 * rulings relayed in team chat #4086).
 *
 * The pure half of the mint report: the structural lint the server enforces,
 * the "is this node a citation" scope, and the open-question parse. The
 * resolver (resolvers.specCorpus.ts) combines these with the placeholder and
 * reference-scan data under the corpus lock.
 *
 * LINT OWNERSHIP (ruling (a)): the server owns and enforces exactly four
 * error-level rules at mint, ported from hadron-cli's `spec lint`
 * (internal/cmd/spec/lint.go): nodetype-info, the spec marker (reported as
 * `tag-spec`, the CLI's rule id), serialization-leak and duplicate-loc.
 * Everything else in the CLI's lint stays advisory there. The rule cases live
 * in specMint.fixtures.json so the Go and TypeScript copies can be held to the
 * same examples.
 */

/** A lint finding at mint. `rule` uses the CLI's rule ids. */
export interface MintLintFinding {
  loc: string;
  rule: 'nodetype-info' | 'tag-spec' | 'serialization-leak' | 'duplicate-loc';
  message: string;
}

/** The fields the mint lint reads. */
export interface MintLintNode {
  loc: string;
  nodeType: string | null;
  tags: string[];
  role: string | null;
  abstract: string | null;
  content: string | null;
}

const MODULE = /^[a-z]{3}$/;
const FEATURE = /^[0-9]{3}$/;
const TWO_DIGIT = /^[0-9]{2}$/;

/**
 * Whether a loc is citation-shaped: `[<product>:]<module>[:<feature>[:<rule>[:<flow>]]]`
 * with 3-letter product/module, 3-digit feature and 2-digit rule/flow. This is
 * the CLI's ParseCitation, and exactly the set its `spec lint --all` scans.
 * A memory's root node (loc = the memory's name) and other non-citation nodes
 * are outside the corpus lint, as they are in the CLI.
 */
export function isCitationLoc(loc: string): boolean {
  const parts = loc.trim().split(':');
  if (!MODULE.test(parts[0])) return false;
  const rest = parts.length > 1 && MODULE.test(parts[1]) ? parts.slice(1) : parts;
  if (rest.length > 4) return false;
  if (rest.length > 1 && !FEATURE.test(rest[1])) return false;
  if (rest.length > 2 && !TWO_DIGIT.test(rest[2])) return false;
  if (rest.length > 3 && !TWO_DIGIT.test(rest[3])) return false;
  return true;
}

/** The spec role family: `spec` or a dotted descendant (never a bare prefix like `special`). */
function roleInSpecFamily(role: string | null): boolean {
  return role === 'spec' || (role?.startsWith('spec.') ?? false);
}

/** The spec marker of ruling (a): a `spec` tag, or a role in the spec family. */
export function hasSpecMarker(n: { tags: readonly string[]; role: string | null }): boolean {
  return n.tags.includes('spec') || roleInSpecFamily(n.role);
}

/**
 * Writing-tool field delimiters, never spec content (CLI #545). Their presence
 * means one field absorbed another, and the absorbed one may be the only copy.
 */
export const SERIALIZATION_MARKERS = [
  '</abstract>', '<abstract>',
  '</content>', '<content>',
  '<parameter name=', '</parameter>',
  '<function_calls>', '</function_calls>',
  '<invoke name=', '</invoke>',
] as const;

/** Indentation width (a tab counts 4, per CommonMark) and the line without it. */
function splitIndent(line: string): [number, string] {
  let w = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') w++;
    else if (line[i] === '\t') w += 4;
    else return [w, line.slice(i)];
  }
  return [w, ''];
}

/** The fence run (3+ backticks or tildes) a trimmed line starts with, or ''. */
function fenceRun(trimmed: string): string {
  const c = trimmed[0];
  if (c !== '`' && c !== '~') return '';
  let n = 0;
  while (n < trimmed.length && trimmed[n] === c) n++;
  return n >= 3 ? trimmed.slice(0, n) : '';
}

/** A fence OPENER: a backtick fence's info string may not contain a backtick. */
function fenceOpener(trimmed: string): string {
  const run = fenceRun(trimmed);
  if (run === '') return '';
  if (run[0] === '`' && trimmed.slice(run.length).includes('`')) return '';
  return run;
}

/**
 * Remove FENCED code blocks and nothing else (the CLI's withoutCode), so a spec
 * that documents a marker is not reported for it. Never blinding: an unclosed
 * fence is restored as prose from its opener onward.
 */
export function withoutFencedCode(s: string): string {
  // CRLF-authored bodies too (@codex P2, PR #1462): a residual `\r` would stop a
  // closing fence from closing and a heading from parsing. Lines rejoin with `\n`.
  const lines = s.split(/\r?\n/);
  const kept = new Array<string>(lines.length);
  let open = '';
  let openAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const [indent, trimmed] = splitIndent(lines[i]);
    if (open !== '') {
      const run = fenceRun(trimmed);
      if (indent <= 3 && run !== '' && run[0] === open[0] && run.length >= open.length
        && trimmed.slice(run.length).replace(/[ \t]/g, '') === '') {
        open = '';
      }
      kept[i] = '';
    } else if (indent <= 3 && fenceOpener(trimmed) !== '') {
      open = fenceOpener(trimmed);
      openAt = i;
      kept[i] = '';
    } else {
      kept[i] = lines[i];
    }
  }
  if (open !== '') for (let i = openAt; i < lines.length; i++) kept[i] = lines[i];
  return kept.join('\n');
}

/** The serialization markers present in `s` outside fenced code, in list order. */
export function leakedMarkers(s: string): string[] {
  const prose = withoutFencedCode(s);
  return SERIALIZATION_MARKERS.filter((m) => prose.includes(m));
}

/** The per-node rules, as the CLI's lintNode applies them. */
export function lintNodeForMint(n: MintLintNode): MintLintFinding[] {
  const out: MintLintFinding[] = [];
  if (n.nodeType !== 'info') {
    out.push({ loc: n.loc, rule: 'nodetype-info', message: `nodeType must be "info", got ${JSON.stringify(n.nodeType ?? '')}` });
  }
  if (!hasSpecMarker(n)) {
    out.push({ loc: n.loc, rule: 'tag-spec', message: 'missing "spec" tag or spec-family role' });
  }
  for (const [name, text] of [['abstract', n.abstract], ['body', n.content]] as const) {
    if (text == null) continue;
    const leaked = leakedMarkers(text);
    if (leaked.length > 0) {
      out.push({
        loc: n.loc,
        rule: 'serialization-leak',
        message: `${name} contains writing-tool markup (${leaked.join(', ')}): a field has absorbed another, and the absorbed one may be the only copy; recover it before editing, and do NOT truncate at the marker`,
      });
    }
  }
  return out;
}

/**
 * The corpus lint at mint: per-node rules over the citation-shaped nodes, plus
 * duplicate-loc across them (one finding per duplicated loc). The live
 * (loc, memoryId) index makes a duplicate impossible in the database; the rule
 * is kept so the server and CLI rule sets stay the same.
 */
export function lintCorpusForMint(nodes: readonly MintLintNode[]): MintLintFinding[] {
  const cited = nodes.filter((n) => isCitationLoc(n.loc));
  const out = cited.flatMap(lintNodeForMint);
  const count = new Map<string, number>();
  for (const n of cited) count.set(n.loc, (count.get(n.loc) ?? 0) + 1);
  for (const [loc, c] of count) {
    if (c > 1) out.push({ loc, rule: 'duplicate-loc', message: 'duplicate citation: two nodes share this loc' });
  }
  return out;
}

/** One open question found in a spec (ruling (b): report-only, never blocks). */
export interface OpenQuestion {
  question: string;
  /** Who decides, from a trailing "<Name> decides."; null is reported as unassigned. */
  decider: string | null;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t#]*$/;
/** A list item's marker and its text, on a line with its indentation removed. */
const LIST_ITEM = /^(?:[-+*]|\d{1,9}[.)])[ \t]+(.*)$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Parse a spec body's open questions (ruling (b)). Any heading, at any level,
 * whose text contains "Open Questions" (case-insensitive) starts a section,
 * which runs to the next heading at the same or a higher level (or a thematic
 * break). Each top-level bullet in it is one question; indented lines continue
 * it. A NESTED list item (indented deeper than the section's first bullet) is
 * supporting detail: it and everything after it in that item are left out, so
 * the item's own text keeps its trailing decider (@codex P2, PR #1462). The
 * decider is a trailing "<Name> decides." on the bullet; without one it is
 * unassigned. Fenced code is ignored. The question text is the bullet's
 * leading bold phrase when it has one, otherwise its first 200 characters.
 */
export function parseOpenQuestions(content: string | null | undefined): OpenQuestion[] {
  if (!content) return [];
  const lines = withoutFencedCode(content).split('\n');
  const out: OpenQuestion[] = [];
  let sectionLevel = 0; // 0 = not in an Open Questions section
  let outerIndent = -1; // the section's first bullet's indent; -1 = none yet
  let current: string[] | null = null;
  let inNested = false; // the current item has reached a nested list
  const flush = () => {
    if (!current) return;
    const text = current.join(' ').replace(/\s+/g, ' ').trim();
    current = null;
    if (text === '') return;
    const decides = /(?:^|[.;:!?)\]*]\s+)([^.;:!?]*?[^\s.;:!?])\s+decides\.\s*$/i.exec(text);
    const bold = /^\*\*(.+?)\*\*/.exec(text);
    out.push({
      question: (bold ? bold[1] : text).slice(0, 200).trim(),
      decider: decides ? decides[1].replace(/^\*+|\*+$/g, '').trim() : null,
    });
  };
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      if (sectionLevel > 0 && level <= sectionLevel) { flush(); sectionLevel = 0; }
      if (/open questions/i.test(h[2] ?? '')) { flush(); sectionLevel = level; outerIndent = -1; }
      continue;
    }
    if (sectionLevel === 0) continue;
    if (THEMATIC_BREAK.test(line)) { flush(); sectionLevel = 0; continue; }
    const [indent, trimmed] = splitIndent(line);
    const item = LIST_ITEM.exec(trimmed);
    if (item && (outerIndent < 0 || indent <= outerIndent) && indent <= 3) {
      flush();
      if (outerIndent < 0) outerIndent = indent;
      current = [item[1]];
      inNested = false;
      continue;
    }
    if (!current) continue;
    if (item) { inNested = true; continue; }
    if (!inNested && trimmed !== '' && indent > 0) current.push(trimmed);
  }
  flush();
  return out;
}

/**
 * Whether a stale abstract BLOCKS minting (contract §5). It does, but only once
 * re-affirming an unchanged abstract is actually saved (server#1408) and the
 * CLI that sends it (hadron-cli#750) are deployed; until then an author cannot
 * clear a stale abstract without editing its text, so the report lists stale
 * abstracts without blocking. Flip this to `true` when both have shipped.
 */
export const STALE_ABSTRACT_BLOCKS_MINT = false;
