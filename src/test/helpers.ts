import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify } from 'yaml';
import bcrypt from 'bcrypt';
import type { PrismaClient } from '../generated/prisma/index.js';

// Known raw API key used in auth tests (64 hex-like chars, no dots)
export const TEST_RAW_KEY = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Delete all rows from every table in FK-safe order.
 * Call in beforeEach for DB tests.
 */
export async function cleanDb(db: PrismaClient): Promise<void> {
  await db.usageEvent.deleteMany();
  await db.edge.deleteMany();
  await db.session.deleteMany();
  await db.node.deleteMany();
  await db.client.deleteMany();
  await db.user.deleteMany();
}

/**
 * Insert a test Node record with sensible defaults.
 */
export async function createDbNode(
  db: PrismaClient,
  fields: {
    loc: string;
    name?: string;
    namespace?: string;
    ownerRepo?: string;
    tags?: string[];
    content?: string;
  },
) {
  const loc = fields.loc;
  const namespace = fields.namespace ?? loc.split('.').slice(0, 2).join('.');
  return db.node.create({
    data: {
      loc,
      name: fields.name ?? loc,
      namespace,
      ownerRepo: fields.ownerRepo ?? 'test/repo',
      tags: fields.tags ?? [],
      content: fields.content ?? null,
    },
  });
}

/**
 * Insert a test Client record with a known raw key + bcrypt hash.
 * Returns the raw key (TEST_RAW_KEY) so tests can use it directly.
 */
export async function createDbClient(
  db: PrismaClient,
  label: string,
  role: 'ADMIN' | 'CONTRIBUTOR' | 'READER' = 'READER',
  opts: { namespace?: string; expiresAt?: Date } = {},
) {
  const keyHash = await bcrypt.hash(TEST_RAW_KEY, 4); // low cost for speed
  return db.client.create({
    data: {
      label,
      keyHash,
      role,
      type: 'WORKSTATION',
      namespace: opts.namespace ?? null,
      expiresAt: opts.expiresAt ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp directory, return its path and a cleanup function.
 */
export function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hadron-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface NodeMeta {
  name: string;
  description?: string;
  summary?: string;
  alias?: string;
  tags?: string[];
  nodes?: Array<{ loc: string; rel: string }>;
}

/**
 * Write `.node/node.yaml` (and optionally `topic.md`) inside `dir`.
 * `dir` is the node's directory (not the `.node/` subdirectory).
 */
export function writeNodeFiles(dir: string, meta: NodeMeta, content?: string): void {
  const nodeDir = join(dir, '.node');
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, 'node.yaml'), stringify(meta), 'utf-8');
  if (content !== undefined) {
    writeFileSync(join(nodeDir, 'topic.md'), content, 'utf-8');
  }
}
