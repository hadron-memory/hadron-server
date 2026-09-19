/**
 * #1177 — reading a skill file back.
 *
 * Read with the same kind of YAML parser a host uses, so a header this reader
 * accepts is one the host accepts. A file with no frontmatter is an error; a
 * file with no provenance header parses with `source` empty — it is somebody
 * else's skill, and every skill operation leaves it alone.
 *
 * ## `parseFile` lives server-side, and that is a judgement call
 *
 * It is arguably I/O-adjacent. @Eli's recommendation, taken: the preamble
 * grammar makes it pure judgement — *is this preamble ours?* is precisely what
 * decides whether a foreign skill gets touched. If the client owned that, the
 * client would own "is this ours", which is the same inventing-a-class hazard
 * as the drift classes one level down.
 *
 * ## The invariant worth testing
 *
 * `splitPreamble` is the exact inverse of `render`. Test the ROUND TRIP, not
 * the two functions separately — a body that legitimately begins with the human
 * line, or with a whitespace-only line, must survive and stay hash-equal to its
 * own header.
 */

import { parse as parseYaml } from 'yaml';
import { normalizeBody, normalizeDescription } from './normalize.js';
import { HUMAN_LINE, LEGACY_HUMAN_LINE } from './render.js';

/** `---\n…\n---\n` framing. The header group is optional so an EMPTY block is
 *  still frontmatter — to the host, and therefore to the frontmatter rule. */
const FRONTMATTER_RE = /^---\n(?:([\s\S]*?)\n)?---\n?([\s\S]*)$/;
const MACHINE_RE = /^<!--\s*hadron-skill((?:\s+\w+=\S+)+)\s*-->$/;
const MACHINE_KV = /(\w+)=(\S+)/g;
const LEGACY_RE = /^<!--\s*Generated from\s+(\S+)\s*-->$/;
const HASH_RE = /^[0-9a-f]{16}$/;

/** What a skill file yields: the keys a host reads, its provenance, its body. */
export interface SkillFile {
  name: string;
  description: string;
  /** The flat-v2 source node URN as written, or '' when the file is not ours. */
  source: string;
  /** '' for a legacy (pre-#580) header, which carries a source and no hash. */
  hash: string;
  body: string;
  /**
   * Every frontmatter key other than name/description. `render` writes none, so
   * on a generated file a non-empty `extra` IS a local edit — one the header
   * hash cannot see, since the hash covers the three rendered inputs — and
   * status/export must treat it as `locally-edited` rather than overwrite it.
   */
  extra?: Record<string, unknown>;
}

export class SkillFileParseError extends Error {}

/**
 * Whether `tok` is a flat-v2 NODE URN — `hrn:node:<root>:<slug>:<loc>`.
 *
 * Provenance may only ever name a node in that form. A header naming another
 * entity kind, a legacy `::` spelling, or a bare id is not ours (@Holger,
 * 2026-09-16: no v1 on this surface).
 *
 * **This is the one place the otherwise-liberal URN handling does not apply,
 * and a port must not "fix" it toward liberality.** Being strict here is what
 * keeps a foreign file foreign: a `::` header is somebody else's provenance and
 * stays in their body rather than pairing their file to one of our nodes.
 */
export function isNodeUrn(tok: string): boolean {
  if (!tok.startsWith('hrn:node:') || tok.includes('::')) return false;
  // hrn:node:<root>:<slug>:<loc…> — at least one loc segment, none empty.
  const parts = tok.split(':');
  if (parts.length < 5) return false;
  return parts.every((p) => p.length > 0);
}

function machineHeader(line: string): { source: string; hash: string } | null {
  const m = MACHINE_RE.exec(line);
  if (!m) return null;
  let source = '';
  let h = '';
  for (const kv of m[1]!.matchAll(MACHINE_KV)) {
    if (kv[1] === 'source') source = kv[2]!;
    else if (kv[1] === 'hash') h = kv[2]!;
  }
  // Extra keys are allowed so a later host can add its own, but a line missing
  // either of ours — or carrying a source that is not a node URN, or a hash
  // that is not exactly 16 hex — is a comment that merely looks like one.
  if (!isNodeUrn(source) || !HASH_RE.test(h)) return null;
  return { source, hash: h };
}

function legacyHeader(line: string): string | null {
  const m = LEGACY_RE.exec(line);
  if (!m) return null;
  // The token must LOOK like a node URN: `<!-- Generated from a template -->`
  // is a body.
  return isNodeUrn(m[1]!) ? m[1]! : null;
}

/**
 * Divide what follows the frontmatter into the PREAMBLE — what `render` writes
 * before the body — and the body, normalized.
 *
 * Provenance is recognised in the preamble ONLY, and each kind of line at most
 * once, so a body that legitimately begins with the exact human line is body
 * and round-trips hash-equal to its header. Lines are read RAW: `render` never
 * indents, so an indented lookalike is body. Only truly EMPTY lines are skipped
 * as framing.
 */
function splitPreamble(rest: string): { preamble: string; body: string } {
  const lines = rest.split('\n');
  let i = 0;
  let sawMachine = false;
  let sawHuman = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === '') {
      // framing
    } else if (!sawMachine && (machineHeader(line) !== null || legacyHeader(line) !== null)) {
      sawMachine = true;
    } else if (sawMachine && !sawHuman && (line === HUMAN_LINE || line === LEGACY_HUMAN_LINE)) {
      // The human line is renderer preamble only AFTER a provenance line; a
      // foreign body that happens to start with it keeps it.
      sawHuman = true;
    } else {
      return { preamble: lines.slice(0, i).join('\n'), body: normalizeBody(lines.slice(i).join('\n')) };
    }
    i += 1;
  }
  return { preamble: lines.slice(0, i).join('\n'), body: '' };
}

/** Read a skill file. Throws `SkillFileParseError` when it is not one. */
export function parseFile(data: string): SkillFile {
  const text = data.replace(/\r\n/g, '\n');
  const m = FRONTMATTER_RE.exec(text);
  if (!m) throw new SkillFileParseError('no frontmatter');

  // Decode into a map first so a non-string name/description is REFUSED rather
  // than coerced: YAML would read `name: 123` as the number 123, and a hash
  // over a coerced rendering of it would not be the host's view of the file.
  let all: unknown;
  try {
    all = parseYaml(m[1] ?? '') ?? {};
  } catch (e) {
    throw new SkillFileParseError(`parsing frontmatter: ${(e as Error).message}`);
  }
  if (typeof all !== 'object' || all === null || Array.isArray(all)) {
    throw new SkillFileParseError('frontmatter is not a mapping');
  }

  const file: SkillFile = { name: '', description: '', source: '', hash: '', body: '' };
  for (const [k, v] of Object.entries(all as Record<string, unknown>)) {
    if (k === 'name' || k === 'description') {
      if (typeof v !== 'string') {
        throw new SkillFileParseError(`frontmatter ${k} is not a string (${typeof v})`);
      }
      if (k === 'name') file.name = v;
      else file.description = normalizeDescription(v);
    } else {
      // NULL-PROTOTYPE, and that is not style (@copilot, PR #1223). A plain
      // `{}` has a `__proto__` SETTER, so `extra['__proto__'] = v` mutates the
      // object's prototype instead of recording an own property — the key
      // vanishes, `extra` stays empty, and a file carrying it reads as
      // unedited. `extra` being non-empty is precisely what marks a local
      // edit, so the one frontmatter key with a JS footgun attached is the one
      // that would have slipped past the check meant to catch hand edits.
      //
      // Go has no such hazard — a map has no prototype — so this is a place the
      // port must do MORE than the reference to behave the same. The fixture
      // (`proto-frontmatter-key-is-extra`) carries Go's answer.
      file.extra ??= Object.create(null) as Record<string, unknown>;
      file.extra[k] = v;
    }
  }

  const { preamble, body } = splitPreamble(m[2] ?? '');
  for (const line of preamble.split('\n')) {
    const mh = machineHeader(line);
    if (mh) {
      file.source = mh.source;
      file.hash = mh.hash;
      break;
    }
    const lh = legacyHeader(line);
    if (lh) {
      file.source = lh;
      break;
    }
  }
  file.body = body;
  return file;
}
