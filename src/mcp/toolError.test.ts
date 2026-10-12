import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/index.js';
import { toolErrorResult } from './toolError.js';

afterEach(() => vi.restoreAllMocks());
const detail = '/srv/private.ts private-id-1695 SELECT secrets';
const faults = [
  new Prisma.PrismaClientValidationError(detail, { clientVersion: 'test' }),
  new Prisma.PrismaClientKnownRequestError(detail, { code: 'P2002', clientVersion: 'test', meta: { private: detail } }),
  new Prisma.PrismaClientUnknownRequestError(detail, { clientVersion: 'test' }),
  new Prisma.PrismaClientInitializationError(detail, 'test'),
  new Prisma.PrismaClientRustPanicError(detail, 'test'),
];

describe('MCP database-fault boundary', () => {
  it.each(faults)('redacts $name before evaluating the fallback', (error) => {
    const fallback = vi.fn(() => detail);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = toolErrorResult(error, fallback);
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: '[internal_server_error] Unable to complete this request. Please try again.' }] });
    expect(fallback).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[mcp] tool_database_error', expect.objectContaining({ error }));
  });

  it('redacts nested originalError/cause wrappers, including a cycle', () => {
    const cause = new Error('wrapper', { cause: faults[0] });
    const error = new GraphQLError(detail, { originalError: cause });
    Object.assign(error, { cause: error });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toolErrorResult(error, () => detail).isError).toBe(true);
  });

  it('preserves non-database domain output and tolerates a cyclic domain error', () => {
    const error = new Error('Forbidden');
    Object.assign(error, { cause: error });
    expect(toolErrorResult(error, () => 'Error: Forbidden')).toEqual({ content: [{ type: 'text', text: 'Error: Forbidden' }] });
  });
});
