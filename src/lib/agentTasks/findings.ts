/** #2662 / cor:agt:050:30 (ruling0013A): immutable result data, never a matcher or authority input. */
import { GraphQLError } from 'graphql';
import { hasUnstorableJsonText } from './references.js';
export const FINDING_SEVERITIES = ['P1', 'P2', 'P3', 'note'] as const;
export type FindingSeverity = typeof FINDING_SEVERITIES[number];
export type TaskFinding = { id: string; severity: FindingSeverity; text: string };
export type FindingCounts = Record<FindingSeverity, number>;
const invalid = () => new GraphQLError('Invalid findings: at most 100; every id or none, unique 1–32 letters/digits/_/-; severity P1/P2/P3/note; text at most 2,000 characters.', { extensions: { code: 'BAD_USER_INPUT' } });
/** No trimming or interpreting the text. Null/omitted means the legacy finish, including its event shape. */
export function finishFindings(input: unknown): TaskFinding[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length > 100) throw invalid();
  const ids = new Set<string>();
  const hasIds = input.some(f => f && typeof f === 'object' && f.id != null);
  return input.map((f, i) => {
    if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some(k => !['id','severity','text'].includes(k))) throw invalid();
    if (hasIds && f.id == null) throw invalid();
    const id = hasIds ? f.id : `F${i + 1}`;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || ids.has(id)) throw invalid();
    if (!(FINDING_SEVERITIES as readonly unknown[]).includes(f.severity) || typeof f.text !== 'string') throw invalid();
    // PostgreSQL JSON text cannot represent NUL or an unpaired UTF-16 surrogate. Refuse before the write.
    if (hasUnstorableJsonText(f.text)) throw invalid();
    // The UTF-16 bound limits counting work; a Unicode code point occupies at most two code units.
    if (f.text.length > 4000 || Array.from(f.text).length > 2000) throw invalid();
    ids.add(id);
    return { id, severity: f.severity as FindingSeverity, text: f.text };
  });
}
export function countFindings(findings: readonly TaskFinding[]): FindingCounts {
  const counts: FindingCounts = { P1: 0, P2: 0, P3: 0, note: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}
