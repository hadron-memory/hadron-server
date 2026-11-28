import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NODE_TYPE,
  NODE_TYPES,
  ORDINARY_NODE_TYPES,
  ORDINARY_NODE_TYPES_TEXT,
  PLATFORM_DEFINED_NODE_TYPES,
} from './nodeTypes.js';
import { BOOT_PROMPT_NODE_TYPE, RETIRED_COMPILED_BOOT_PROMPT_NODE_TYPE } from './bootPrompt.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('#909 slice (a): one canonical node-type list', () => {
  it('names the eight ordinary values and the two platform kinds (#5453: compiled-boot-prompt and task left)', () => {
    expect([...ORDINARY_NODE_TYPES]).toEqual([
      'abstract', 'chat', 'data', 'info', 'prompt', 'record', 'reference', 'system',
    ]);
    expect([...PLATFORM_DEFINED_NODE_TYPES]).toEqual(['comment', 'chat-message']);
    expect(NODE_TYPES).toHaveLength(10);
    expect(new Set(NODE_TYPES).size).toBe(NODE_TYPES.length);
  });

  it('agrees with the schema default and the boot-prompt kind', () => {
    expect(DEFAULT_NODE_TYPE).toBe('info');
    expect(read('../../prisma/schema.prisma')).toContain('nodeType            String              @default("info")');
    // #5453: a boot-prompt node is an ordinary `system` node; the type a compiled prompt used to carry is not in the vocabulary.
    expect(ORDINARY_NODE_TYPES).toContain(BOOT_PROMPT_NODE_TYPE);
    expect(NODE_TYPES as readonly string[]).not.toContain(RETIRED_COMPILED_BOOT_PROMPT_NODE_TYPE);
    expect(NODE_TYPES as readonly string[]).not.toContain('task');
    expect(ORDINARY_NODE_TYPES_TEXT).toContain('info (default)');
  });

  it('is what the MCP create and update descriptions print, not a second copy', () => {
    const server = read('../mcp/toolShapes.ts');
    expect(server).not.toContain('canonical values: abstract, chat, data, info (default)');
    expect(server.match(/canonical values: \$\{ORDINARY_NODE_TYPES_TEXT\}/g)).toHaveLength(2);
  });

  it('is cited by the schema comment, which documents exactly these values (both directions)', () => {
    const schema = read('../../prisma/schema.prisma');
    const start = schema.indexOf("/// - `nodeType` is the platform's kind.");
    const end = schema.indexOf('/// - `objectType`', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = schema.slice(start, end);
    expect(block).toContain('src/lib/nodeTypes.ts');
    const documented = new Set<string>();
    for (const m of block.matchAll(/^\/\/\/ {3}- `([\w-]+)`/gm)) documented.add(m[1]);
    const reserved = block.match(/^\/\/\/ {3}`([\w-]+)` is reserved by the platform/m);
    expect(reserved).not.toBeNull();
    documented.add(reserved![1]);
    const also = block.match(/also writes\s+([\s\S]*?)\. The one list/);
    expect(also).not.toBeNull();
    for (const m of also![1].matchAll(/`([\w-]+)`/g)) documented.add(m[1]);
    expect([...documented].sort()).toEqual([...NODE_TYPES].sort());
  });

  it('does not list a custom value such as transcript among the platform names', () => {
    expect((NODE_TYPES as readonly string[]).includes('transcript')).toBe(false);
  });
});
