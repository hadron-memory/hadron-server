/**
 * #1177 — the skill domain, ported from hadron-cli's `internal/skilldoc`.
 *
 * Client does I/O and rendering; the server does judgment. This package is the
 * judgment half: derivation, normalization, the provenance hash, the file
 * codec. It has no I/O and no knowledge of where a file lives.
 *
 * Ported so far (§7 steps 1-2). `lint`, `Classify` and the seam are the
 * remainder and are tracked on #1177.
 */

export { goTrimSpace, normalizeBody, normalizeDescription, runeCount } from './normalize.js';
export {
  DEFAULT_PREFIX, MAX_DESCRIPTION_LEN, MAX_NAME_LEN,
  deriveName, validName, validPrefix, type Prefix,
} from './derive.js';
export { hash } from './hash.js';
export { HUMAN_LINE, LEGACY_HUMAN_LINE, render, SkillRenderError } from './render.js';
export { isNodeUrn, parseFile, SkillFileParseError, type SkillFile } from './parse.js';
