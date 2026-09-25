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

/**
 * The charset a node id may carry in the provenance header (#1177 §4a).
 *
 * Defined HERE and imported by `render`, so the write path and the read path
 * cannot disagree about it (@copilot, PR #1234). Two copies would be two
 * predicates, and the asymmetry is the whole defect: a header `render` refuses
 * to write but `parseFile` accepts is a file that reads as ours while the host
 * shows injected text — `id=a-->` closes the comment early, so everything
 * after it is visible body, and this parser would still call the line a valid
 * machine header.
 *
 * Exported because `render` needs the identical rule, not a similar one.
 */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The charset a `source` URN may carry in the provenance header.
 *
 * The same allow-list `render` enforces on the write side (#1223). It lives
 * here with `SAFE_ID_RE` for the same reason: **read and write must accept the
 * same thing, or a hand-edited header is one this parser calls ours while the
 * host renders half of it as body.**
 *
 * `isNodeUrn` is not enough on its own — it checks STRUCTURE (the `hrn:node:`
 * shape and its segment count), not the characters. A loc containing `-->` is
 * structurally a URN, and #1224 established that such a loc is reachable: git
 * sync derives one from a file path and (before that fix) validated nothing.
 *
 * A DELIBERATE DIVERGENCE from the Go reference, which checks `isNodeURN` and
 * no charset — the same divergence `render` already took, now made symmetric
 * rather than left half-applied (@copilot, PR #1234).
 *
 * ONE definition, imported by `render`, for the reason this file already gives
 * for `SAFE_ID_RE`: two copies are two predicates. Round 2 of that same review
 * left a second copy in `render` — the drift I had just argued against, in the
 * commit that argued it.
 */
export const SAFE_SOURCE_RE = /^[A-Za-z0-9._:-]+$/;

/** What a skill file yields: the keys a host reads, its provenance, its body. */
export interface SkillFile {
  name: string;
  description: string;
  /** The flat-v2 source node URN as written, or '' when the file is not ours. */
  source: string;
  /** '' for a legacy (pre-#580) header, which carries a source and no hash. */
  hash: string;
  /**
   * The source node's stable ID, or '' on a header generation that predates it
   * (#1177 §4a).
   *
   * Pairing a file to a node by URN alone does not survive a `loc` rename: the
   * URN is COMPUTED from the loc, while `moveNode` keeps the node's id — so a
   * renamed node pairs as `orphaned` plus `never-exported`, and the user is
   * left with two directories carrying near-identical trigger text, both
   * firing. The id is what makes a move read as `renamed`.
   *
   * Both sides exist as of #1235: `render` writes this key and `hash` takes
   * the id as its FIRST input, matching hadron-cli (cli#650). It was read-only
   * for one release on purpose — writing an id without hashing it would let a
   * hand-edited id re-point a file at another node while the file still read
   * as untouched, so the write side had to wait for the Go reference to take
   * the hash change too.
   *
   * Still ABSENT from files on disk until `hadron skill export` ships
   * (hadron-cli#621) and an installation re-exports; a header without it stays
   * valid and pairs by URN.
   */
  id: string;
  /** Live source revision from a generated header; null on older headers. */
  revision: number | null;
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

/**
 * #1323 — the ONE rule for a `rev=` value, shared by render and parse so the
 * renderer can never write a header the parser voids (@copilot, PR #1339): a
 * positive integer that fits Node.revSeq's signed 32-bit column.
 */
export const MAX_SKILL_REVISION = 2_147_483_647;
export function isValidSkillRevision(revision: number): boolean {
  return Number.isSafeInteger(revision) && revision >= 1 && revision <= MAX_SKILL_REVISION;
}

function machineHeader(line: string): { source: string; hash: string; id: string; revision: number | null } | null {
  const m = MACHINE_RE.exec(line);
  if (!m) return null;
  let source = '';
  let h = '';
  let id = '';
  let revision: number | null = null;
  let rawRevision: string | null = null;
  for (const kv of m[1]!.matchAll(MACHINE_KV)) {
    if (kv[1] === 'source') source = kv[2]!;
    else if (kv[1] === 'hash') h = kv[2]!;
    else if (kv[1] === 'id') id = kv[2]!;
    else if (kv[1] === 'rev') rawRevision = kv[2]!;
  }
  // Extra keys are allowed so a later host can add its own, but a line missing
  // either of ours — or carrying a source that is not a node URN, or a hash
  // that is not exactly 16 hex — is a comment that merely looks like one.
  if (!isNodeUrn(source) || !SAFE_SOURCE_RE.test(source) || !HASH_RE.test(h)) return null;
  // An ABSENT id is fine — a header generation that predates it is still ours
  // and can pair by source. The export planner preserves that file unless its
  // one-invocation force override is explicit. A PRESENT id that could not
  // have been written by `render` is a different thing entirely: the line has
  // been hand-edited, and an id like `a-->` closes the comment so the remainder
  // is agent-visible text. Read and write share one allow-list, so the parser
  // cannot accept a header the renderer forbids.
  if (id !== '' && !SAFE_ID_RE.test(id)) return null;
  if (rawRevision !== null) {
    if (!/^[1-9]\d*$/.test(rawRevision)) return null;
    revision = Number(rawRevision);
    if (!isValidSkillRevision(revision)) return null;
  }
  return { source, hash: h, id, revision };
}

function legacyHeader(line: string): string | null {
  // The charset applies here too: the legacy generation is still a one-line
  // comment, and a source that closes it early is no more acceptable for
  // carrying an older header shape.
  const m = LEGACY_RE.exec(line);
  if (!m) return null;
  // The token must LOOK like a node URN: `<!-- Generated from a template -->`
  // is a body.
  return isNodeUrn(m[1]!) && SAFE_SOURCE_RE.test(m[1]!) ? m[1]! : null;
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

  const file: SkillFile = { name: '', description: '', source: '', hash: '', id: '', revision: null, body: '' };
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
      file.id = mh.id;
      file.revision = mh.revision;
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
