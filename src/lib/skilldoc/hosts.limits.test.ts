/**
 * #1254 — proves lint takes its limits FROM THE HOST ROW rather than from a
 * constant that happens to agree. Both real hosts use 64/1024 today, so a test
 * on the real registry cannot tell the two apart; here the Codex row is
 * narrowed and only a row-reading lint notices.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./hosts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./hosts.js')>();
  const narrowed = real.SKILL_HOSTS.map((h) =>
    h.key === real.HOST_CODEX_SKILL ? { ...h, maxNameLength: 5, maxDescriptionLength: 20 } : h,
  );
  return {
    ...real,
    SKILL_HOSTS: narrowed,
    skillHost: (k: string) => narrowed.find((h) => h.key === k) ?? null,
    requireSkillHost: (k: string) => {
      const h = narrowed.find((x) => x.key === k);
      if (!h) throw new Error(`unknown skill host "${k}"`);
      return h;
    },
  };
});

const { lintNode } = await import('./lint.js');

const decl = { name: 'abcdef', description: 'Use when the tail matters.', enable: true };
const n = { urn: 'u', loc: 'u', memoryUrn: 'm', isRunnable: true, content: '# b', properties: { exports: { codexSkill: decl, claudeSkill: decl } } };

describe('lint limits come from the host row', () => {
  it('a narrowed Codex row flags what Claude accepts', () => {
    const codexRules = lintNode(n, 'codexSkill').map((f) => f.rule);
    expect(codexRules).toContain('skill-description-too-long');
    expect(codexRules).toContain('skill-name-invalid');
    const claudeRules = lintNode(n, 'claudeSkill').map((f) => f.rule);
    expect(claudeRules).not.toContain('skill-description-too-long');
    expect(claudeRules).not.toContain('skill-name-invalid');
  });
});
