/**
 * #2027 (Messaging S11): the attention API is RETIRED — the poll (`teamAttention`,
 * itself UPGRADE_REQUIRED since #1384), the paged successor (`teamAttentionPage`),
 * and the switchover (preview page, v1 preview, proof, confirm): their GraphQL
 * fields and output types, resolver entries, MCP tool registrations, and the
 * scan engine + continuation codec behind them are gone. What STAYS, on purpose,
 * is everything the live marks/wakes path shares the module with: the explicit
 * `markOwnTeamChatRead` mutation, the read-cursor advance machinery, the
 * lapsed-session resume rules, the incarnation fence, `mayStillDriveWorkerApp`
 * and the wake-proof secret (which is why `workerProofSecret` survives).
 *
 * RED on main (the API is still served); GREEN only when the removal is real.
 */
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildSchema } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';

const RETIRED_QUERIES = [
  'teamAttention',
  'teamAttentionPage',
  'teamAttentionPreviewPage',
  'teamAttentionSwitchoverPreview',
] as const;
const RETIRED_MUTATION = 'confirmTeamAttentionSwitchover';
const RETIRED_TYPES = [
  'TeamAttentionResult',
  'TeamAttentionChannel',
  'TeamAttentionWorker',
  'TeamAttentionSwitchoverChannel',
  'TeamAttentionSwitchoverWorker',
  'TeamAttentionSwitchoverPreview',
  'TeamAttentionPage',
  'TeamAttentionPageItem',
  'TeamAttentionPreviewPage',
  'TeamAttentionSwitchoverResult',
] as const;

function containsIdentifier(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source);
}

/** The #3082 source-pin pattern: strip comment lines, then match — a retirement
 * note in a comment must not read as a live registration. */
function sourceWithoutComments(path: string): string {
  return fs
    .readFileSync(new URL(path, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

describe('#2027 S11: the attention API is retired', () => {
  it('recognizes a retired identifier but not a longer near-miss', () => {
    expect(containsIdentifier('export const teamAttentionPage = 1', 'teamAttentionPage')).toBe(true);
    expect(containsIdentifier('export const teamAttentionPageSize = 1', 'teamAttentionPage')).toBe(false);
  });
  it('the GraphQL schema has no attention query, mutation or output type', () => {
    const schema = buildSchema(typeDefs);
    const queries = Object.keys(schema.getQueryType()!.getFields());
    for (const name of RETIRED_QUERIES) expect(queries, name).not.toContain(name);
    const mutations = Object.keys(schema.getMutationType()!.getFields());
    expect(mutations).not.toContain(RETIRED_MUTATION);
    const types = Object.keys(schema.getTypeMap());
    for (const name of RETIRED_TYPES) expect(types, name).not.toContain(name);
  });

  it('the resolver map has no attention entry (markOwnTeamChatRead stays)', () => {
    for (const name of RETIRED_QUERIES) expect(resolvers.Query, name).not.toHaveProperty(name);
    expect(resolvers.Mutation).not.toHaveProperty(RETIRED_MUTATION);
  });

  it('no MCP tool registration names hadron_team_attention* (deleted, not just #3082-disabled)', () => {
    const src = sourceWithoutComments('../../../mcp/server.ts');
    expect(src).not.toMatch(/\bhadron_team_attention\w*/);
  });

  it('the paged-attention scan codec and the poll entry points are deleted', () => {
    expect(fs.existsSync(new URL('../../../lib/teamAttentionPage.ts', import.meta.url))).toBe(false);
    const lib = sourceWithoutComments('../../../lib/ownWorkerSessions.ts');
    for (const gone of [
      'getTeamAttention',
      'teamAttentionPage',
      'teamAttentionPreviewPage',
      'previewTeamAttentionSwitchover',
      'confirmTeamAttentionSwitchover',
    ]) {
      expect(containsIdentifier(lib, gone), gone).toBe(false);
    }
  });
});
