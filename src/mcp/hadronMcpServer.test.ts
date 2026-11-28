/**
 * #5474 (F6 of the #4630 blind review, and Arianna's local P3-1): the contract of the positional-`tool` shim in
 * ./hadronMcpServer.ts. Since SDK 2.x the only form Hadron accepts is (name, description, shape, handler); any other
 * form must fail at registration (boot), never register a tool with a guessed shape.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { objectSchemaFor, registerLegacyTool, withPositionalTool } from './hadronMcpServer.js';

const handler = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });
const freshServer = () => new McpServer({ name: 'shim-5474', version: '1' });
const formError = (name: string) => `tool ${name}: expected (name, description, shape, handler)`;

describe('registerLegacyTool', () => {
  it('registers the positional (name, description, shape, handler) form', () => {
    const server = freshServer();
    expect(() => registerLegacyTool(server, ['ok_tool', 'd', { a: z.string() }, handler])).not.toThrow();
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
});

describe('objectSchemaFor', () => {
  it('returns the same ZodObject for the same shape, and a different one for another shape', () => {
    const shape = { a: z.string() };
    const first = objectSchemaFor(shape);
    expect(first).toBeInstanceOf(z.ZodObject);
    expect(objectSchemaFor(shape)).toBe(first);
    expect(objectSchemaFor({ a: z.string() })).not.toBe(first);
  });
});
