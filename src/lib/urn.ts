// Spec 003 (003-station-to-app) retired the legacy 'station' type;
// spec 007 (007-entity-id-or-urn) registered 'app' so resolveAppRef
// accepts the prefixed form `urn:app:<bare-urn>` consistently with
// the other helpers.
const URN_TYPES = ['org', 'memory', 'agent', 'app', 'node'] as const;
export type UrnType = typeof URN_TYPES[number] | 'loc' | 'unknown';

export interface ParsedUrn {
  type: UrnType;
  value: string;
}

/**
 * Parse a URN input string, stripping the `urn:<type>:` or `loc:` prefix.
 * Returns the type and bare value. Unprefixed inputs are returned as type 'unknown'
 * for backwards compatibility.
 */
export function parseUrnInput(input: string): ParsedUrn {
  const match = input.match(/^urn:(org|memory|agent|app|node):(.+)$/);
  if (match) return { type: match[1] as UrnType, value: match[2] };
  const locMatch = input.match(/^loc:(.+)$/);
  if (locMatch) return { type: 'loc', value: locMatch[1] };
  return { type: 'unknown', value: input };
}

/**
 * Format a bare value as a typed URN string for display/output.
 */
export function formatUrn(type: string, value: string): string {
  return `urn:${type}:${value}`;
}

/**
 * Validate that a parsed URN matches the expected type.
 * Returns an error message string if mismatched, or null if ok.
 * Type 'unknown' (unprefixed input) is always accepted for backwards compatibility.
 */
export function validateUrnType(parsed: ParsedUrn, expected: UrnType): string | null {
  if (parsed.type === 'unknown') return null; // backwards-compatible
  if (parsed.type === expected) return null;
  // loc is accepted where node is expected
  if (parsed.type === 'loc' && expected === 'node') return null;
  return `Expected ${expected} URN (urn:${expected}:...), got urn:${parsed.type}:...`;
}
