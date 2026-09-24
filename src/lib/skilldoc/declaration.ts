/**
 * #1177 §5 / D12 — reading a node's per-host export DECLARATION.
 *
 * A declaration is a node's opt-in to being exported as a skill for ONE host:
 * an object at `properties.exports.<host>` carrying `{name, description,
 * enable}`. Keying by host makes "one export per host" structural, and keeps
 * discovery a key check rather than a containment match.
 *
 * Ported from `internal/skilldoc` in hadron-cli (`classify` / `Declared` /
 * `Malformed`). The Go side stays the reference while both exist: a divergence
 * here does not read as a bug, it reads as the two sides disagreeing about
 * which nodes are declared at all.
 *
 * ## Where TypeScript needs MORE code than Go to behave the SAME
 *
 * Go's `v.(map[string]any)` type assertion answers "is this a JSON object".
 * The naive TS equivalent — `typeof v === 'object' && v !== null` — is TRUE
 * for an **array**, so `"exports": []` would be read as a valid (empty)
 * host map instead of being reported malformed. `isPlainObject` below exists
 * for that one divergence, and the same class caught `__proto__` on PR #1223:
 * ask not only "does TS do what Go does" but "does TS do something Go cannot".
 *
 * Own-key checks use `hasOwnProperty`, never `in`: `'constructor' in {}` is
 * true, so `in` would read an inherited member as a present field and report a
 * node malformed for a key its author never wrote.
 */
import { goTrimSpace } from './normalize.js';

/** The property holding a node's per-host export declarations (D12). */
export const EXPORTS_KEY = 'exports';

/**
 * The hosts live in `hosts.ts` (#1254): one row per host, carrying its limits
 * and whether the retired top-level keys alias to it. Every `exports.<host>`
 * entry is shape-checked here whatever its host; which one BECOMES the
 * declaration is the caller's `host` argument.
 */
import { HOST_CLAUDE_SKILL, requireSkillHost, skillHost } from './hosts.js';
export { HOST_CLAUDE_SKILL };

/**
 * The pre-D12 declaration properties, read as aliases for
 * `exports.claudeSkill` so nothing has to be migrated (@Holger, 2026-09-19:
 * there is no data migration).
 *
 * ONE list, read by ONE scan, so a key added later cannot be recognised by the
 * declaration reader and missed by the malformed check.
 */
export const LEGACY_TOP_LEVEL_KEYS = ['skill', 'claudeSkill'] as const;

/** A node's opt-in to export for one host. */
export interface Declaration {
  /** The property PATH it was found at, so a message can name what the author wrote. */
  key: string;
  host: string;
  description: string;
  /**
   * AUTHORITATIVE since D12: the name is stored, not derived, so there is no
   * value to fall back to and a missing one is a finding rather than a default.
   */
  name: string;
  /**
   * Whether a `name` key was PRESENT, so an explicitly empty stored name is
   * judged rather than read as absent (Copilot on cli#589 round 2 — the rule
   * it was found on is retired, the trap is not).
   */
  nameSet: boolean;
  /**
   * The per-host on/off switch. **Defaults to OFF** (@Holger, 2026-09-19):
   * publishing is the side-effecting act, so it takes an explicit
   * `enable: true`. The corpus holds many runnable nodes that are automation
   * and were never meant to be skills, so the safe default is the one where
   * nothing ships unless somebody said to ship it.
   */
  enable: boolean;
  /** Whether the key was present — lets a report distinguish "switched off"
   *  from "never switched on". Reporting detail; it gates nothing. */
  enableSet: boolean;
}

/** A JSON object, excluding the two shapes `typeof x === 'object'` also admits. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Go's `sort.Strings` order — UTF-8 BYTES, not JavaScript's UTF-16 code units
 * (@copilot, PR #1233).
 *
 * The two disagree, and oppositely: an astral character encodes to a surrogate
 * pair starting 0xD800, so it sorts BEFORE U+E000 under UTF-16 and AFTER it
 * under UTF-8. Host keys are arbitrary strings out of a JSON column and every
 * one of them is shape-checked, so the malformed list is exactly where an
 * exotic key shows up — the one place this order is observable.
 */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Own-property presence — `in` would find inherited members. */
function own(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * The own value at `key`, or `undefined` when the key is inherited or absent.
 *
 * Both halves are load-bearing, and the second one was a real defect in the
 * first draft of this file: checking presence with `hasOwnProperty` and then
 * reading with `obj[key]` still READS THROUGH THE PROTOTYPE, so an inherited
 * `description` was picked up as the declaration's. Go's map lookup has no
 * such path. Presence and value must come from the same place.
 */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return own(obj, key) ? obj[key] : undefined;
}

/**
 * The ONE scan of a node's declaration properties.
 *
 * Returns the declaration for `host` (default `claudeSkill`), and every property PATH
 * that is present but of the wrong shape.
 *
 * **Precedence:** `exports.claudeSkill` wins over the retired top-level
 * `skill`, which wins over `claudeSkill` — so a node given the new shape
 * behaves as migrated even with an alias left beside it.
 *
 * **Malformed** covers `exports` not being an object, a host entry not being
 * an object, a non-string `description`/`name`, and a non-boolean `enable`. A
 * malformed path is reported **even when a valid declaration sits beside it**:
 * the node is mid-migration, and the broken key is the one that outlives the
 * alias. A wrongly-typed field is reported rather than ignored, or a value the
 * contract requires would escape its rule by being a number.
 */
export function classifyDeclaration(
  properties: unknown,
  host: string = HOST_CLAUDE_SKILL,
): {
  declaration: Declaration | null;
  malformed: string[];
} {
  // Throws on an unknown host: the boundary (skillPlan) refuses those, so one
  // arriving here is a bug, and silently judging it as Claude would apply the
  // wrong host's rules.
  const { legacyAliases } = requireSkillHost(host);
  const malformed: string[] = [];
  if (!isPlainObject(properties)) return { declaration: null, malformed };

  const read = (path: string, host: string, obj: Record<string, unknown>): Declaration => {
    const description = ownValue(obj, 'description');
    const name = ownValue(obj, 'name');
    const enable = ownValue(obj, 'enable');
    for (const [field, value] of [
      ['description', description],
      ['name', name],
    ] as const) {
      if (own(obj, field) && typeof value !== 'string') malformed.push(`${path}.${field}`);
    }
    if (own(obj, 'enable') && typeof enable !== 'boolean') malformed.push(`${path}.enable`);
    return {
      key: path,
      host,
      description: typeof description === 'string' ? description : '',
      name: typeof name === 'string' ? name : '',
      nameSet: typeof name === 'string',
      // Enable defaults to FALSE: publishing takes an explicit opt-in.
      enable: enable === true,
      enableSet: typeof enable === 'boolean',
    };
  };

  let declaration: Declaration | null = null;

  // The new shape first: every host entry is shape-checked, and the
  // claudeSkill one becomes the declaration.
  if (own(properties, EXPORTS_KEY)) {
    const raw = ownValue(properties, EXPORTS_KEY);
    if (!isPlainObject(raw)) {
      malformed.push(EXPORTS_KEY);
    } else {
      // Sorted so the malformed list is deterministic. Object key order is
      // insertion order for string keys, which is a property of how the row
      // was written rather than of the node — an unsorted list would make a
      // `--strict` gate nondeterministic across two reads of the same data.
      //
      // By UTF-8 bytes, matching Go: the default `.sort()` compares UTF-16
      // code units and orders an astral key against U+E000 the other way
      // round. A fixture generated from Go pins this.
      for (const entryHost of Object.keys(raw).sort(compareUtf8)) {
        // Only a KNOWN host's entry is shape-checked (cor:agt:030:06; #1292).
        // An unknown key belongs to no host, so a broken one must not become
        // an ERROR on every host and block an unrelated, valid export — which
        // is what checking it here did. `unknownHostKeys` reports it instead,
        // as a warning attributed to no host, whatever its shape.
        if (skillHost(entryHost) === null) continue;
        const path = `${EXPORTS_KEY}.${entryHost}`;
        const entry = raw[entryHost];
        if (!isPlainObject(entry)) {
          malformed.push(path);
          continue;
        }
        const d = read(path, entryHost, entry);
        if (entryHost === host) declaration = d;
      }
    }
  }

  // Then the retired top-level keys, as aliases — for Claude only. They
  // predate hosts and always meant Claude; reading them as another host's
  // declaration would publish somewhere nobody chose. For any other host they
  // are neither a declaration nor that host's malformed finding (the Claude
  // plan reports them).
  if (!legacyAliases) return { declaration, malformed };
  for (const key of LEGACY_TOP_LEVEL_KEYS) {
    if (!own(properties, key)) continue;
    const raw = ownValue(properties, key);
    if (!isPlainObject(raw)) {
      malformed.push(key);
      continue;
    }
    const d = read(key, HOST_CLAUDE_SKILL, raw);
    if (declaration === null) declaration = d;
  }

  return { declaration, malformed };
}

/**
 * A node's declaration for `host` (default `claudeSkill`), or null when it has none.
 *
 * **Not the same question as "will it export".** `enable` defaults to off, so
 * most declarations are declared and not enabled — and lint judges a
 * declaration whether or not it is enabled, because a broken name is worth
 * reporting BEFORE somebody turns it on. `status` likewise has to be able to
 * name a file whose declaration is switched off.
 */
export function declaredSkill(properties: unknown, host: string = HOST_CLAUDE_SKILL): Declaration | null {
  return classifyDeclaration(properties, host).declaration;
}

/**
 * The declaration property paths a node carries whose value is the wrong shape.
 *
 * Such a node is selected by the discovery predicate (the KEY exists), so
 * without a finding it would be silently skipped and counted in nobody's
 * total — an all-clear wider than the read that produced it.
 */
export function malformedDeclarationPaths(properties: unknown, host: string = HOST_CLAUDE_SKILL): string[] {
  return classifyDeclaration(properties, host).malformed;
}

/**
 * The keys under `properties.exports` that name no host this server knows
 * (cor:agt:030:06; #1292), in UTF-8 byte order.
 *
 * Host-independent by construction: the key belongs to none of the hosts, so
 * the caller reports it once per node rather than once per host — tagging it
 * with every host would claim it for hosts it was never written for. Never
 * read as an alias for a known host (`codex` is not `codexSkill`).
 *
 * Its VALUE is not inspected: a malformed unknown entry is still just an
 * unknown key, and `classifyDeclaration` no longer shape-checks one.
 */
export function unknownHostKeys(properties: unknown): string[] {
  if (!isPlainObject(properties) || !own(properties, EXPORTS_KEY)) return [];
  const raw = ownValue(properties, EXPORTS_KEY);
  if (!isPlainObject(raw)) return [];
  return Object.keys(raw)
    .filter((key) => skillHost(key) === null)
    .sort(compareUtf8);
}

/**
 * `unknownHostKeys`, bounded for a caller that lists only some of them: the
 * total count, plus the first `limit` keys of at most `maxBytes` UTF-8 bytes,
 * in the SAME UTF-8 byte order (@copilot, PR #1296).
 *
 * One pass, keeping a sorted window of `limit` keys: O(n × limit), and it
 * never materializes or sorts the full list. `properties` is writer-controlled,
 * so a report that bounded only its OUTPUT still let one huge `exports` object
 * make every plan sort all of it. Defined to equal
 * `unknownHostKeys(p).filter(fits).slice(0, limit)`; a property test pins that.
 */
export function unknownHostKeysBounded(
  properties: unknown,
  limit: number,
  maxBytes: number,
): { total: number; keys: string[] } {
  if (!isPlainObject(properties) || !own(properties, EXPORTS_KEY)) return { total: 0, keys: [] };
  const raw = ownValue(properties, EXPORTS_KEY);
  if (!isPlainObject(raw)) return { total: 0, keys: [] };
  let total = 0;
  const window: string[] = [];
  for (const key of Object.keys(raw)) {
    if (skillHost(key) !== null) continue;
    total += 1;
    if (limit <= 0 || Buffer.byteLength(key, 'utf8') > maxBytes) continue;
    if (window.length === limit && compareUtf8(key, window[limit - 1]!) >= 0) continue;
    let i = window.length;
    while (i > 0 && compareUtf8(key, window[i - 1]!) < 0) i -= 1;
    window.splice(i, 0, key);
    if (window.length > limit) window.pop();
  }
  return { total, keys: window };
}

/**
 * The retired top-level alias paths a node still carries as OBJECTS.
 *
 * Lives here rather than in `lint.ts` so the "what counts as a declaration
 * object" rule has exactly one implementation — a second copy in the linter is
 * how the reader and the rule come to disagree about the same node, which is
 * the drift `classifyDeclaration`'s one-scan comment already warns about.
 */
export function legacyAliasPaths(properties: unknown): string[] {
  if (!isPlainObject(properties)) return [];
  return LEGACY_TOP_LEVEL_KEYS.filter(
    (key) => own(properties, key) && isPlainObject(ownValue(properties, key)),
  ).map((key) => `properties.${key}`);
}

/** Whether a declaration is switched on for publishing (`enable: true`). */
export function isEnabled(declaration: Declaration | null): boolean {
  return declaration !== null && declaration.enable;
}

/** The stored name with surrounding whitespace trimmed Go's way. */
export function storedName(declaration: Declaration): string {
  return goTrimSpace(declaration.name);
}
