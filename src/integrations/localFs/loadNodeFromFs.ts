import { readFileSync, existsSync } from 'fs';
import { validateNodeDataExtractionSpecs } from '../../lib/edge-conditions/reserved-names.js';
import { governedSignalsFromMirror } from '../../lib/governedSignals.js';
import { join, relative, sep, basename, dirname } from 'path';
import { parse } from 'yaml';
import type { Node } from '../../index.d.js';
import { NodeAbstractTooLongError } from '../../lib/entityRef/errors.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { InvalidLocError, validateLoc } from '../../lib/validateLoc.js';

/**
 * A mirror file whose path cannot be a loc (#1224).
 *
 * Carries the file's frontmatter id because the caller needs it: a skipped
 * file is absent from the loaded graph, and `syncGraphFromGithub`'s cleanup
 * pass hard-deletes every git-owned row it did not upsert — so without the
 * id, skipping a file would DELETE the node it used to be. Renaming a file
 * to an invalid name would convert a move into data loss.
 *
 * Carries the `source` path too, because the id is not always enough: a file
 * with no frontmatter id, or one whose id names no row in this memory, cannot
 * be matched to the row it came from at all (its OLD loc is what would
 * identify it, and a file renamed to an unusable name no longer tells us what
 * that was). The sync refuses to run its destructive pass in that case, and
 * the operator needs the file NAME to fix it — an id they cannot grep for is
 * not an actionable report.
 */
export class InvalidNodeLocError extends Error {
  constructor(
    message: string,
    readonly nodeId: string | undefined,
    readonly source: string,
  ) {
    super(message);
    this.name = 'InvalidNodeLocError';
  }
}

interface NodeYaml {
  id: string;
  name: string;
  urn?: string;
  type?: string;
  data?: unknown;
  /** YAML may carry any scalar here; only a non-blank string is read (#1348). */
  objectType?: unknown;
  description?: string;
  /** Paragraph-length summary. Spec 031. Distinct from `description`. */
  abstract?: string;
  /**
   * Spec 032 — fingerprint of `content` at the time `abstract` was
   * authored. Present in YAML round-trip from a hadron-server export;
   * may be absent in YAML authored by hand (importer recomputes from
   * `content` in that case). Defensive: non-string values fall through
   * to recompute.
   */
  abstractOriginHash?: string;
  /**
   * Legacy alias historically read into `description` when no
   * `description` key existed. Predates the spec-031 `abstract` field
   * and remains for back-compat. New writers use `abstract` for paragraph
   * summaries and `description` for one-line headlines.
   */
  summary?: string;
  /**
   * #1218 — the governed signals, round-tripping through the mirror so a
   * memory rebuilt from its repo does not arrive ungoverned (#1205). `runnable`
   * matches the key the edge codec already uses; `isRunnable` is accepted as
   * the legacy spelling for the same reason edges accept it.
   *
   * ABSENCE IS NOT `null` HERE. Every other optional field on this interface is
   * read as `meta.x ?? null`, which is right for them and catastrophic for
   * these two: no file already on disk carries either key, so coercing absent
   * to null would clear the column on the next sync of every mirrored memory —
   * un-governing on a schedule, introduced by the fix for it. They are routed
   * through `governedSignalsFromMirror`, which omits an absent key so the
   * stored value is preserved.
   */
  role?: string | null;
  runnable?: boolean | null;
  isRunnable?: boolean | null;
  /** An untrusted mirror claim, validated against the destination by Git sync. */
  placeholder?: unknown;
  tags?: string[];
  nodes?: Array<{ id: string; rel: string; loc?: string }>;
  alias?: string;
  author?: string;
  contentHash?: string;
}

/** #2556: omitted keys preserve stored values; explicit JSON null clears data. */
function typedPayloadFromMeta(meta: NodeYaml): Pick<Partial<Node>, 'nodeType' | 'data'> {
  const result: Pick<Partial<Node>, 'nodeType' | 'data'> = {};
  // Gate6434957685: blank/foreign values are absent; link is the legacy isLink marker.
  if (typeof meta.type === 'string' && meta.type.trim() !== '' && meta.type !== 'link') {
    // cor:dmo:020:04: all other words are open vocabulary, retained exactly.
    result.nodeType = meta.type;
  }
  if ('data' in meta) {
    const active = new Set<object>();
    const check = (value: unknown): void => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (typeof value !== 'object' || value === null || active.has(value)
        || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new Error('Node data must be finite, acyclic JSON');
      }
      active.add(value);
      for (const child of Object.values(value)) check(child);
      active.delete(value);
    };
    check(meta.data);
    // Import is a write surface: share the API's reserved extraction namespace gate.
    const extraction = validateNodeDataExtractionSpecs(meta.data);
    if (!extraction.ok) throw new Error(extraction.error.message);
    result.data = meta.data as Node['data'];
  }
  return result;
}

function placeholderFromMeta(meta: NodeYaml, source: string): { isPlaceholder: true } | Record<string, never> {
  if (meta.placeholder === true) return { isPlaceholder: true };
  if (meta.placeholder != null && meta.placeholder !== false) {
    console.warn(`[loadNodeFromFs] ignored non-boolean placeholder marker in ${source}`);
  }
  return {};
}

/**
 * Spec 032 FR-013 — reconcile the YAML's `abstractOriginHash` against
 * the hash computed from imported content.
 *
 * Trust model: the YAML producer is in the trust boundary (the importer
 * is a privileged sync surface), so when the YAML carries a hash that
 * disagrees with the recomputed value we accept the YAML value and emit
 * a warning. This preserves round-trip integrity of legitimately-stale
 * exports while surfacing tampering observability in the sync log.
 *
 * Per FR-006 parallel: if there is no abstract, there is no hash —
 * regardless of what the YAML says.
 *
 * Defensive type handling: only a string-shaped YAML value is considered
 * for the round-trip path. Missing key, null, object, number, boolean
 * all fall through to "recompute from content" (same defensive pattern
 * as spec 031's `normalizeImportedAbstract` object-rejection).
 *
 * Deliberate choice — non-string falls through SILENTLY rather than
 * emitting the mismatch-warning. Rationale: a non-string value cannot
 * have come from a hadron-server export (we only ever write string or
 * omit), so the failure mode is "human or third-party YAML producer
 * mis-typed the key" — which is structurally indistinguishable from
 * "key missing" rather than from "tampering with a real hash." Treating
 * both as "no usable hash, fall back to first-time-import semantics"
 * keeps the warning channel focused on the case that actually matters:
 * a producer that supplied a string-shaped hash disagreeing with the
 * computed value (PR-209 review note #4).
 */
function reconcileAbstractOriginHash(
  normalizedAbstract: string | null,
  content: string | null,
  yamlHash: unknown,
  loc: string,
): string | null {
  if (normalizedAbstract === null) {
    return null;
  }
  const computed = computeContentHash(content);
  if (typeof yamlHash !== 'string') {
    return computed;
  }
  if (yamlHash === computed) {
    return yamlHash;
  }
  console.warn(
    `[loadNodeFromFs] abstractOriginHash mismatch for loc=${loc}: ` +
      `YAML claims ${yamlHash}, computed ${computed}. Accepting YAML ` +
      `value (FR-013 round-trip preservation); possible tampering ` +
      `or legitimate exported-stale state.`,
  );
  return yamlHash;
}

/**
 * Length cap + trim-then-check normalization for the imported abstract.
 * Mirrors the resolver + MCP write paths so import → export → re-import
 * is byte-identical for the persisted value.
 *
 * Per FR-008: the 2000-char cap applies at every write surface, including
 * import. Over-cap YAML values throw `NodeAbstractTooLongError`; the sync
 * envelope catches and reports per the existing per-node try/catch in
 * loadGraphFromFs (errors don't poison the whole import — the bad node
 * is skipped with a warning).
 *
 * Per FR-009 (extended PR-196): trim-then-check normalizes empty and
 * whitespace-only values to null; non-empty trimmed values persist
 * untrimmed so intentional surrounding whitespace on real paragraphs is
 * lossless.
 *
 * Defensive type handling: the `yaml` package's `parse` is loose about
 * types. Scalar non-strings (number, boolean) get coerced via `String()`
 * so `.trim()` doesn't blow up. Objects and arrays — which would yield
 * "[object Object]" / "1,2,3" via `String()` and silently persist as the
 * node's abstract — are rejected as `null` instead. PR-201 round-2
 * surfaced the object/array gap.
 */
function normalizeImportedAbstract(raw: unknown): string | null {
  if (raw == null) return null;
  // Objects and arrays would yield "[object Object]" / a comma-joined
  // string via String() — silently persisting garbage. Treat them as
  // "no usable abstract" (same as null/empty). A future spec that
  // formally rejects malformed input with a typed error could wrap
  // this in InvalidAbstractTypeError; today's choice matches the
  // empty-string handling and keeps the bad-input failure mode quiet.
  if (typeof raw === 'object') return null;
  const str = String(raw);
  if (str.length > 2000) {
    throw new NodeAbstractTooLongError(str.length);
  }
  if (str.trim() === '') return null;
  return str;
}

/**
 * #1218 — read the governed signals off parsed frontmatter.
 *
 * Selects the canonical `runnable` over the legacy `isRunnable` by KEY
 * PRESENCE, never by `??` (@codex P2, PR #1221). `meta.runnable ?? meta.isRunnable`
 * reads an explicit `runnable: null` — the documented way to clear the signal —
 * as ABSENT, falls through to the legacy key, and when that is missing too
 * omits the update entirely, so a stored `isRunnable: true` survives a file
 * that explicitly asked to clear it. Nullish coalescing cannot express
 * "present and deliberately null", which is precisely the case this codec has
 * to carry.
 */
function governedSignalsFromMeta(meta: NodeYaml): Partial<{ role: string | null; isRunnable: boolean | null }> {
  const runnable = 'runnable' in meta ? meta.runnable : 'isRunnable' in meta ? meta.isRunnable : undefined;
  return governedSignalsFromMirror({
    ...('role' in meta ? { role: meta.role } : {}),
    ...(runnable !== undefined || 'runnable' in meta || 'isRunnable' in meta
      ? { isRunnable: runnable ?? null }
      : {}),
  });
}

/**
 * #1348 — read the collection discriminator off parsed frontmatter, keeping
 * PRESENCE (cor:int:020:01: absent means no opinion — default on create,
 * preserve on update, never clear).
 *
 * For `objectType` a FILE never clears it: absent, null, "" and whitespace
 * are all no opinion, exactly as CLI import reads them (hadron-cli#725 —
 * `strings.TrimSpace(v) != ""`); the clear is an explicit node update. So only
 * a non-blank string yields the key, written as-is. The previous
 * `meta.objectType ?? null` collapsed every one of those into `null`, which
 * was harmless only because git sync never wrote the column — wiring it in
 * as-is would have cleared a stored collection on every sync of every file
 * written before #725.
 */
function objectTypeFromMeta(meta: NodeYaml): { objectType?: string } {
  const v = meta.objectType;
  return typeof v === 'string' && v.trim() !== '' ? { objectType: v } : {};
}

interface EdgeEntry {
  /** Either `target` or `id` identifies the target node. */
  target?: string;
  /** Relationship name. The on-disk key stays `rel` for back-compat (it was
   * never literally "label"); read into `Edge.name`. */
  rel: string;
  id?: string;
  /** Edge description (spec 037). */
  description?: string;
  /** Edge JSON metadata, preserved on a fresh import. */
  data?: unknown;
  /** Whether the edge is runnable (spec 037). The CLI export (and the server's
   *  current writer) emit `runnable`; `isRunnable` is the legacy key still on
   *  already-pushed mirrors — `normalizeEdgeEntry` reads `runnable` first. */
  runnable?: boolean;
  isRunnable?: boolean;
  /** The edge's own loc (spec 037), written by the export as `edgeLoc`. Carried
   *  for readability; not consumed on git-import today. */
  edgeLoc?: string;
  /**
   * JSONLogic gating expression. Null/undefined means the edge always
   * fires. The server validates the shape on import (no separate
   * portability check at load time — invalid conditions are rejected
   * when the import path persists them).
   */
  condition?: unknown;
  /** Edge resolution-order hook (lower fires first). Default 0. */
  priority?: number;
  [key: string]: unknown;
}

/**
 * Load a single node from the filesystem.
 *
 * Supports two formats:
 * 1. **Legacy**: directory with `.node/node.yaml` + `.node/topic.md`
 * 2. **Frontmatter**: a single `.md` file with YAML frontmatter + optional `.name/edges.yaml` sidecar
 *
 * @param source    Absolute path to either the directory (legacy) or the .md file (frontmatter)
 * @param graphRoot Absolute path to the graph root (for deriving loc)
 * @param ownerRepo GitHub repo slug, e.g. "micromentor/mmdata"
 */
export interface LoadedEdge {
  targetId: string;
  /** Relationship name (was `label`). */
  name: string | null;
  description?: string | null;
  data?: unknown;
  isRunnable?: boolean | null;
  condition?: unknown;
  priority?: number;
}

export const loadNodeFromFs = async (
  source: string,
  graphRoot: string,
  ownerRepo: string,
  memoryUrn?: string,
): Promise<{ node: Partial<Node>; edges: Array<LoadedEdge>; metadataIsMapping: boolean }> => {
  if (source.endsWith('.md')) {
    return loadFrontmatterNode(source, graphRoot, ownerRepo, memoryUrn);
  }
  return loadLegacyNode(source, graphRoot, ownerRepo, memoryUrn);
};

/** ASCII whitespace only, so the CLI's Go parser can apply the identical set (#2391). */
const ASCII_WHITESPACE_ONLY = /^[ \t\n\r\v\f]*$/;

/**
 * #2391 (hrn:node:hadronmemory.com:specs:cor:int:020:01, F1): the node content of
 * a frontmatter file's body, i.e. the text after the closing `---` line. The
 * writers (`pushMemoryToGit`, `writeNodeFile`, `nodeExport`) frame content as
 * `\n<content>\n`, so this removes ONE leading `\n` and ONE trailing `\n` if
 * present and nothing else. Authored boundary whitespace survives, and a
 * written file reads back as the stored text (approval hash unchanged,
 * cor:dmo:120:01). A body left empty or ASCII-whitespace-only is null (Holger,
 * 2026-10-26). Expects CRLF already normalized. Shared cases with hadron-cli#945:
 * `markdownBodyFraming.fixture.json`.
 */
export function markdownBodyContent(body: string): string | null {
  let content = body.startsWith('\n') ? body.slice(1) : body;
  if (content.endsWith('\n')) content = content.slice(0, -1);
  return ASCII_WHITESPACE_ONLY.test(content) ? null : content;
}

/**
 * Load a frontmatter markdown node (Obsidian vault format).
 */
async function loadFrontmatterNode(
  mdPath: string,
  graphRoot: string,
  ownerRepo: string,
  memoryUrn?: string,
): Promise<{ node: Partial<Node>; edges: Array<LoadedEdge>; metadataIsMapping: boolean }> {
  // Normalize CRLF to LF before splitting (#280). The LF-only split used to
  // reject a CRLF file (a Windows author, or git core.autocrlf on the clone
  // host), which drops the node from the loaded graph. Normalizing the whole
  // file, body included, rather than only tolerating CRLF in the delimiters is
  // what the CLI's ParseMarkdown does (hadron-cli internal/nodedoc), so one
  // file imports as the same node through either surface (cor:int:020:01). It
  // also means a checkout that flips a file's line endings does not rewrite the
  // stored content on the next sync.
  const raw = readFileSync(mdPath, 'utf-8').replace(/\r\n/g, '\n');

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error(`No frontmatter found in ${mdPath}`);

  const meta = parseNodeYaml(fmMatch[1], `frontmatter in ${mdPath}`);
  const content = markdownBodyContent(fmMatch[2] ?? '');
  const loc = deriveValidatedLoc(mdPath, graphRoot, true, meta.id, memoryUrn);

  // Sidecar edges take precedence over frontmatter `nodes:` array
  const sidecarEdges = loadSidecarEdges(mdPath);
  const fmEdges = (meta.nodes ?? [])
    .filter((e) => !!e.id)
    .map((e) => normalizeEdgeEntry(e));
  const edges = sidecarEdges.length > 0 ? sidecarEdges : fmEdges;

  const abstract = normalizeImportedAbstract(meta.abstract);
  const abstractOriginHash = reconcileAbstractOriginHash(
    abstract,
    content,
    meta.abstractOriginHash,
    loc,
  );

  return {
    metadataIsMapping: isYamlMapping(meta),
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      isLink: meta.type === 'link',
      ...typedPayloadFromMeta(meta),
      // #725 / #1348 — spread, NOT `?? null`: see objectTypeFromMeta.
      ...objectTypeFromMeta(meta),
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
      abstract,
      abstractOriginHash,
      content,
      contentHash: meta.contentHash ?? null,
      tags: meta.tags ?? [],
      ownerRepo,
      // #1218 — spread, NOT `?? null`: an absent key must stay absent so the
      // sync update preserves the stored value. See the NodeYaml doc above.
      ...governedSignalsFromMeta(meta),
      ...placeholderFromMeta(meta, mdPath),
    },
    edges,
  };
}

/**
 * Load a legacy node (directory with .node/node.yaml + topic.md).
 */
async function loadLegacyNode(
  dirPath: string,
  graphRoot: string,
  ownerRepo: string,
  memoryUrn?: string,
): Promise<{ node: Partial<Node>; edges: Array<LoadedEdge>; metadataIsMapping: boolean }> {
  const yamlPath = join(dirPath, '.node', 'node.yaml');
  const mdPath = join(dirPath, '.node', 'topic.md');

  const meta = parseNodeYaml(readFileSync(yamlPath, 'utf-8'), `node.yaml in ${yamlPath}`);
  const content = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : null;
  // The LEGACY layout derives its loc the same way and needs the same guard —
  // handling only the frontmatter loader would leave the older of the two
  // formats as the unguarded writer, which is this issue's own shape (#1221
  // hit exactly that with the governed signals).
  const loc = deriveValidatedLoc(dirPath, graphRoot, false, meta.id, memoryUrn);

  const edges = (meta.nodes ?? [])
    .filter((e) => !!e.id)
    .map((e) => normalizeEdgeEntry(e));

  const abstract = normalizeImportedAbstract(meta.abstract);
  const normalizedContent = content?.trim() ?? null;
  const abstractOriginHash = reconcileAbstractOriginHash(
    abstract,
    normalizedContent,
    meta.abstractOriginHash,
    loc,
  );

  return {
    metadataIsMapping: isYamlMapping(meta),
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      isLink: meta.type === 'link',
      ...typedPayloadFromMeta(meta),
      // #725 / #1348 — spread, NOT `?? null`: see objectTypeFromMeta.
      ...objectTypeFromMeta(meta),
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
      abstract,
      abstractOriginHash,
      content: normalizedContent,
      contentHash: meta.contentHash ?? null,
      tags: meta.tags ?? [],
      ownerRepo,
      // #1218 — the LEGACY layout round-trips the signals too (@copilot, PR
      // #1221). `loadNodeFromFs` still accepts `.node/node.yaml`, so handling
      // this only in the frontmatter loader would rebuild a legacy-layout
      // memory ungoverned — the same defect, reachable through the older of
      // the two formats. Same reader, same absent-means-preserve rule.
      ...governedSignalsFromMeta(meta),
      ...placeholderFromMeta(meta, yamlPath),
    },
    edges,
  };
}

/** #280: tagged YAML collections are accepted partial nodes, not mappings. */
function isYamlMapping(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Parse a node's metadata YAML, refusing only the roots that already failed to
 * load before #280, with an error that names the file.
 *
 * This is a MESSAGE improvement, not a mapping guarantee. `parse()` returns
 * `null` for empty input (or a comment only) and a primitive for a bare value.
 * Both already failed further down the loader with a bare TypeError: `meta.id`
 * on `null`, and the `in` check in `governedSignalsFromMeta` on a primitive.
 * Syntax errors already threw too. Here each fails as `Malformed <what>: …`
 * instead, so the operator can see which file it was.
 *
 * Every other object root still loads exactly as before. That includes an
 * array, and a tagged non-mapping (`!!set`, `!!omap`, `!!binary`, which parse
 * to a Set, Map and Buffer). Each loads as a node with no id and no name. That
 * is deliberate. When a file fails to load, git sync drops it, and its
 * repo-wins cleanup pass then hard-deletes the row the file used to mirror
 * (`syncGraphFromGithub`). A partial load updates the row in place, so the row
 * survives. Refusing these shapes here would turn a malformed edit into a
 * deleted node (PR #1432 review, P1). Enforce a mapping root only once sync
 * keeps the row of a file it refuses (Hadron finding
 * `hadron-server:findings:git-sync-attestation-must-fail-in-transaction`).
 *
 * @param what Names the input in the error, e.g. `frontmatter in /path/a.md`.
 * @throws {Error} `Malformed <what>: …` when the YAML is invalid, empty, or a
 *   primitive.
 */
function parseNodeYaml(text: string, what: string): NodeYaml & { nodes?: EdgeEntry[] } {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    throw new Error(`Malformed ${what}: ${(err as Error).message}`);
  }
  if (parsed == null) throw new Error(`Malformed ${what}: expected a YAML mapping, got empty`);
  if (typeof parsed !== 'object') {
    throw new Error(`Malformed ${what}: expected a YAML mapping, got a ${typeof parsed}`);
  }
  return parsed as NodeYaml & { nodes?: EdgeEntry[] };
}

/**
 * Derive a loc from a path and hold it to the SAME charset every API writer
 * enforces (#1224).
 *
 * This is the mirror's only loc-derivation point — both layouts route through
 * it — so validating here makes a new loader opt OUT rather than remember to
 * opt in. That is the fix the issue asks for: the guard used to sit with the
 * writers somebody enumerated, and the writer nobody enumerated did without.
 *
 * The root uses the memory slug (#1228, cor:int:010:01), with no empty-loc
 * exemption. Root identity errors abort the graph load, never skip a file
 * before destructive repo-wins cleanup.
 */
function deriveValidatedLoc(
  path: string,
  graphRoot: string,
  isMdFile: boolean,
  fileId: string | undefined,
  memoryUrn?: string,
): string {
  const loc = deriveLoc(path, graphRoot, isMdFile, memoryUrn);
  try {
    validateLoc(loc);
  } catch (err) {
    if (err instanceof InvalidLocError) {
      throw new InvalidNodeLocError(
        `Path does not derive a valid loc: ${err.message} (${path})`,
        fileId,
        path,
      );
    }
    throw err;
  }
  return loc;
}

/**
 * The loc a node source occupies, from its PATH alone: no parsing, no
 * validation (#1568). A file that cannot be read still sits at this address,
 * so Git sync uses it to tell whether an unreadable file is hiding an existing
 * node, which repo-wins cleanup would otherwise hard-delete.
 */
export function locForNodeSource(source: string, graphRoot: string, memoryUrn?: string): string {
  return deriveLoc(source, graphRoot, source.endsWith('.md'), memoryUrn);
}

/**
 * Derive a colon-delimited loc from a file/directory path relative to graphRoot.
 */
function deriveLoc(path: string, graphRoot: string, isMdFile: boolean, memoryUrn?: string): string {
  let relPath: string;

  if (isMdFile) {
    const fileName = basename(path, '.md');
    const dir = relative(graphRoot, dirname(path));
    if (fileName === 'README') {
      relPath = dir; // server/README.md → "server"
    } else {
      relPath = dir ? join(dir, fileName) : fileName; // architecture.md → "architecture"
    }
  } else {
    relPath = relative(graphRoot, path);
  }

  // Strip .hadron/ prefix
  if (relPath === '.hadron') {
    relPath = '';
  } else if (relPath.startsWith('.hadron' + sep)) {
    relPath = relPath.slice('.hadron'.length + 1);
  }

  return relPath === '' ? rootLocForMemory(memoryUrn) : relPath.split(sep).join(':');
}

/** A root identity failure must refuse the graph, not feed repo-wins cleanup. */
export class InvalidRootMemoryError extends Error {}

/**
 * The root README represents its memory (cor:int:010:01 / cor:urn:010:01).
 * Unlike ordinary path locs this depends on the memory's slug: renaming the
 * memory moves the root again on its next id-first sync, including edge locs.
 * Compound legacy identities refuse rather than guess a single slug (#1228).
 */
export function rootLocForMemory(memoryUrn: string | undefined): string {
  const bare = memoryUrn?.replace(/^(?:hrn|urn):(?:mem|memory):/, '').replace(/::/g, ':');
  const atoms = bare?.split(':');
  if (!atoms || atoms.length !== 2 || !atoms[0] || !atoms[1]) {
    throw new InvalidRootMemoryError('Git root README requires a single-atom memory slug.');
  }
  try { validateLoc(atoms[1]); } catch (err) {
    if (!(err instanceof InvalidLocError)) throw err;
    throw new InvalidRootMemoryError('Git root README requires a single-atom memory slug.');
  }
  return atoms[1];
}

/**
 * Load edges from a dot-dir sidecar `edges.yaml`.
 *
 * architecture.md → .architecture/edges.yaml
 * server/README.md → .server/edges.yaml
 */
function loadSidecarEdges(mdPath: string): Array<LoadedEdge> {
  const fileName = basename(mdPath, '.md');
  const dir = dirname(mdPath);

  const sidecarDir = fileName === 'README'
    ? join(dirname(dir), '.' + basename(dir))   // server/README.md → .server/
    : join(dir, '.' + fileName);                 // architecture.md → .architecture/

  const edgesPath = join(sidecarDir, 'edges.yaml');
  if (!existsSync(edgesPath)) return [];

  const entries = parse(readFileSync(edgesPath, 'utf-8')) as EdgeEntry[];
  if (!Array.isArray(entries)) return [];

  return entries
    .filter((e) => e.rel)
    .map((e) => normalizeEdgeEntry(e));
}

/**
 * Normalize a YAML edge entry into the LoadedEdge shape, preserving
 * `condition` (JSONLogic JSON) and `priority` when present so that
 * memories can round-trip through the on-disk format losslessly per
 * Invariant 10 (memory portability).
 */
function normalizeEdgeEntry(e: EdgeEntry): LoadedEdge {
  const out: LoadedEdge = {
    targetId: (e.id ?? e.target) as string,
    name: e.rel ?? null,
  };
  if (typeof e.description === 'string') {
    out.description = e.description;
  }
  if (e.data != null) {
    out.data = e.data;
  }
  // `runnable` is the canonical key (matches the CLI export); fall back to the
  // legacy `isRunnable` for edges in already-pushed git mirrors.
  if (typeof e.runnable === 'boolean') {
    out.isRunnable = e.runnable;
  } else if (typeof e.isRunnable === 'boolean') {
    out.isRunnable = e.isRunnable;
  }
  if (e.condition !== undefined && e.condition !== null) {
    out.condition = e.condition;
  }
  if (typeof e.priority === 'number') {
    out.priority = e.priority;
  }
  return out;
}
