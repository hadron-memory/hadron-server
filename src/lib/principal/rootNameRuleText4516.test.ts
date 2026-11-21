/**
 * #4516 F7: the rule text derives its bound from the lib's `MAX_ATOM_LEN`. The real bound equals the text's old
 * hard-coded 64, so only a changed bound can tell the two apart: mock it and read the text.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../urn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../urn.js')>()),
  MAX_ATOM_LEN: 10,
}));

describe('#4516 F7: ROOT_NAME_RULE_TEXT follows MAX_ATOM_LEN', () => {
  it('states the lib bound, not a literal 64 (mutant: bound decoupled)', async () => {
    const { ROOT_NAME_RULE_TEXT, RootNameInvalidError } = await import('./mintPrincipal.js');
    expect(ROOT_NAME_RULE_TEXT).toContain('1–10');
    expect(ROOT_NAME_RULE_TEXT).not.toContain('64');
    expect(new RootNameInvalidError('x').message).toContain(ROOT_NAME_RULE_TEXT);
  });
});
