/**
 * #1302 (R218, rulings 0134/0137/0138) — the assembled feature document, as one Markdown string.
 *
 * This file is the grammar of cor:spc:030:02 and nothing else: it is PURE. It reads no database, no clock
 * and no environment, so the same input gives the same bytes. Everything that depends on who is asking
 * (the read gate, includes, link readability, the portal origin, the render time) is decided by the caller
 * and handed in as data; see `resolvers.specDocument.ts`.
 */

/** The ten spec type words (cor:spc:030:02). A name starts with one of them followed by `:`. */
export const SPEC_TYPE_WORDS = [
  'Tenet', 'Module', 'Feature', 'Flow', 'Operation', 'Lifecycle', 'Rule', 'Entity', 'Definition', 'Format',
] as const;
export type SpecTypeWord = (typeof SPEC_TYPE_WORDS)[number];

/**
 * The group order and headings. `Feature` is the open point "where does a sub-Feature go": until Holger
 * rules, it takes the recommended `Features` group before Definitions. `Other` (no type word) is last.
 */
const GROUPS: ReadonlyArray<{ key: SpecTypeWord | 'Other'; heading: string }> = [
  { key: 'Feature', heading: 'Features' },
  { key: 'Definition', heading: 'Definitions' },
  { key: 'Entity', heading: 'Entities' },
  { key: 'Rule', heading: 'Rules' },
  { key: 'Operation', heading: 'Operations' },
  { key: 'Lifecycle', heading: 'Lifecycles' },
  { key: 'Flow', heading: 'Flows' },
  { key: 'Format', heading: 'Formats' },
  { key: 'Tenet', heading: 'Tenets' },
  { key: 'Module', heading: 'Modules' },
  { key: 'Other', heading: 'Other specs' },
];

/** The group a part belongs to: from the name's first word, never from the body. */
export function specGroupOf(name: string): SpecTypeWord | 'Other' {
  const m = /^([A-Za-z]+):/.exec(name);
  const word = m?.[1];
  return (SPEC_TYPE_WORDS as readonly string[]).includes(word ?? '') ? (word as SpecTypeWord) : 'Other';
}

/** The parts in the order the document shows them: type groups in the ruled order, citation order inside each (stable). */
export function inDocumentOrder<T extends { name: string }>(parts: readonly T[]): T[] {
  return GROUPS.flatMap((g) => parts.filter((p) => specGroupOf(p.name) === g.key));
}

export type ApprovalLine =
  | { state: 'APPROVED'; revision: number | null }
  | { state: 'NOT_APPROVED' }
  | { state: 'CHANGED_SINCE_APPROVAL'; revision: number | null };

/** One spec, already read as the caller, in the form the grammar needs. */
export interface DocPart {
  loc: string;
  name: string;
  /** The body as an ordinary read returns it (includes resolved). Null for a placeholder. */
  body: string | null;
  isPlaceholder: boolean;
  /** Carries the `superseded` tag (cor:spc:030:02: an approval state of SUPERSEDED does not count). */
  superseded: boolean;
  /** Citations the part is superseded by, already in sibling order and already filtered to readable ones. */
  supersededBy: string[];
  approval: ApprovalLine;
  minted: boolean;
}

/** How one wikilink target is shown. */
export type LinkResolution =
  | { kind: 'part'; loc: string; name: string }
  | { kind: 'feature'; loc: string }
  | { kind: 'external'; url: string; label: string }
  | { kind: 'plain' };

export interface DocInput {
  /** The memory, as `<root>:<slug>`. */
  memory: string;
  renderedAt: Date;
  feature: DocPart;
  /** Every other part, in depth-first citation order (the caller sorts with `siblingOrder.ts`). */
  parts: DocPart[];
  /** Resolution of each wikilink target string, as written. A target missing from the map is plain text. */
  links: ReadonlyMap<string, LinkResolution>;
}

/** The anchor of a part: its citation with each `:` replaced by `-`. */
export const anchorOf = (loc: string): string => loc.replace(/:/g, '-');

const WIKILINK = /\[\[([^[\]|]+?)(?:\|([^[\]]*))?\]\]/g;

/** Every wikilink target in `text`, as written, outside fenced code. */
export function wikilinkTargets(text: string): string[] {
  const out = new Set<string>();
  eachOutsideFence(text, (line) => { for (const m of line.matchAll(WIKILINK)) out.add(m[1].trim()); return line; });
  return [...out];
}

/** An open fenced code block: the delimiter character and the length it opened with (CommonMark 4.5). */
interface OpenFence { ch: string; len: number }

/**
 * One line against the fence state. A fence opens with 3+ backticks or tildes (up to 3 spaces of indent; a
 * backtick fence's info string holds no backtick) and closes only on the same character, at least as long,
 * with nothing after it but whitespace. A shorter or different delimiter inside is body text.
 */
function stepFence(line: string, open: OpenFence | null): { open: OpenFence | null; fenceLine: boolean } {
  if (open === null) {
    const f = /^ {0,3}(?=(`{3,}|~{3,}))\1(.*)$/.exec(line);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) return { open: { ch: f[1][0], len: f[1].length }, fenceLine: true };
    return { open: null, fenceLine: false };
  }
  const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (c && c[1][0] === open.ch && c[1].length >= open.len) return { open: null, fenceLine: true };
  return { open, fenceLine: false };
}

function eachOutsideFence(text: string, fn: (line: string) => string | null): string {
  let fence: OpenFence | null = null;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const step = stepFence(line, fence);
    const wasOpen = fence !== null;
    fence = step.open;
    if (step.fenceLine || wasOpen) { out.push(line); continue; }
    const r = fn(line);
    if (r !== null) out.push(r);
  }
  return out.join('\n');
}

/**
 * A spec body cut at its closing `---` (the first standalone one outside fenced code): the part shown, and
 * the tail dropped for a part (kept, at the end, for the Feature). A body with no `---` is all body.
 */
export function splitAtClosingRule(text: string): { body: string; tail: string } {
  let fence: OpenFence | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const wasOpen = fence !== null;
    const step = stepFence(lines[i], fence);
    fence = step.open;
    if (step.fenceLine || wasOpen) continue;
    if (/^---\s*$/.test(lines[i])) {
      return { body: lines.slice(0, i).join('\n'), tail: lines.slice(i + 1).join('\n') };
    }
  }
  return { body: text, tail: '' };
}

const SPEC_CORE_DIV = /^<div class="spec-core"[^>]*><\/div>\s*$/;

/** Drop the spec's own H1 and the `spec-core` divider divs; optionally move every heading down one level. */
function cleanBody(text: string, shift: boolean): string {
  let droppedH1 = false;
  const lines = eachOutsideFence(text, (line) => {
    if (SPEC_CORE_DIV.test(line)) return null;
    const h = /^(#{1,6})(\s.*)$/.exec(line);
    if (!h) return line;
    if (!droppedH1 && h[1].length === 1) { droppedH1 = true; return null; }
    return shift ? `${'#'.repeat(Math.min(6, h[1].length + 1))}${h[2]}` : line;
  });
  return trimNewlines(collapseBlankRuns(lines));
}

/** `text` without leading and trailing newlines, in one pass from each end (a `/^\n+|\n+$/g` regex is quadratic on a mid-string run). */
export function trimNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '\n') start += 1;
  while (end > start && text[end - 1] === '\n') end -= 1;
  return text.slice(start, end);
}

/** Runs of blank lines become one blank line OUTSIDE fenced code; inside a fence every byte stays (a code sample may hold blank runs). */
function collapseBlankRuns(text: string): string {
  let fence: OpenFence | null = null;
  let blanks = 0;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const wasOpen = fence !== null;
    const step = stepFence(line, fence);
    fence = step.open;
    if (step.fenceLine || wasOpen) { blanks = 0; out.push(line); continue; }
    if (line.trim() === '') { blanks += 1; if (blanks > 1) continue; } else blanks = 0;
    out.push(line);
  }
  return out.join('\n');
}

/** True when an Open Questions section holds a bullet (the way the mint report reads it, cor:dmo:120:07). */
export function hasOpenQuestions(body: string): boolean {
  let level: number | null = null;
  let found = false;
  eachOutsideFence(body, (line) => {
    const h = /^(#{1,6})(?=(\s+))\2(.*)$/.exec(line);
    if (h) {
      if (level !== null && h[1].length <= level) level = null;
      if (/^open questions\b/i.test(h[3].trim())) level = h[1].length;
    } else if (level !== null && /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) found = true;
    return line;
  });
  return found;
}

function renderLinks(text: string, links: ReadonlyMap<string, LinkResolution>): string {
  return eachOutsideFence(text, (line) => line.replace(WIKILINK, (_all, rawTarget: string, rawText: string | undefined) => {
    const target = rawTarget.trim();
    const shown = rawText?.trim() || undefined;
    const r = links.get(target);
    if (!r || r.kind === 'plain') return shown ?? target;
    if (r.kind === 'feature') return shown ?? r.loc;
    if (r.kind === 'part') return `[${shown ?? r.name}](#${anchorOf(r.loc)})`;
    return `[${shown ?? r.label}](${r.url})`;
  }));
}

const approvalText = (a: ApprovalLine): string => {
  if (a.state === 'NOT_APPROVED') return 'NOT_APPROVED';
  const rev = a.revision == null ? '' : ` (rev ${a.revision})`;
  return a.state === 'APPROVED' ? `APPROVED${rev}` : `CHANGED SINCE APPROVAL${rev}`;
};

const stateLine = (p: DocPart): string => `Approval: ${approvalText(p.approval)} · Mint: ${p.minted ? 'minted' : 'unminted'}`;

/** A name that already leads with its citation as a whole word (not a longer loc like `fx:110:06x`) is not suffixed. */
const heading = (p: DocPart): string => (p.name === p.loc || p.name.startsWith(`${p.loc} `) ? p.name : `${p.name} [${p.loc}]`);

/** The part's body as shown, or null when it shows none (placeholder, superseded, empty). */
function shownBody(p: DocPart, shift: boolean, links: ReadonlyMap<string, LinkResolution>): string | null {
  if (p.isPlaceholder || p.superseded || p.body == null) return null;
  const { body } = splitAtClosingRule(p.body);
  const cleaned = renderLinks(cleanBody(body, shift), links);
  return cleaned === '' ? null : cleaned;
}

/** The `YYYY-MM-DDTHH:MMZ` form of the render time. */
const renderedStamp = (d: Date): string => `${d.toISOString().slice(0, 16)}Z`;

export function renderSpecDocument(input: DocInput): string {
  const { feature, parts, links } = input;
  const all = [feature, ...parts];
  const openQuestions = all
    .filter((p) => !p.isPlaceholder && !p.superseded && p.body != null && hasOpenQuestions(splitAtClosingRule(p.body).body))
    .map((p) => p.loc);
  const readiness = [
    `${all.length} ${all.length === 1 ? 'spec' : 'specs'}`,
    `${all.filter((p) => p.approval.state === 'APPROVED').length} approved`,
    `${all.filter((p) => p.minted).length} minted`,
    `${all.filter((p) => p.superseded).length} superseded`,
    openQuestions.length ? `open questions in ${openQuestions.join(', ')}` : 'no open questions',
  ].join(' · ');

  const blocks: string[] = [
    `# ${heading(feature)}\n\n${input.memory} · rendered ${renderedStamp(input.renderedAt)}\n\nReadiness: ${readiness}`,
  ];
  if (feature.isPlaceholder) blocks.push('Placeholder.');
  else {
    const featureBody = shownBody({ ...feature, superseded: false }, false, links);
    if (featureBody) blocks.push(featureBody);
  }

  for (const g of GROUPS) {
    const members = parts.filter((p) => specGroupOf(p.name) === g.key);
    if (members.length === 0) continue;
    blocks.push(`# ${g.heading}`);
    for (const p of members) {
      const head = `<a id="${anchorOf(p.loc)}"></a>\n\n## ${heading(p)}\n${stateLine(p)}`;
      if (p.superseded) {
        blocks.push(`${head}\n\n${p.supersededBy.length ? `Superseded by ${p.supersededBy.join(', ')}.` : 'Superseded.'}`);
      } else if (p.isPlaceholder) {
        blocks.push(`${head}\n\nPlaceholder.`);
      } else {
        const body = shownBody(p, true, links);
        blocks.push(body ? `${head}\n\n${body}` : head);
      }
    }
  }

  if (!feature.isPlaceholder && feature.body != null) {
    const tail = renderLinks(trimNewlines(splitAtClosingRule(feature.body).tail), links);
    if (tail !== '') blocks.push(tail);
  }
  return `${blocks.join('\n\n')}\n`;
}
