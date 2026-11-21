import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NODE_TYPE,
  NODE_TYPES,
  ORDINARY_NODE_TYPES,
  ORDINARY_NODE_TYPES_TEXT,
  PLATFORM_NODE_TYPES,
} from './nodeTypes.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from './bootPrompt.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('#909 slice (a): one canonical node-type list', () => {
  it('names the eight ordinary values and the four platform kinds', () => {
    expect([...ORDINARY_NODE_TYPES]).toEqual([
      'abstract', 'chat', 'data', 'info', 'prompt', 'record', 'reference', 'system',
    ]);
    expect([...PLATFORM_NODE_TYPES]).toEqual(['task', 'comment', 'chat-message', 'compiled-boot-prompt']);
    expect(NODE_TYPES).toHaveLength(12);
    expect(new Set(NODE_TYPES).size).toBe(NODE_TYPES.length);
  });

  it('agrees with the schema default and the boot-prompt kind', () => {
    expect(DEFAULT_NODE_TYPE).toBe('info');
    expect(read('../../prisma/schema.prisma')).toContain('nodeType            String              @default("info")');
    expect(NODE_TYPES).toContain(COMPILED_BOOT_PROMPT_NODE_TYPE);
    expect(ORDINARY_NODE_TYPES_TEXT).toContain('info (default)');
  });

  it('is what the MCP create and update descriptions print, not a second copy', () => {
    const server = read('../mcp/server.ts');
    expect(server).not.toContain('canonical values: abstract, chat, data, info (default)');
    expect(server.match(/canonical values: \$\{ORDINARY_NODE_TYPES_TEXT\}/g)).toHaveLength(2);
  });

  it('is cited by the schema comment, which names every platform kind', () => {
    const schema = read('../../prisma/schema.prisma');
    expect(schema).toContain('src/lib/nodeTypes.ts');
    for (const t of NODE_TYPES) expect(schema).toContain(`\`${t}\``);
  });

  it('adds no validation: an unknown nodeType is still not a member', () => {
    expect((NODE_TYPES as readonly string[]).includes('transcript')).toBe(false);
  });
});
