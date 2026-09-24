/**
 * #1315 — a skill name the HOST reserves is refused for that host only.
 *
 * Claude Code keeps skills synced from claude.ai in `<root>/synced/` and skips a
 * skill authored at that name (code.claude.com/docs/en/skills), so an export
 * named `synced` would land in Claude's own folder and never load. The
 * `anthropic`/`claude` words the Claude platform bans are an UPLOAD-surface rule
 * that Claude Code does not apply (2.1.143 loads such names), so they are pinned
 * here as NOT reserved — refusing them would refuse a working skill.
 */
import { describe, it, expect } from 'vitest';
import { lintNode, type SkillNode } from './lint.js';
import { HOST_CLAUDE_SKILL, HOST_CODEX_SKILL, skillHost } from './hosts.js';

const nodeNamed = (name: string): SkillNode => {
  const decl = { name, description: 'Does a thing. Use when you need it.', enable: true };
  return {
    urn: `hrn:node:example.com:demo:tasks:${name}`,
    loc: `tasks:${name}`,
    memoryUrn: 'example.com:demo',
    isRunnable: true,
    content: '# Body',
    properties: { exports: { claudeSkill: decl, codexSkill: decl } },
  };
};
const rules = (name: string, host: string) => lintNode(nodeNamed(name), host).map((f) => `${f.rule}:${f.severity}`);

describe('#1315 — host-reserved skill names', () => {
  it('the registry: Claude reserves `synced`; Codex reserves nothing', () => {
    expect(skillHost(HOST_CLAUDE_SKILL)?.reservedNames).toEqual(['synced']);
    expect(skillHost(HOST_CODEX_SKILL)?.reservedNames).toEqual([]);
  });

  it('`synced` is an ERROR for claudeSkill — so the planner keeps it out of export', () => {
    expect(rules('synced', HOST_CLAUDE_SKILL)).toContain('skill-name-reserved:error');
  });

  it('…and nothing for codexSkill: the reservation is the host\'s, not a global ban', () => {
    expect(rules('synced', HOST_CODEX_SKILL)).not.toContain('skill-name-reserved:error');
  });

  it('matches the whole name, not a substring', () => {
    for (const name of ['synced-notes', 'my-synced', 'unsynced']) {
      expect(rules(name, HOST_CLAUDE_SKILL), name).not.toContain('skill-name-reserved:error');
    }
  });

  it('`claude` / `anthropic` in a name are NOT reserved for either host (an upload-surface rule, not a Claude Code one)', () => {
    for (const name of ['hadron-export-task-as-claude-skill', 'anthropic-helper']) {
      for (const host of [HOST_CLAUDE_SKILL, HOST_CODEX_SKILL]) {
        expect(rules(name, host), `${name}@${host}`).not.toContain('skill-name-reserved:error');
      }
    }
  });

  it('CONTROL: an ordinary name yields no name finding at all', () => {
    expect(rules('plain-skill', HOST_CLAUDE_SKILL).filter((r) => r.startsWith('skill-name-'))).toEqual([]);
  });
});

describe('#1318 review (@copilot): the reservation is reported whatever else is wrong with the name', () => {
  it('`Synced` / `SYNCED` get BOTH the grammar error and the host reason, so fixing the case does not reveal a second error', () => {
    for (const name of ['Synced', 'SYNCED']) {
      const got = rules(name, HOST_CLAUDE_SKILL);
      expect(got, name).toContain('skill-name-invalid:error');
      expect(got, name).toContain('skill-name-reserved:error');
    }
  });
});
