import { expect, it } from 'vitest';
import { projectionFieldHashes, projectionHashDiagnostic } from './projectionHash2801.js';

const originalMain = '**Synthetic 0**\nhrn:node:batch-org:batchmem:dense:00\nID: stable-id\nRevision: 1\nType: info\n\noriginal summary';
const baseline = projectionFieldHashes(originalMain);
it.each([
  ['Revision', originalMain.replace('Revision: 1', 'Revision: 2')],
  ['abstract', originalMain.replace('original summary', 'changed summary')],
  ['Type', originalMain.replace('Type: info\n', '')],
])('#2801 a forced %s hash change identifies its node and field without printing values', (field, changed) => {
  const diagnostic = projectionHashDiagnostic(changed, baseline);
  expect(diagnostic).toContain('hrn:node:batch-org:batchmem:dense:00');
  expect(diagnostic).toContain(field);
  expect(diagnostic).not.toContain('changed summary');
});
