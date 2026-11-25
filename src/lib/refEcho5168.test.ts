/**
 * #5168: the error boundaries never relay the value a caller typed as a reference.
 *
 * The door-wide acceptance pin is `resolvers.refEcho5168.test.ts`; this file pins each leg directly, so a mutant that
 * removes one of them is caught by name: the three formatter mappings that relayed the value in `extensions`
 * (`offendingValue` on URN_NOT_QUALIFIED and on AmbiguousLegacyUrnError, `offendingSegment` relayed as `offendingValue`
 * on a parse error, `ref` on every entity not-found), the concealed message of the two URN library refusals, and the
 * MCP boundary that renders `error.message` through each tool's closure. Codes are asserted alongside, unchanged
 * (hrn:node:hadronmemory.com:specs:cor:urn:010:02, hrn:node:hadronmemory.com:specs:cor:api:140:01).
 */
import { describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { formatGraphQLError } from '../api/graphql/formatError.js';
import { toolErrorResult, withToolErrorBoundary } from '../mcp/toolError.js';
import { assertFullyQualifiedUrn, parseUrn, UrnNotQualifiedError, UrnParseError } from './urn.js';
import { AmbiguousLegacyUrnError, OrganizationNotFoundError } from './entityRef/errors.js';
import { concealRefEcho, refusalText } from './refEcho.js';

const SECRET = 'hdr_user_SECRET_5168_abcdef';

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected a throw');
}

/** The formatted wire error, as Apollo hands the original to `formatError` (wrapped in a GraphQLError). */
function wire(original: Error) {
  const wrapped = new GraphQLError(original.message, { originalError: original });
  return formatGraphQLError({ message: wrapped.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } }, wrapped);
}

const carries = (v: unknown) => JSON.stringify(v).includes('SECRET_5168');

describe('#5168: GraphQL formatter legs', () => {
  it('URN_NOT_QUALIFIED: code and expectedType kept, the value in neither the message nor the extensions', () => {
    const err = thrown(() => assertFullyQualifiedUrn(`  ${SECRET}  `, 'memory')) as UrnNotQualifiedError;
    expect(err).toBeInstanceOf(UrnNotQualifiedError);
    const out = wire(err);
    expect(out.extensions).toMatchObject({ code: 'URN_NOT_QUALIFIED', expectedType: 'memory' });
    expect(out.extensions).not.toHaveProperty('offendingValue');
    expect(carries(out)).toBe(false);
    // The remedy (the expected shape) survives the concealment.
    expect(out.message).toBe('The ref is not a fully qualified memory URN. Expected a memory URN with at least 2 hierarchy segments (org::memory, e.g., "acme.com::mmdata").');
  });

  it('a value containing the library phrase cannot shift the cut', () => {
    const tricky = `${SECRET}" is not fully qualified. x`;
    const out = wire(thrown(() => assertFullyQualifiedUrn(tricky, 'agent')) as Error);
    expect(carries(out)).toBe(false);
    expect(out.message.startsWith('The ref is not a fully qualified agent URN.')).toBe(true);
  });

  it('a URN parse error: BAD_USER_INPUT with its reason, no offending segment and no value', () => {
    const err = thrown(() => parseUrn(`hrn:${SECRET}`)) as UrnParseError;
    expect(err).toBeInstanceOf(UrnParseError);
    const out = wire(err);
    expect(out.extensions).toMatchObject({ code: 'BAD_USER_INPUT', reason: err.reason });
    expect(out.extensions).not.toHaveProperty('offendingValue');
    expect(carries(out)).toBe(false);
  });

  it('an entity not-found: its code, no ref extension, a fixed message', () => {
    const out = wire(new OrganizationNotFoundError(SECRET));
    expect(out.extensions).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
    expect(out.extensions).not.toHaveProperty('ref');
    expect(out.message).toBe('ORGANIZATION_NOT_FOUND: nothing found for the given ref.');
  });

  it('an ambiguous legacy URN: its code, no offendingValue, no value', () => {
    const out = wire(new AmbiguousLegacyUrnError(SECRET));
    expect(out.extensions).toMatchObject({ code: 'AmbiguousLegacyUrnError' });
    expect(out.extensions).not.toHaveProperty('offendingValue');
    expect(carries(out)).toBe(false);
  });
});

describe('#5168: MCP boundary legs', () => {
  it('toolErrorResult conceals before the tool closure reads the message', () => {
    const err = thrown(() => assertFullyQualifiedUrn(SECRET, 'node')) as Error;
    const res = toolErrorResult(err, () => `[urn_not_qualified] ${err.message}`, 'refEcho5168');
    expect(res.isError).toBe(true);
    expect(carries(res)).toBe(false);
  });

  it('withToolErrorBoundary rethrows a concealed refusal (the SDK serializes its message)', async () => {
    const boundary = withToolErrorBoundary('refEcho5168', () => assertFullyQualifiedUrn(SECRET, 'app'));
    const rejection = await boundary({}, {}).then(() => null, (e: unknown) => e);
    expect(rejection).toBeInstanceOf(UrnNotQualifiedError);
    expect((rejection as Error).message).not.toContain('SECRET_5168');
  });

  it('refusalText conceals both library refusals and leaves any other message as it is', () => {
    expect(refusalText(thrown(() => assertFullyQualifiedUrn(SECRET, 'secret')))).not.toContain('SECRET_5168');
    expect(refusalText(thrown(() => parseUrn(`hrn:${SECRET}`)))).not.toContain('SECRET_5168');
    expect(refusalText(new Error('plain text'))).toBe('plain text');
  });

  it('concealRefEcho also rewrites a wrapper that repeated the library message, and is idempotent', () => {
    const inner = thrown(() => assertFullyQualifiedUrn(SECRET, 'memory')) as Error;
    const outer = new GraphQLError(inner.message, { originalError: inner });
    concealRefEcho(outer);
    const once = outer.message;
    concealRefEcho(outer);
    expect(outer.message).toBe(once);
    expect(outer.message).not.toContain('SECRET_5168');
    expect(inner.message).toBe(outer.message);
  });
});

describe('#5168 fix head: the wrapper edge and the source-wide class (BLIND P2-1, P3)', () => {
  it('a wrapper still holding the quoted copy is rewritten after the inner refusal was concealed first', () => {
    const inner = thrown(() => assertFullyQualifiedUrn(SECRET, 'node')) as Error;
    const quoted = inner.message;
    concealRefEcho(inner); // e.g. the MCP boundary saw it first
    const outer = new GraphQLError(quoted, { originalError: inner });
    concealRefEcho(outer);
    expect(outer.message).toBe(inner.message);
    expect(outer.message).not.toContain('SECRET_5168');
  });

  /**
   * The door probe reaches GraphQL fields with a top-level ref; MCP handlers and refs inside input objects it does not.
   * This guard reads the source instead: no refusal text in the server quotes an interpolated value as the thing that
   * was not found. `src/lib/runner` is excluded (its errors go to the run's model, not a caller's terminal).
   */
  it('no not-found or no-match refusal in src quotes an interpolated value', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (!p.endsWith('/lib/runner') && !p.endsWith('/generated')) walk(p); continue; }
        if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) files.push(p);
      }
    };
    walk(root);
    const CLASS = [
      /`[A-Z][\w ]* "\$\{[^}`]+\}" not found/,
      /`[A-Z][\w ]* not found: \$\{[^}`]+\}`/,
      /`[A-Z][\w ]* \$\{[^}`]+\} not found\.?`/,
      /No match for [\w ]*"\$\{/,
      /No readable [\w ]*"\$\{/,
    ];
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n')
      .map((line, i) => ({ line, at: `${f.slice(root.length)}:${i + 1}` }))
      .filter(({ line }) => CLASS.some((re) => re.test(line)))
      .map(({ at, line }) => `${at} ${line.trim().slice(0, 120)}`));
    expect(hits).toEqual([]);
  });
});
