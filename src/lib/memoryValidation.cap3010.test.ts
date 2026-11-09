/**
 * #3010 — the MCP prose names a capped result as capped. The scan retains at most `maxFindings` findings
 * (problems first) while the totals stay true, so a header or section count can exceed the lines shown.
 */
import { describe, it, expect } from 'vitest';
import { formatValidationProse } from './memoryValidation.js';

const base = { nodesChecked: 5, skippedChecks: [] as { check: 'STALE_ABSTRACT'; reason: string }[] };

describe('formatValidationProse (#3010)', () => {
  it('informational-only report keeps "No issues found."', () => {
    const out = formatValidationProse({ ...base, totalFindings: 0, totalInformational: 2 }, [], ['i1', 'i2']);
    expect(out).toBe('Validated 5 nodes. No issues found.\n\nInformational findings (2):\ni1\ni2');
  });

  it('an uncapped report reads exactly as before', () => {
    const out = formatValidationProse({ ...base, totalFindings: 2, totalInformational: 1 }, ['p1', 'p2'], ['i1']);
    expect(out).toBe('Found 2 issue(s) in 5 nodes:\n\np1\np2\n\nInformational findings (1):\ni1');
  });

  it('problems over the cap: header says showing K, informational is not an empty body', () => {
    const out = formatValidationProse({ ...base, totalFindings: 9, totalInformational: 4 }, ['p1', 'p2'], []);
    expect(out).toContain('Found 9 issue(s) in 5 nodes (showing the first 2):');
    expect(out).toContain('Informational findings (4): none shown, the findings cap was filled by the issues above.');
    expect(out).not.toMatch(/Informational findings \(4\):\n*$/);
  });

  it('mixed findings beyond the cap: informational is partial and says so', () => {
    const out = formatValidationProse({ ...base, totalFindings: 1, totalInformational: 7 }, ['p1'], ['i1', 'i2']);
    expect(out).toContain('Found 1 issue(s) in 5 nodes:');
    expect(out).toContain('Informational findings (7, showing the first 2):\ni1\ni2');
  });

  it('keeps the skipped-check disclosure on every branch', () => {
    const skippedChecks = [{ check: 'STALE_ABSTRACT' as const, reason: 'encrypted' }];
    for (const [f, i] of [[0, 0], [3, 0], [3, 2]] as const) {
      const out = formatValidationProse({ nodesChecked: 5, skippedChecks, totalFindings: f, totalInformational: i }, [], []);
      expect(out).toContain('Skipped checks:\n- STALE_ABSTRACT: encrypted');
    }
  });
});
