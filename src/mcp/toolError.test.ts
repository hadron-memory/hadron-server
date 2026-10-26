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
    const requestId = (result as { structuredContent: { error: { requestId: string } } }).structuredContent.error.requestId;
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: `[INTERNAL_SERVER_ERROR] Internal server error. Request id: ${requestId}` }],
      structuredContent: { error: { code: 'INTERNAL_SERVER_ERROR', requestId, message: 'Internal server error.' } },
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[mcp] internal_fault', expect.objectContaining({ requestId, error }));
  });

  it('redacts nested originalError/cause wrappers, including a cycle', () => {
    const cause = new Error('wrapper', { cause: faults[0] });
    const error = new GraphQLError(detail, { originalError: cause });
    Object.assign(error, { cause: error });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toolErrorResult(error, () => detail).isError).toBe(true);
  });

  it('a typed refusal keeps its text and is flagged isError (#1789)', () => {
    const error = new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
    Object.assign(error, { cause: error });
    expect(toolErrorResult(error, () => 'Error: Forbidden')).toEqual({ isError: true, ...textResult('Error: Forbidden') });
  });

  it('a plain Error is a fault however familiar its text (#1789)', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fallback = vi.fn(() => 'Error: Forbidden');
    const result = toolErrorResult(new Error('Forbidden'), fallback) as { content: { text: string }[]; structuredContent: unknown };
    expect(fallback).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain('Forbidden');
    expect(result.structuredContent).toMatchObject({ error: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(log).toHaveBeenCalled();
  });

  it('a GraphQLError wearing the default INTERNAL_SERVER_ERROR code is a fault, not a refusal', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = toolErrorResult(new GraphQLError('boom detail', { extensions: { code: 'INTERNAL_SERVER_ERROR' } }), () => 'boom detail');
    expect(JSON.stringify(result)).not.toContain('boom detail');
  });

  it('two identical faults get distinct request ids', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids = [0, 1].map(() => (toolErrorResult(new Error('same'), () => 'x') as { structuredContent: { error: { requestId: string } } }).structuredContent.error.requestId);
    expect(ids[0]).not.toBe(ids[1]);
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

  it('the handler boundary turns any other throw into the generic envelope instead of the SDK echoing its message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await withToolErrorBoundary('test', async () => { throw new Error('private detail'); })({}, {}) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^\[INTERNAL_SERVER_ERROR\] Internal server error\. Request id: /);
    expect(JSON.stringify(result)).not.toContain('private detail');
  });
});
