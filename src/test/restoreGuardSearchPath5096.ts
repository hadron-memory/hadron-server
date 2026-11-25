/**
 * #5096: a test that replays an OLD migration on its worker's database re-creates functions without their pinned search_path
 * (`CREATE OR REPLACE FUNCTION` with no SET clause resets it), and then restores the current invariants file. Restoring the
 * functions is not enough: the pins live in prisma/guard-search-path-invariants.sql, applied last, so call this after the
 * restore, or a later test file on the same worker database sees unpinned guards (src/lib/guardSearchPath5096.test.ts names them).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';

const GUARD_SEARCH_PATH_SQL = readFileSync(fileURLToPath(new URL('../../prisma/guard-search-path-invariants.sql', import.meta.url)), 'utf8');

export const restoreGuardSearchPath = (client: Pick<Client, 'query'>): Promise<unknown> => client.query(GUARD_SEARCH_PATH_SQL);
