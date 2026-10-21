import { describe, it, expect, vi } from 'vitest';
import { compileTemplate } from './template.js';
import { BROKEN_INCLUDE_NOTICE } from './includes/spliceIncludes.js';

// Mock PrismaClient
function mockDb(
  nodes: Array<{ loc: string; data?: unknown; content?: string; deletedAt?: Date | null }>,
) {
  return {
    node: {
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          nodes.find((n) => {
            if (n.loc !== where.loc) return false;
            // Honor Prisma's `deletedAt: null` soft-delete filter the same way
            // the real query would: a row with a non-null deletedAt is excluded.
            if (where.deletedAt === null && n.deletedAt != null) return false;
            return true;
          }) ?? null
        );
      }),
    },
  } as any;
}

describe('compileTemplate', () => {
  it('returns content unchanged if no Mustache syntax', async () => {
    const result = await compileTemplate('Hello world', null, 'mem1', mockDb([]), {});
    expect(result).toBe('Hello world');
  });

  it('resolves variables from node own data', async () => {
    const result = await compileTemplate(
      'Hello, {{name}}!',
      { name: 'Holger' },
      'mem1',
      mockDb([]),
      {},
    );
    expect(result).toBe('Hello, Holger!');
  });

  it('resolves variables from default data node', async () => {
    const db = mockDb([
      { loc: 'data', data: { name: 'Holger', role: 'engineer' } },
    ]);
    const result = await compileTemplate(
      'Hello, {{name}}! You are a {{role}}.',
      null,
      'mem1',
      db,
      {},
    );
    expect(result).toBe('Hello, Holger! You are a engineer.');
  });

  it('node own data overrides default data', async () => {
    const db = mockDb([
      { loc: 'data', data: { name: 'Default', color: 'blue' } },
    ]);
    const result = await compileTemplate(
      '{{name}} likes {{color}}.',
      { name: 'Holger' },
      'mem1',
      db,
      {},
    );
    expect(result).toBe('Holger likes blue.');
  });

  it('resolves cross-node references', async () => {
    const db = mockDb([
      { loc: 'settings', data: { theme: 'dark', lang: 'en' } },
    ]);
    const result = await compileTemplate(
      'Theme: {{settings.theme}}, Lang: {{settings.lang}}',
      null,
      'mem1',
      db,
      {},
    );
    expect(result).toBe('Theme: dark, Lang: en');
  });

  it('resolves partials', async () => {
    const db = mockDb([
      { loc: 'prompts:partials:greeting', content: 'Welcome to Hadron!' },
    ]);
    const result = await compileTemplate(
      '{{> prompts:partials:greeting}} How can I help?',
      null,
      'mem1',
      db,
      {},
    );
    expect(result).toBe('Welcome to Hadron! How can I help?');
  });

  it('renders Mustache conditionals (sections)', async () => {
    const result = await compileTemplate(
      '{{#premium}}Premium user{{/premium}}{{^premium}}Free user{{/premium}}',
      { premium: true },
      'mem1',
      mockDb([]),
      {},
    );
    expect(result).toBe('Premium user');
  });

  it('renders Mustache conditionals (inverted)', async () => {
    const result = await compileTemplate(
      '{{#premium}}Premium{{/premium}}{{^premium}}Free{{/premium}}',
      { premium: false },
      'mem1',
      mockDb([]),
      {},
    );
    expect(result).toBe('Free');
  });

  it('renders Mustache iteration', async () => {
    const result = await compileTemplate(
      '{{#items}}{{name}}, {{/items}}',
      { items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
      'mem1',
      mockDb([]),
      {},
    );
    expect(result).toBe('A, B, C, ');
  });

  it('handles missing variables gracefully (empty string)', async () => {
    const result = await compileTemplate(
      'Hello, {{name}}!',
      {},
      'mem1',
      mockDb([]),
      {},
    );
    expect(result).toBe('Hello, !');
  });

  it('handles missing cross-node reference gracefully', async () => {
    const result = await compileTemplate(
      'Theme: {{settings.theme}}',
      null,
      'mem1',
      mockDb([]),
      {},
    );
    expect(result).toBe('Theme: ');
  });

  it('handles missing partial gracefully', async () => {
    const result = await compileTemplate(
      '{{> nonexistent}} rest',
      null,
      'mem1',
      mockDb([]),
      {},
    );
    // cor:dmo:150:05: an include that can't resolve shows the notice, never a silent gap.
    expect(result).toBe(`${BROKEN_INCLUDE_NOTICE} rest`);
  });

  // Regression: issue #543 — soft-deleted nodes must not resolve during
  // compile. `node(ref:)` promises "Soft-deleted nodes do not resolve"; the
  // Mustache compile path has to honor the same contract.
  it('ignores a soft-deleted default data node', async () => {
    const db = mockDb([
      { loc: 'data', data: { name: 'Ghost' }, deletedAt: new Date('2026-07-07') },
    ]);
    const result = await compileTemplate('Hello, {{name}}!', null, 'mem1', db, {});
    expect(result).toBe('Hello, !');
  });

  it('ignores a soft-deleted cross-node reference', async () => {
    const db = mockDb([
      { loc: 'settings', data: { theme: 'dark' }, deletedAt: new Date('2026-07-07') },
    ]);
    const result = await compileTemplate('Theme: {{settings.theme}}', null, 'mem1', db, {});
    expect(result).toBe('Theme: ');
  });

  it('ignores a soft-deleted partial', async () => {
    const db = mockDb([
      { loc: 'greeting', content: 'Welcome!', deletedAt: new Date('2026-07-07') },
    ]);
    const result = await compileTemplate('{{> greeting}} rest', null, 'mem1', db, {});
    expect(result).toBe(`${BROKEN_INCLUDE_NOTICE} rest`);
  });

  it('combines all resolution sources', async () => {
    const db = mockDb([
      { loc: 'data', data: { app_name: 'Juno' } },
      { loc: 'user-profile', data: { name: 'Maria', industry: 'construction' } },
      { loc: 'prompts:partials:footer', content: 'Powered by Hadron' },
    ]);
    const result = await compileTemplate(
      'Welcome to {{app_name}}, {{user-profile.name}}! Industry: {{user-profile.industry}}. Local: {{local_var}}. {{> prompts:partials:footer}}',
      { local_var: 'hello' },
      'mem1',
      db,
      {},
    );
    expect(result).toBe('Welcome to Juno, Maria! Industry: construction. Local: hello. Powered by Hadron');
  });
});
