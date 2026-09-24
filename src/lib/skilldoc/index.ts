/**
 * #1177 — the skill domain, ported from hadron-cli's `internal/skilldoc`.
 *
 * Client does I/O and rendering; the server does judgment. This package is the
 * judgment half: name validation, normalization, the provenance hash, the file
 * codec. It has no I/O and no knowledge of where a file lives.
 *
 * D12 retired name DERIVATION (and the org prefix it needed): a skill's name is
 * stored at `properties.exports.<host>.name`, so this package validates a name
 * rather than composing one.
 *
 * Ported so far: the codec (§7 steps 1-2), the corpus lint (§6) and the drift
 * classes (§5). The SEAM — a GraphQL surface over these — is the remainder and
 * is tracked on #1177.
 */

export { goTrimSpace, normalizeBody, normalizeDescription, runeCount } from './normalize.js';
export { MAX_DESCRIPTION_LEN, MAX_NAME_LEN, validName } from './name.js';
export { hash } from './hash.js';
export { mergePatch, mergePropertiesPatch } from './exportsMerge.js';
export {
  HOST_CODEX_SKILL,
  requireSkillHost,
  SKILL_HOSTS,
  skillHost,
  type SkillHost,
} from './hosts.js';
export { HUMAN_LINE, LEGACY_HUMAN_LINE, render, SkillRenderError } from './render.js';
export { isNodeUrn, parseFile, SkillFileParseError, type SkillFile } from './parse.js';
export {
  classifyDeclaration,
  declaredSkill,
  EXPORTS_KEY,
  HOST_CLAUDE_SKILL,
  isEnabled,
  legacyAliasPaths,
  LEGACY_TOP_LEVEL_KEYS,
  malformedDeclarationPaths,
  storedName,
  unknownHostKeys,
  type Declaration,
} from './declaration.js';
export {
  classifySkill,
  pairFileToNode,
  type Classification,
  type DriftClass,
  type FileFacts,
  type NodeFacts,
} from './classify.js';
export {
  lintCollisions,
  lintNode,
  lintUnknownHostKeys,
  RULE_UNKNOWN_HOST_KEY,
  unknownHostKeyFinding,
  unknownHostKeysOmittedFinding,
  type Finding,
  type Severity,
  type SkillNode,
} from './lint.js';
