/**
 * GraphQL request admission, layers L1-L3 (hadron-internal#3): a bound on every
 * client-supplied document BEFORE any resolver runs.
 *
 *   L1  query source UTF-8 bytes   — this module's middleware (`/graphql`, GET + POST)
 *   L2  parser tokens              — Apollo `parseOptions.maxTokens` (graphql-js lexer cap)
 *   L3  expanded selections        — Apollo `maxRecursiveSelections` (document-level, fragments expanded)
 *
 * L1 counts the `query` string only. Variables stay under the 25 MB `/graphql`
 * JSON cap, so a small query carrying large content still works. Depth and cost
 * of the SELECTED operation (L4) are deliberately not here.
 *
 * Limits are fleet-wide deployment configuration. An unset variable takes the
 * default; a set one must be a positive integer, and anything else refuses boot
 * (no zero or "off" value: an operator raises a number instead).
 */
import type { NextFunction, Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import { formatGraphQLError } from './formatError.js';

export interface GraphqlAdmissionConfig {
  maxQueryBytes: number;
  maxTokens: number;
  maxSelections: number;
}

export const GRAPHQL_ADMISSION_DEFAULTS: GraphqlAdmissionConfig = {
  maxQueryBytes: 32 * 1024,
  maxTokens: 4000,
  maxSelections: 1000,
};

const ENV_NAMES = {
  maxQueryBytes: 'GRAPHQL_MAX_QUERY_BYTES',
  maxTokens: 'GRAPHQL_MAX_TOKENS',
  maxSelections: 'GRAPHQL_MAX_SELECTIONS',
} as const satisfies Record<keyof GraphqlAdmissionConfig, string>;

export const QUERY_TOO_LARGE = 'QUERY_TOO_LARGE';

/** Read the three limits; a malformed value throws (never echoing the value). */
export function readGraphqlAdmissionConfig(env: NodeJS.ProcessEnv = process.env): GraphqlAdmissionConfig {
  const out = { ...GRAPHQL_ADMISSION_DEFAULTS };
  for (const key of Object.keys(ENV_NAMES) as Array<keyof GraphqlAdmissionConfig>) {
    const raw = env[ENV_NAMES[key]];
    if (raw === undefined) continue;
    if (!/^[1-9][0-9]{0,14}$/.test(raw)) {
      throw new Error(`${ENV_NAMES[key]} must be a positive integer; refusing to boot.`);
    }
    out[key] = Number(raw);
  }
  return out;
}

/** The `query` strings this request supplies, as Apollo will read them. */
function suppliedQueries(req: Request): string[] {
  if (req.method === 'GET') {
    // Apollo reads `new URLSearchParams(url.parse(req.url).search)`; read the same source.
    const q = new URL(req.url, 'http://localhost').searchParams.getAll('query');
    return q;
  }
  const body: unknown = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const q = (body as { query?: unknown }).query;
    if (typeof q === 'string') return [q];
  }
  return [];
}

/**
 * L1: refuse a request whose query source exceeds `maxBytes` UTF-8 bytes, with
 * 413 and the ordinary GraphQL errors envelope. Fixed text: never echoes the
 * query or variables. Anything that is not a string `query` is left to Apollo.
 */
export function querySourceCap(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const q of suppliedQueries(req)) {
      // length is UTF-16 units; a unit is at most 3 UTF-8 bytes, so only measure when it could matter.
      if (q.length * 3 <= maxBytes || Buffer.byteLength(q, 'utf8') <= maxBytes) continue;
      const error = new GraphQLError('The GraphQL query is too large.', {
        extensions: { code: QUERY_TOO_LARGE, limit: 'bytes', max: maxBytes },
      });
      res.status(413).json({ errors: [formatGraphQLError(error.toJSON(), error)] });
      return;
    }
    next();
  };
}
