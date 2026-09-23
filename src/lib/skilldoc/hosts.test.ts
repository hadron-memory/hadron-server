/**
 * #1254 — a second skill host (Codex) in the library half: the registry, the
 * host-aware declaration reader, and host-aware lint. The Claude default is
 * pinned by the existing parity suites; this file pins what a host argument
 * changes.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDeclaration,
  declaredSkill,
  HOST_CLAUDE_SKILL,
  HOST_CODEX_SKILL,
  lintCollisions,
  lintNode,
  malformedDeclarationPaths,
  requireSkillHost,
  SKILL_HOSTS,
  skillHost,
  type SkillNode,
} from './index.js';

const claude = { name: 'hadron-x', description: 'Use when X.', enable: true };
const codex = { name: 'hadron-x-codex', description: 'Use when X, in Codex.', enable: true };

function node(urn: string, properties: unknown): SkillNode {
  return { urn, loc: urn, memoryUrn: 'hrn:mem:t:m', isRunnable: true, content: '# body', properties };
}

describe('the host registry', () => {
  it('knows Claude and Codex, with the measured limits', () => {
    expect(SKILL_HOSTS.map((h) => h.key)).toEqual([HOST_CLAUDE_SKILL, HOST_CODEX_SKILL]);
    expect(skillHost(HOST_CODEX_SKILL)).toMatchObject({ maxNameLength: 64, maxDescriptionLength: 1024, legacyAliases: false });
    expect(skillHost(HOST_CLAUDE_SKILL)).toMatchObject({ legacyAliases: true });
  });

  it('an unknown host is null, and throws where a host is required', () => {
    expect(skillHost('cursorRule')).toBeNull();
    expect(() => requireSkillHost('cursorRule')).toThrow(/unknown skill host "cursorRule"/);
    expect(() => classifyDeclaration({ exports: {} }, 'cursorRule')).toThrow(/unknown skill host/);
  });
});

describe('reading a declaration for a host', () => {
  const props = { exports: { claudeSkill: claude, codexSkill: codex } };

  it('each host reads its own entry, and the default is still Claude', () => {
    expect(declaredSkill(props)).toMatchObject({ key: 'exports.claudeSkill', host: HOST_CLAUDE_SKILL, name: 'hadron-x' });
    expect(declaredSkill(props, HOST_CODEX_SKILL)).toMatchObject({
      key: 'exports.codexSkill',
      host: HOST_CODEX_SKILL,
      name: 'hadron-x-codex',
      enable: true,
    });
  });

  it('a node declaring only Claude has no Codex declaration', () => {
    expect(declaredSkill({ exports: { claudeSkill: claude } }, HOST_CODEX_SKILL)).toBeNull();
  });

  it('the retired top-level keys NEVER alias to Codex', () => {
    const legacy = { skill: claude, claudeSkill: claude };
    expect(declaredSkill(legacy)).not.toBeNull();
    expect(declaredSkill(legacy, HOST_CODEX_SKILL)).toBeNull();
  });

  it('a malformed legacy key is Claude\'s finding, not Codex\'s', () => {
    expect(malformedDeclarationPaths({ skill: 'nope' })).toEqual(['skill']);
    expect(malformedDeclarationPaths({ skill: 'nope' }, HOST_CODEX_SKILL)).toEqual([]);
  });

  it('a malformed exports entry is reported under every host (it is one map)', () => {
    const bad = { exports: { codexSkill: 'nope', claudeSkill: claude } };
    expect(malformedDeclarationPaths(bad)).toEqual(['exports.codexSkill']);
    expect(malformedDeclarationPaths(bad, HOST_CODEX_SKILL)).toEqual(['exports.codexSkill']);
  });
});

describe('lint for a host', () => {
  it('a Codex declaration is never steered off a legacy key, even with one beside it', () => {
    const n = node('n1', { exports: { codexSkill: codex }, skill: claude });
    expect(lintNode(n, HOST_CODEX_SKILL).map((f) => f.rule)).not.toContain('skill-legacy-key');
    expect(lintNode(n).map((f) => f.rule)).toContain('skill-legacy-key');
  });

  it('Codex enforces the 1,024-character description cap (row-sourcing is proven in hosts.limits.test.ts)', () => {
    const long = { ...codex, description: 'Use when ' + 'x'.repeat(1016) };
    const findings = lintNode(node('n2', { exports: { codexSkill: long } }), HOST_CODEX_SKILL);
    expect(findings.find((f) => f.rule === 'skill-description-too-long')?.message).toMatch(/1025 characters; the host caps it at 1024/);
  });

  it('judges only the host asked about: a bad Claude name is not a Codex finding', () => {
    const n = node('n3', { exports: { claudeSkill: { ...claude, name: 'Bad Name' }, codexSkill: codex } });
    expect(lintNode(n).map((f) => f.rule)).toContain('skill-name-invalid');
    expect(lintNode(n, HOST_CODEX_SKILL).map((f) => f.rule)).not.toContain('skill-name-invalid');
  });

  it('collisions are per host: one node using one name for both hosts is not a collision', () => {
    const same = node('n4', { exports: { claudeSkill: claude, codexSkill: { ...codex, name: 'hadron-x' } } });
    expect(lintCollisions([same])).toEqual([]);
    expect(lintCollisions([same], HOST_CODEX_SKILL)).toEqual([]);
  });

  it('two nodes storing one Codex name collide under Codex only', () => {
    const a = node('a', { exports: { claudeSkill: { ...claude, name: 'a' }, codexSkill: codex } });
    const b = node('b', { exports: { claudeSkill: { ...claude, name: 'b' }, codexSkill: codex } });
    expect(lintCollisions([a, b])).toEqual([]);
    expect(lintCollisions([a, b], HOST_CODEX_SKILL).map((f) => f.urn)).toEqual(['a', 'b']);
  });
});
