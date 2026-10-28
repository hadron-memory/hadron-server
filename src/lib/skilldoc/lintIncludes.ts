/**
 * #2048 S11d, cor:dmo:150:03 (R9): an exported node whose include tags cannot be read by the exporter ships the
 * broken-include notice in its body, and `hadron skill lint` warns about it. This rule is server-only: it judges the
 * RESOLVED body, which the pure per-node rules in `lint.ts` (a port with Go parity fixtures) never see, so it
 * lives beside them rather than inside `lintNode`.
 *
 * Position-only by design (cor:dmo:150:05, cor:agt:040:12): a missing, deleted or unreadable target answer the same,
 * and the finding names no target, so it discloses nothing the notice in the body does not.
 */
import { BROKEN_INCLUDE_NOTICE } from '../includes/spliceIncludes.js';
import type { Finding } from './lint.js';

const count = (text: string): number => text.split(BROKEN_INCLUDE_NOTICE).length - 1;

/**
 * One warning when resolution put more notices into the exported body than the stored text already held (an
 * author's own literal notice is not a broken include). Never an error: the export still ships.
 */
export function lintBrokenIncludes(
  node: { urn: string; memoryUrn: string; content: string },
  exportedBody: string,
): Finding | null {
  const broken = count(exportedBody) - count(node.content);
  if (broken <= 0) return null;
  return {
    urn: node.urn,
    memory: node.memoryUrn,
    rule: 'skill-include-broken',
    severity: 'warning',
    message: `${broken} include${broken === 1 ? '' : 's'} in this node could not be resolved with your access, so the export carries "${BROKEN_INCLUDE_NOTICE}" in ${broken === 1 ? 'its' : 'their'} place — the target is missing or you cannot read it`,
  };
}
