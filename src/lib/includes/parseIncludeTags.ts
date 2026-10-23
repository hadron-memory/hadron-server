import { splitNodeUrn } from '@hadron-memory/urn-lib-js';

/** Settings an include tag may carry. Parsed and kept verbatim; S3 (#1838) owns qualification. */
export interface IncludeSettings {
  rev?: number;
  approved?: boolean;
  signed?: boolean;
}

export interface IncludeTag {
  /** `loc` = a same-memory loc; `urn` = a node URN (a fully qualified `hrn:node:` URN). */
  kind: 'loc' | 'urn';
  /** The loc, or the URN as written. */
  target: string;
  settings: IncludeSettings;
  /** The tag text exactly as authored, braces included. */
  raw: string;
}

export class IncludeSyntaxError extends Error {
  constructor(public readonly raw: string, public readonly reason: string) {
    super(`Invalid include tag ${raw}: ${reason}`);
    this.name = 'IncludeSyntaxError';
  }
}

/**
 * Blank out literal code (fenced blocks, indented blocks, inline code spans),
 * preserving length so offsets still line up: an include tag written as code
 * is text, not a partial. Mustache itself does not know markdown, so this is
 * the one place the "code is literal" rule lives (#2040).
 */
function maskCode(content: string): string {
  const lines = content.split('\n');
  let fence: string | null = null;
  let prevBlank = true;
  let inIndented = false;
  const blocks = lines.map(line => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // A closing fence is the same character, at least as long, and nothing else on the line.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === '') fence = null;
      return ' '.repeat(line.length);
    }
    // A backtick fence's info string cannot contain a backtick (else it is an inline span).
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      fence = fenceMatch[1];
      return ' '.repeat(line.length);
    }
    const blank = line.trim() === '';
    const indented = /^(?: {4}|\t)/.test(line) && !blank;
    if (indented && (prevBlank || inIndented)) {
      inIndented = true;
      prevBlank = false;
      return ' '.repeat(line.length);
    }
    if (!blank) inIndented = false;
    prevBlank = blank;
    return line;
  });
  // Inline code spans may wrap across lines inside one paragraph: a run of N
  // backticks closes at the next run of exactly N, never across a blank line.
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length === 0) return;
    const text = para.join('\n').replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, m => m.replace(/[^\n]/g, ' '));
    out.push(...text.split('\n'));
    para = [];
  };
  for (const line of blocks) {
    if (line.trim() === '') { flush(); out.push(line); } else para.push(line);
  }
  flush();
  return out.join('\n');
}

const TAG = /\{\{>\s*([^}]*?)\s*\}\}/g;

/**
 * Parse every include tag outside code. Throws `IncludeSyntaxError` for a tag
 * whose target or settings are malformed, so the write path can refuse it.
 */
export function parseIncludeTags(content: string): IncludeTag[] {
  return locateIncludeTags(content).map(({ index: _index, ...tag }) => tag);
}

/**
 * The include-shaped text that `locateIncludeTags` skips because it is written
 * as code, with each span's offset (#2135). Same `maskCode`, so the splice and
 * the renderer cannot disagree about what is code. Never throws.
 */
export function locateLiteralIncludeTags(content: string): Array<{ index: number; raw: string }> {
  if (!content.includes('{{>')) return [];
  const masked = maskCode(content);
  const active: Array<[number, number]> = [...masked.matchAll(TAG)].map(m => [m.index!, m.index! + m[0].length]);
  const literal: Array<{ index: number; raw: string }> = [];
  for (const m of content.matchAll(TAG)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (active.some(([a, b]) => start < b && a < end)) continue;
    literal.push({ index: start, raw: m[0] });
  }
  return literal;
}

/** `parseIncludeTags` with each tag's offset in `content`, for the reader that splices resolved text in (#2041). */
export function locateIncludeTags(content: string): Array<IncludeTag & { index: number }> {
  if (!content.includes('{{>')) return [];
  const masked = maskCode(content);
  const tags: Array<IncludeTag & { index: number }> = [];
  for (const m of masked.matchAll(TAG)) {
    const raw = content.slice(m.index!, m.index! + m[0].length);
    const parts = m[1].split(/\s+/).filter(Boolean);
    const target = parts.shift();
    if (!target) throw new IncludeSyntaxError(raw, 'missing target');
    const settings: IncludeSettings = {};
    for (const p of parts) {
      const rev = /^rev=(\d+)$/.exec(p);
      if (rev && Number(rev[1]) > 0 && settings.rev === undefined) settings.rev = Number(rev[1]);
      else if (p === 'approved' && !settings.approved) settings.approved = true;
      else if (p === 'signed' && !settings.signed) settings.signed = true;
      else throw new IncludeSyntaxError(raw, `unknown or repeated setting "${p}"`);
    }
    if (target.startsWith('hrn:') || target.startsWith('urn:')) {
      try {
        splitNodeUrn(target);
      } catch {
        throw new IncludeSyntaxError(raw, 'target is not a valid node URN');
      }
      tags.push({ kind: 'urn', target, settings, raw, index: m.index! });
    } else {
      tags.push({ kind: 'loc', target, settings, raw, index: m.index! });
    }
  }
  return tags;
}
