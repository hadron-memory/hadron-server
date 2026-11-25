/**
 * #1302 (R218, rulings 0134/0137/0138) — the assembled feature document, as one Markdown string.
 *
 * This file is the grammar of cor:spc:030:02 and nothing else: it is PURE. It reads no database, no clock
 * and no environment, so the same input gives the same bytes. Everything that depends on who is asking
 * (the read gate, includes, link readability, the portal origin, the render time) is decided by the caller
 * and handed in as data; see `resolvers.specDocument.ts`.
 */
import { stepFence, type OpenFence } from './fences.js';
import { escapeUnterminatedHtml } from './unterminatedHtml.js';

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

/** Reserve every first producer's natural ID before assigning suffixes in display order (#3551). */
function assignAnchors(parts: readonly DocPart[]): ReadonlyMap<string, string> {
  const reserved = new Set(parts.map((part) => anchorOf(part.loc)));
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  for (const part of parts) {
    const bare = anchorOf(part.loc);
    let anchor = bare;
    if (used.has(bare)) {
      let suffix = 2;
      while (reserved.has(`${bare}-${suffix}`) || used.has(`${bare}-${suffix}`)) suffix += 1;
      anchor = `${bare}-${suffix}`;
    }
    assigned.set(part.loc, anchor);
    used.add(anchor);
  }
  return assigned;
}

const WIKILINK = /\[\[([^[\]|]+?)(?:\|([^[\]]*))?\]\]/g;

/** Every wikilink target in `text`, as written, outside fenced code. */
export function wikilinkTargets(text: string): string[] {
  const out = new Set<string>();
  eachOutsideFence(text, (line) => { for (const m of line.matchAll(WIKILINK)) out.add(m[1].trim()); return line; });
  return [...out];
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

/**
 * An id value as a browser reads it, for the character references that can spell an anchor character: numeric ones with
 * any zero padding (`&#45;`, `&#x2d;`, `&#0000045`, the `;` optional) and the named ones that spell `.`, `_` or the
 * letters `fj` (`&period;`, `&lowbar;`, `&UnderBar;`, `&fjlig;`; a walk of the HTML entity table finds no others, and
 * `&hyphen;` and `&dash;` are U+2010, not the ASCII hyphen). ONE left-to-right pass, as the HTML tokenizer reads them:
 * an unterminated `&#x2d` followed by `&fjlig;` is two references, not one hex run.
 */
function decodeNumericRefs(v: string): string {
  return v.replace(/&(?:#[xX]0*([0-9a-fA-F]{1,6});?|#0*([0-9]{1,7});?|(period|lowbar|UnderBar|fjlig);)/g, (all, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return name === 'period' ? '.' : name === 'fjlig' ? 'fj' : '_';
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
  });
}

/**
 * One `id` attribute, found by its text alone (no tag, quote or block is judged): the name `id` not glued to a longer
 * name or a URL query key (`data-id`, `?id=`, `&id=`, `&amp;id=`, `#id=`, `a:id`), then `=`, then a quoted or bare value. Blanks and
 * `>` (a blockquote marker the renderer drops) may sit before the `=` and before the value. Linear: each `id=` scans only
 * its own run of blanks and its own value, and a value never contains the next match's start.
 */
const ID_ATTR = /(?<![\w:.?&=#;-])id[\s>]*=[\s>]*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi;

/**
 * #4512 (cor:spc:030:02 "Authored ids"; Peter's approach ruling, chat 143451, after five review rounds on removing the
 * attribute): an `id` attribute whose value equals an anchor assigned in this document is RENAMED `data-id`. The value,
 * the spacing, the line breaks and every other byte stay exactly as written, so no cut can join two neighbours into a
 * new live id, leave a blank line inside a tag or change the Markdown around it, and a `data-id` is never an anchor
 * target. Nothing about tags, quotes, code, comments or blocks is judged: an assigned id written anywhere (code sample,
 * comment, prose, URL path) is renamed too, and the worst case is a slightly altered sample, never a second element
 * carrying a server anchor. Limits: of the named character references only those that spell an anchor character (`.`, `_`, `fj`) are decoded (numeric ones, zero-padded or not, are), and a URL query key is not
 * an attribute (`?id=`, `&id=`, `#id=`) and is left alone.
 */
export function neutraliseAssignedIds(text: string, assigned: ReadonlySet<string>): string {
  if (assigned.size === 0 || !/id/i.test(text)) return text;
  let out = '';
  let copied = 0;
  const re = new RegExp(ID_ATTR.source, ID_ATTR.flags);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    // Resume just past the name, so a value that holds another `id=` is still searched.
    re.lastIndex = m.index + 2;
    let value = m[1] ?? m[2] ?? m[3] ?? '';
    // A bare value read up to the tag-closing slash (`<a id=X/>`) is the value without that slash.
    if (m[3] !== undefined && value.endsWith('/') && text[m.index + m[0].length] === '>') value = value.slice(0, -1);
    if (!assigned.has(decodeNumericRefs(value))) continue;
    out += `${text.slice(copied, m.index)}data-id`;
    copied = m.index + 2;
  }
  return copied === 0 ? text : out + text.slice(copied);
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

function renderLinks(text: string, links: ReadonlyMap<string, LinkResolution>, anchors: ReadonlyMap<string, string>): string {
  return eachOutsideFence(text, (line) => line.replace(WIKILINK, (_all, rawTarget: string, rawText: string | undefined) => {
    const target = rawTarget.trim();
    const shown = rawText?.trim() || undefined;
    const r = links.get(target);
    if (!r || r.kind === 'plain') return shown ?? target;
    if (r.kind === 'feature') return shown ?? r.loc;
    if (r.kind === 'part') {
      const anchor = anchors.get(r.loc);
      return anchor ? `[${shown ?? r.name}](#${anchor})` : shown ?? r.name;
    }
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
const heading = (p: DocPart): string => escapeUnterminatedHtml(p.name === p.loc || p.name.startsWith(`${p.loc} `) ? p.name : `${p.name} [${p.loc}]`);

/** The part's body as shown, or null when it shows none (placeholder, superseded, empty). */
function shownBody(p: DocPart, shift: boolean, links: ReadonlyMap<string, LinkResolution>, anchors: ReadonlyMap<string, string>, assigned: ReadonlySet<string>): string | null {
  if (p.isPlaceholder || p.superseded || p.body == null) return null;
  const { body } = splitAtClosingRule(p.body);
  const cleaned = escapeUnterminatedHtml(renderLinks(cleanBody(body, shift), links, anchors));
  return cleaned === '' ? null : cleaned;
}

/** The `YYYY-MM-DDTHH:MMZ` form of the render time. */
const renderedStamp = (d: Date): string => `${d.toISOString().slice(0, 16)}Z`;

/** Marks where the server writes its own `<a id>`; authored NUL is replaced by U+FFFD on the way in (as CommonMark does), so no authored text can forge one. */
const ANCHOR_MARK = '\u0000';
const ANCHOR_PLACEHOLDER = /\u0000([^\u0000]*)\u0000/g;
const noNul = (t: string): string => t.replace(/\u0000/g, '\uFFFD');
const cleanPart = (p: DocPart): DocPart => ({ ...p, loc: noNul(p.loc), name: noNul(p.name), body: p.body == null ? null : noNul(p.body) });

export function renderSpecDocument(rawInput: DocInput): string {
  const input: DocInput = { ...rawInput, memory: noNul(rawInput.memory), feature: cleanPart(rawInput.feature), parts: rawInput.parts.map(cleanPart) };
  const { feature, parts, links } = input;
  const anchors = assignAnchors(inDocumentOrder(parts));
  const assigned: ReadonlySet<string> = new Set(anchors.values());
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
    const featureBody = shownBody({ ...feature, superseded: false }, false, links, anchors, assigned);
    if (featureBody) blocks.push(featureBody);
  }

  for (const g of GROUPS) {
    const members = parts.filter((p) => specGroupOf(p.name) === g.key);
    if (members.length === 0) continue;
    blocks.push(`# ${g.heading}`);
    for (const p of members) {
      // The server's own anchor is a placeholder here, so the one neutralising pass over the whole document cannot touch it.
      const head = `${ANCHOR_MARK}${anchors.get(p.loc)}${ANCHOR_MARK}\n\n## ${heading(p)}\n${stateLine(p)}`;
      if (p.superseded) {
        blocks.push(`${head}\n\n${p.supersededBy.length ? `Superseded by ${p.supersededBy.join(', ')}.` : 'Superseded.'}`);
      } else if (p.isPlaceholder) {
        blocks.push(`${head}\n\nPlaceholder.`);
      } else {
        const body = shownBody(p, true, links, anchors, assigned);
        blocks.push(body ? `${head}\n\n${body}` : head);
      }
    }
  }

  if (!feature.isPlaceholder && feature.body != null) {
    const tail = renderLinks(trimNewlines(splitAtClosingRule(feature.body).tail), links, anchors);
    if (tail !== '') blocks.push(tail);
  }
  // One pass over everything the document shows, so two authored pieces that join across a blank line cannot form an id
  // that neither held alone (a part body ending `<pre id` and a Feature tail starting `="X">`); then the anchors go in.
  const text = neutraliseAssignedIds(`${blocks.join('\n\n')}\n`, assigned);
  return text.replace(ANCHOR_PLACEHOLDER, (_all, anchor: string) => `<a id="${anchor}"></a>`);
}
