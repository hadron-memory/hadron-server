// Validation for the `parentRel` parameter on MCP tools that browse or
// write into a memory subtree (h-add-parent-node, h-find-nodes,
// h-list-nodes). Filed as #2 of issue #100: a stricter input check
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

const ACCEPTED_URN_PREFIXES = ['urn:memory:', 'urn:node:', 'loc:'];
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

  const urnMatch = trimmed.match(/^urn:([a-zA-Z]+):/);
  if (urnMatch) {
    const acceptable = ACCEPTED_URN_PREFIXES.some((p) => trimmed.startsWith(p));
    if (!acceptable) {
      const type = urnMatch[1];
      const known = (KNOWN_URN_TYPES as readonly string[]).includes(type);
      const hint = known
        ? `'urn:${type}:' addresses an entity, not a subtree path.`
        : `'urn:${type}:' is not a known URN type.`;
      throw new InvalidParentRelError(
        `parentRel cannot start with 'urn:${type}:'. ${hint} Pass a bare rel-path, or use 'urn:memory:' / 'urn:node:'.`,
      );
    }
  }
}
