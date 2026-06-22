// Validation for the `parentRel` parameter on MCP tools that browse or
// write into a memory subtree (hadron_create_parent_node, hadron_find_nodes,
// hadron_list_nodes). Filed as #2 of issue #100: a stricter input check
// prevents callers from accidentally producing structurally-malformed
// node URNs (e.g. literal `""`, full `urn:agent:...` URNs embedded as
// path segments).
//
// Aligned with the URN-composition contract documented in the latest
// comment on issue #99 / Hadron `dev:conventions:urn-format`:
//   - canonical and bare forms accepted
//   - wrong-type prefixes rejected (silent coercion is a security risk)
//   - empty-after-trim rejected when the param is present (callers must
//     OMIT the param for root-level, not pass an empty string)

const ACCEPTED_URN_PREFIXES = [
  'hrn:memory:', 'hrn:node:',
  'urn:memory:', 'urn:node:', // legacy scheme, accepted forever (issue #239)
  'loc:',
];
const KNOWN_URN_TYPES = ['org', 'memory', 'agent', 'app', 'node'] as const;

export class InvalidParentRelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParentRelError';
  }
}

/**
 * Validate a `parentRel` argument supplied to an MCP tool.
 *
 * - `undefined` is allowed and means "root-level" (callers must omit
 *   the parameter, not pass an empty string).
 * - Empty/whitespace-only strings are rejected.
 * - URN-prefixed inputs must be `urn:memory:` or `urn:node:` (the two
 *   shapes that semantically address something inside a memory). Any
 *   other `urn:<type>:` prefix is rejected to prevent silent coercion.
 *
 * Throws `InvalidParentRelError` on invalid input.
 */
export function validateParentRel(parentRel: string | undefined): void {
  if (parentRel === undefined) return;

  const trimmed = parentRel.trim();
  if (trimmed === '' || trimmed === '""' || trimmed === "''") {
    throw new InvalidParentRelError(
      'parentRel must be omitted for root-level nodes, not passed as an empty string.',
    );
  }

  // Accepted prefixes (urn:memory:, urn:node:, loc:) MUST have a non-empty
  // value after the prefix — `urn:memory:` alone (or `loc:` alone) would
  // pass through to downstream parseUrnInput as an empty rel and produce
  // confusing not-found / malformed-loc behavior. Reject explicitly.
  for (const prefix of ACCEPTED_URN_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      if (trimmed.length === prefix.length) {
        throw new InvalidParentRelError(
          `parentRel cannot be just '${prefix}' with no value after it. Provide the rel-path after the prefix.`,
        );
      }
      return; // accepted prefix with non-empty value
    }
  }

  // Reject other hrn:<type>: / urn:<type>: prefixes (silent coercion is a
  // security risk).
  const urnMatch = trimmed.match(/^(hrn|urn):([a-zA-Z]+):/);
  if (urnMatch) {
    const scheme = urnMatch[1];
    const type = urnMatch[2];
    const known = (KNOWN_URN_TYPES as readonly string[]).includes(type);
    const hint = known
      ? `'${scheme}:${type}:' addresses an entity, not a subtree path.`
      : `'${scheme}:${type}:' is not a known URN type.`;
    throw new InvalidParentRelError(
      `parentRel cannot start with '${scheme}:${type}:'. ${hint} Pass a bare rel-path, or use 'hrn:memory:' / 'hrn:node:'.`,
    );
  }

  // Otherwise: bare rel-path, accepted.
}
