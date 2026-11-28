/**
 * #5474 (F6 of the #4630 blind review, and Arianna's local P3-1): the contract of the positional-`tool` shim in
 * ./hadronMcpServer.ts. Since SDK 2.x the only form Hadron accepts is (name, description, shape, handler); any other
 * form must fail at registration (boot), never register a tool with a guessed shape.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { objectSchemaFor, registerLegacyTool, withPositionalTool } from './hadronMcpServer.js';

const handler = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });
const freshServer = () => new McpServer({ name: 'shim-5474', version: '1' });
const formError = (name: string) => `tool ${name}: expected (name, description, shape, handler)`;

/** What a client sees in `tools/list` from this server: the proof a tool registered, with its schema. */
async function listedTools(server: McpServer) {
  const client = new Client({ name: 'shim-5474-client', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('registerLegacyTool', () => {
  it('registers the positional (name, description, shape, handler) form with its description and shape', async () => {
    const server = freshServer();
    registerLegacyTool(server, ['ok_tool', 'the description', { a: z.string() }, handler]);
    const tools = await listedTools(server);
    expect(tools.map((t) => t.name)).toEqual(['ok_tool']);
    expect(tools[0].description).toBe('the description');
    expect(tools[0].inputSchema.properties).toEqual({ a: { type: 'string' } });
    expect(tools[0].inputSchema.required).toEqual(['a']);
  });

  it('refuses the 3-argument form (no shape) with the documented message', () => {
    expect(() => registerLegacyTool(freshServer(), ['three', 'd', handler])).toThrow(formError('three'));
  });

  it('refuses a handler that is not a function', () => {
    expect(() => registerLegacyTool(freshServer(), ['nofn', 'd', { a: z.string() }, 'not a function'])).toThrow(formError('nofn'));
  });

  it('refuses annotations (a fifth argument) rather than dropping them', () => {
    const annotations = { readOnlyHint: true };
    expect(() => registerLegacyTool(freshServer(), ['annotated', 'd', { a: z.string() }, annotations, handler])).toThrow(formError('annotated'));
  });

  it('refuses the same forms through withPositionalTool, the bare-server entry point', () => {
    const server = withPositionalTool(freshServer());
    const tool = server.tool as unknown as (...args: unknown[]) => void;
    expect(() => tool('three', 'd', handler)).toThrow(formError('three'));
    expect(() => tool('annotated', 'd', { a: z.string() }, { readOnlyHint: true }, handler)).toThrow(formError('annotated'));
  });

  it('registers the positional form through withPositionalTool', async () => {
    const server = withPositionalTool(freshServer());
    server.tool('bare_tool', 'd', { n: z.number() }, handler);
    const tools = await listedTools(server);
    expect(tools.map((t) => t.name)).toEqual(['bare_tool']);
    expect(tools[0].inputSchema.properties).toEqual({ n: { type: 'number' } });
  });
});

describe('objectSchemaFor', () => {
  it('returns the same ZodObject for the same shape, and a different one for another shape', () => {
    const shape = { a: z.string() };
    const first = objectSchemaFor(shape);
    expect(first).toBeInstanceOf(z.ZodObject);
    expect(Object.keys(first.shape)).toEqual(['a']);
    expect(first.shape.a).toBe(shape.a);
    expect(first.safeParse({ a: 'x' }).success).toBe(true);
    expect(first.safeParse({ a: 1 }).success).toBe(false);
    expect(objectSchemaFor(shape)).toBe(first);
    expect(objectSchemaFor({ a: z.string() })).not.toBe(first);
  });
});
