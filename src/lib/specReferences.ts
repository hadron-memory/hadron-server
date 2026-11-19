/**
 * Draft spec corpora — references found by SCANNING the corpus text (#1449,
 * contract §3: https://github.com/hadron-memory/hadron-server/issues/1447#issuecomment-5895948862).
 *
 * A reference is a node URN that points into the corpus, in any accepted
 * spelling and wherever it occurs, including inside a URL: a draft writes
 * `[Rule … [pas:010:01]](https://<portal>/app/u/hrn:node:<org>:<memory>:pas:010:01)`,
 * and the URN in the href is the reference. The portal host is
 * deployment-specific, so the match is on the URN, never the URL
 * (hrn:node:hadronmemory.com:hadron-cli:findings:spec-text-references-are-portal-urls).
 *
 * Only references INTO this corpus are recognized: the pattern is anchored on
 * the corpus's own memory URN (plus any URN it was published under before a
 * rename). That is exactly what backlinks, unresolved references and renumber
 * need, and it avoids guessing where a foreign URN's memory ends.
 *
 * A citation that appears only as TEXT (a link label `[pas:010:01]`, a node
 * name) is not a reference: it cannot be told apart from other prose that
 * contains the same characters. Renumber reports those copies with their
 * location instead of rewriting them.
 */

/** One loc atom (validateLoc's spec 021 charset and 64-character cap). */
const ATOM = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?';
/** A loc: atoms joined by single colons. */
const LOC = `${ATOM}(?::${ATOM})*`;
/** Separator between URN parts: canonical `::` or legacy `:`. */
const SEP = '(?:::|:)';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A reference found in a piece of text. `targetLoc` is the cited spec's loc. */
export interface TextReferenceMatch {
  start: number;
  end: number;
  /** The whole matched URN, as written. */
  urn: string;
  targetLoc: string;
  /** Offset of `targetLoc` within the text (the only part a renumber rewrites). */
  locStart: number;
  /**
   * The memory URN the reference was written with, normalized to `<org>:<name>`
   * (the corpus's current URN or one of its former ones). A former URN that
   * another live memory now holds is resolved with live-address precedence by
   * the caller, exactly as `resolveNodeRef` does.
   */
  memoryUrn: string;
}

/**
 * The pattern matching a node URN into a memory published under any of
 * `memoryUrns` (each `<org>:<name>`, unprefixed). Accepts `hrn:node:` or
 * `urn:node:` prefixes (any case) or none, `:` or `::` between org, memory and
 * loc, and requires at least one loc atom. The left boundary keeps a longer
 * org name (`xmicromentor.org`) from matching; the loc grammar itself stops a
 * trailing `.`, `)` or `]` from being swallowed.
 */
export function corpusReferencePattern(memoryUrns: readonly string[]): RegExp {
  const memories = [...new Set(memoryUrns)]
    .map((urn) => {
      const i = urn.indexOf(':');
      if (i < 0) throw new Error(`corpusReferencePattern: memory URN "${urn}" is not <org>:<name>`);
      return `${escapeRe(urn.slice(0, i))}${SEP}${escapeRe(urn.slice(i + 1).replace(/^:/, ''))}`;
    })
    // Longest first, so a memory whose name extends another's is tried first.
    .sort((a, b) => b.length - a.length);
  return new RegExp(
    // (@codex P2, #1453) Nor followed by a `:` that continues the address: in
    // the canonical grammar the loc is the FINAL `::` leaf (resolveNodeRef), so
    // `<corpus>::pas:010::x` names loc `x` in a deeper memory, not `pas:010`
    // here. Rejecting only `::` is not enough, since the loc would backtrack to
    // `pas`; a real loc already consumes every `:<atom>` greedily.
    `(?<![A-Za-z0-9._:-])((?:[Hh][Rr][Nn]|[Uu][Rr][Nn]):[Nn][Oo][Dd][Ee]:)?(${memories.join('|')})${SEP}(${LOC})(?![A-Za-z0-9_-]|:[A-Za-z0-9:]|\\.[._-]*[A-Za-z0-9])`,
    'g',
  );
}

/** Every reference into the corpus that `text` contains, in order. */
export function findCorpusReferences(text: string | null | undefined, pattern: RegExp): TextReferenceMatch[] {
  if (!text) return [];
  const out: TextReferenceMatch[] = [];
  for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const urn = m[0];
    const targetLoc = m[3];
    // (@codex P2, #1453) One separator style throughout: all legacy `:` or all
    // canonical `::`. resolveNodeRef rejects a mix (`org::memory:loc`,
    // `org:memory::loc`), so it is not a reference. The org has no `:`, so the
    // character after the org's first `:` tells the org/memory separator.
    const memory = m[2];
    const orgEnd = memory.indexOf(':');
    const memorySep = memory[orgEnd + 1] === ':' ? '::' : ':';
    const locSep = urn.slice((m[1] ?? '').length + memory.length, urn.length - targetLoc.length);
    if (memorySep !== locSep) continue;
    out.push({
      start: m.index!,
      end: m.index! + urn.length,
      urn,
      targetLoc,
      locStart: m.index! + urn.length - targetLoc.length,
      memoryUrn: m[2].replace('::', ':'),
    });
  }
  return out;
}

/**
 * Map a cited loc through a renumber of `fromLoc` → `toLoc`: the spec itself
 * and every descendant move, anything else is untouched (null).
 */
export function renumberedLoc(loc: string, fromLoc: string, toLoc: string): string | null {
  if (loc === fromLoc) return toLoc;
  if (loc.startsWith(`${fromLoc}:`)) return `${toLoc}${loc.slice(fromLoc.length)}`;
  return null;
}

/**
 * Rewrite every reference into the renumbered subtree, keeping its prefix,
 * separator style and surrounding URL. When supplied, canonicalMemoryUrn
 * replaces a former memory name: a reused published name could resolve the
 * new loc to a different memory after the move.
 */
export function rewriteCorpusReferences(
  text: string,
  pattern: RegExp,
  fromLoc: string,
  toLoc: string,
  /** False for a foreign reference; a loc for an alias into the corpus at a different address. */
  accept: (ref: TextReferenceMatch) => boolean | string | null = () => true,
  canonicalMemoryUrn?: string,
): { text: string; count: number } {
  let count = 0;
  let out = '';
  let last = 0;
  for (const ref of findCorpusReferences(text, pattern)) {
    const resolved = accept(ref);
    if (resolved === false || resolved === null) continue;
    const next = renumberedLoc(typeof resolved === 'string' ? resolved : ref.targetLoc, fromLoc, toLoc);
    if (next === null) continue;
    if (canonicalMemoryUrn && ref.memoryUrn !== canonicalMemoryUrn) {
      const prefix = ref.urn.match(/^(?:hrn|urn):node:/i)?.[0] ?? '';
      const separator = ref.urn.slice(0, -ref.targetLoc.length).endsWith('::') ? '::' : ':';
      out += text.slice(last, ref.start) + prefix
        + canonicalMemoryUrn.replace(/::/g, ':').replace(/:/g, separator) + separator + next;
    } else {
      out += text.slice(last, ref.locStart) + next;
    }
    last = ref.end;
    count++;
  }
  return { text: count === 0 ? text : out + text.slice(last), count };
}

/** Where a citation appears as bare text, outside any URN reference. */
export interface TextCitationMatch {
  start: number;
  citation: string;
  /** A short window around the match, for a human to find it. */
  excerpt: string;
}

/**
 * Bare-text occurrences of any citation in the renumbered subtree (`fromLoc`
 * and its descendants): link labels, names, prose. Occurrences inside a
 * recognized URN are excluded, since the rewrite handles those. Bounded on both
 * sides by non-loc characters, so `pas:010` does not match inside `pas:0101`,
 * but DOES match `pas:010:01`'s prefix only as part of that longer citation.
 */
export function findTextCitations(
  text: string | null | undefined,
  pattern: RegExp,
  fromLoc: string,
): TextCitationMatch[] {
  if (!text) return [];
  const urnSpans = findCorpusReferences(text, pattern).map((r) => [r.start, r.end] as const);
  const insideUrn = (i: number) => urnSpans.some(([s, e]) => i >= s && i < e);
  // (@codex P2, #1453) A dot followed by an atom character continues the loc
  // (`pas:010.v2` is a different citation), while a dot ending a sentence
  // does not. Interior dots, underscores and dashes continue the atom only
  // when an alphanumeric end follows (`pas:010..v2`, not `pas:010...`).
  const re = new RegExp(`(?<![A-Za-z0-9._:-])${escapeRe(fromLoc)}(?::${ATOM})*(?![A-Za-z0-9_:-]|\\.[._-]*[A-Za-z0-9])`, 'g');
  const out: TextCitationMatch[] = [];
  for (const m of text.matchAll(re)) {
    if (insideUrn(m.index!)) continue;
    const from = Math.max(0, m.index! - 30);
    const to = Math.min(text.length, m.index! + m[0].length + 30);
    out.push({ start: m.index!, citation: m[0], excerpt: text.slice(from, to).replace(/\s+/g, ' ') });
  }
  return out;
}

/** The text fields a corpus scan reads. `data`/`properties` (JSON) are not text. */
export const SCANNED_FIELDS = ['name', 'description', 'abstract', 'content'] as const;
export type ScannedField = (typeof SCANNED_FIELDS)[number];

/**
 * #1594 — every explicitly prefixed node URN (`hrn:node:` / `urn:node:`, any
 * case) `text` contains, as written, deduplicated, in order. Unlike
 * `corpusReferencePattern` this is not anchored on a known memory: it finds
 * candidates for a CALLER-GATED resolver (`resolveNodeRefForCaller`) that owns
 * the org/memory/loc split, which the grammar cannot make without the
 * database. A bare `org:memory:loc` has no prefix and is deliberately not
 * matched: it cannot be told apart from hostnames, ratios and other prose.
 * Atoms end in an alphanumeric, so trailing `.`, `)` or `,` are never taken.
 */
const NODE_URN_TOKEN = new RegExp(
  `(?<![A-Za-z0-9._:-])(?:[Hh][Rr][Nn]|[Uu][Rr][Nn]):[Nn][Oo][Dd][Ee]:${ATOM}(?:${SEP}${ATOM})+(?![A-Za-z0-9_-]|:[A-Za-z0-9])`,
  'g',
);
export function findNodeUrnTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set(text.match(NODE_URN_TOKEN) ?? [])];
}
