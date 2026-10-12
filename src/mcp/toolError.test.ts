import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/index.js';
import { toolErrorResult, withToolErrorBoundary } from './toolError.js';
import { textResult } from './textResult.js';

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
  it.each([
    new Error('Invalid `prisma.node.upsert()` invocation: private-id-1695'),
    new GraphQLError('PrismaClientValidationError: private-id-1695'),
    { message: 'ConnectorError(PostgresError private-id-1695)' },
    new AggregateError([faults[0]], 'opaque wrapper'),
  ])('redacts copied text, prototype-lost errors and aggregate members', (error) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toolErrorResult(error, () => detail).isError).toBe(true);
  });
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
    expect(toolErrorResult(error, () => 'Error: Forbidden')).toEqual(textResult('Error: Forbidden'));
  });

  it('fails closed when an error cannot be inspected', () => {
    const error = Object.defineProperty({}, 'message', { get() { throw new Error('private detail'); } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toolErrorResult(error, () => detail).isError).toBe(true);
  });

  it('the handler boundary preserves successful results and SDK domain exceptions', async () => {
    const result = textResult('okay');
    expect(await withToolErrorBoundary('test', () => result)({}, {})).toBe(result);
    const refusal = new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
    await expect(withToolErrorBoundary('test', async () => { throw refusal; })({}, {})).rejects.toBe(refusal);
  });
});
