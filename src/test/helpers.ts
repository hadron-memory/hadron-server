import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { generateId } from '../lib/id.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify } from 'yaml';
import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { APP_KEY_PREFIX } from '../middleware/auth.js';
import type { PrismaClient } from '../generated/prisma/index.js';

// Known raw API key used in auth tests (64 hex-like chars, no dots)
export const TEST_RAW_KEY = 'a'.repeat(64);

/** Build a deterministic test App key with the canonical `hdr_app_` prefix. */
export function buildAppKey(suffix?: string): string {
  const body = suffix ?? randomBytes(32).toString('hex');
  return `${APP_KEY_PREFIX}${body}`;
}

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
  await db.pendingEdge.deleteMany();
  await db.session.deleteMany();
  await db.node.deleteMany();
  await db.stationAgentSubscription.deleteMany();
  await db.agentMemoryItem.deleteMany();
  await db.appLogEntry.deleteMany();
  await db.appKey.deleteMany();
  await db.appAgent.deleteMany();
  await db.app.deleteMany();
  await db.agent.deleteMany();
  await db.memorySubscription.deleteMany();
  await db.memoryLicense.deleteMany();
  await db.station.deleteMany();
  await db.orgMember.deleteMany();
  await db.memory.deleteMany();
  await db.organization.deleteMany();
  await db.user.deleteMany();
}

/**
 * Create a test Organization + Memory for use in node tests.
 */
export async function createDbOrgAndGraph(
  db: PrismaClient,
  opts: { orgName?: string; graphName?: string; visibility?: string } = {},
) {
  const org = await db.organization.create({
    data: {
      id: generateId(),
      name: opts.orgName ?? 'test-org',
      urn: opts.orgName ?? 'test-org',
    },
  });
  const memName = opts.graphName ?? 'test/repo';
  const graph = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${opts.orgName ?? 'test-org'}:${memName}`,
      name: memName,
      ...(opts.visibility ? { visibility: opts.visibility as any } : {}),
    },
  });
  return { org, graph };
}

/**
 * Insert a test Node record with sensible defaults.
 */
export async function createDbNode(
  db: PrismaClient,
  fields: {
    id?: string;
    loc: string;
    name?: string;
    ownerRepo?: string;
    memoryId: string;
    tags?: string[];
    content?: string;
  },
) {
  const loc = fields.loc;
  return db.node.create({
    data: {
      id: fields.id ?? generateId(),
      memoryId: fields.memoryId,
      loc,
      name: fields.name ?? loc,
      ownerRepo: fields.ownerRepo ?? 'test/repo',
      tags: fields.tags ?? [],
      content: fields.content ?? null,
    },
  });
}

/**
 * Insert a test Station record with a known raw key + bcrypt hash.
 */
export async function createDbStation(
  db: PrismaClient,
  name: string,
  role: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER' = 'READER',
  opts: { expiresAt?: Date; organizationId?: string; userId?: string } = {},
) {
  const keyHash = await bcrypt.hash(TEST_RAW_KEY, 4); // low cost for speed
  return db.station.create({
    data: {
      id: generateId(),
      name,
      urn: name,
      keyHash,
      role,
      stationType: 'WORKSTATION',
      expiresAt: opts.expiresAt ?? null,
      organizationId: opts.organizationId ?? null,
      userId: opts.userId ?? null,
    },
  });
}

/**
 * Insert a test App + AppKey, returning both plus the raw key. The raw key
 * is what callers send in the Authorization: Bearer header during tests;
 * the stored hash is SHA-256 of the raw key (matching the resolver).
 */
export async function createDbAppWithKey(
  db: PrismaClient,
  name: string,
  organizationId: string,
  opts: { rawKey?: string } = {},
): Promise<{
  app: Awaited<ReturnType<PrismaClient['app']['create']>>;
  appKey: Awaited<ReturnType<PrismaClient['appKey']['create']>>;
  rawKey: string;
}> {
  const rawKey = opts.rawKey ?? buildAppKey();
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const app = await db.app.create({
    data: {
      id: generateId(),
      name,
      urn: `${organizationId}:${name}`,
      organizationId,
    },
  });
  const appKey = await db.appKey.create({
    data: {
      id: generateId(),
      appId: app.id,
      keyHash,
      keyPreview: rawKey.slice(-4),
    },
  });
  return { app, appKey, rawKey };
}

/**
 * Link an App to an Agent through an AppAgent join row.
 * Defaults match the schema (role=OPERATE, subscription_type=READ_ONLY).
 */
export async function createDbAppAgent(
  db: PrismaClient,
  appId: string,
  agentId: string,
  opts: {
    role?: 'OPERATE' | 'DEVELOP';
    subscriptionType?: 'READ_ONLY' | 'READ_WRITE';
    trainingMode?: boolean;
  } = {},
) {
  return db.appAgent.create({
    data: {
      appId,
      agentId,
      role: opts.role ?? 'OPERATE',
      subscriptionType: opts.subscriptionType ?? 'READ_ONLY',
      trainingMode: opts.trainingMode ?? false,
    },
  });
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hadron-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface NodeMeta {
  id?: string;
  name: string;
  description?: string;
  summary?: string;
  alias?: string;
  tags?: string[];
  nodes?: Array<{ id: string; rel: string }>;
}

/** Write a legacy node (`.node/node.yaml` + `topic.md`). */
export function writeNodeFiles(dir: string, meta: NodeMeta, content?: string): void {
  const nodeDir = join(dir, '.node');
  mkdirSync(nodeDir, { recursive: true });
  const withId = { id: generateId(), ...meta };
  writeFileSync(join(nodeDir, 'node.yaml'), stringify(withId), 'utf-8');
  if (content !== undefined) {
    writeFileSync(join(nodeDir, 'topic.md'), content, 'utf-8');
  }
}

interface EdgeEntry {
  target: string;
  rel: string;
  id?: string;
}

/** Write a frontmatter markdown node (Obsidian vault format). */
export function writeFrontmatterNode(
  filePath: string,
  meta: NodeMeta,
  content?: string,
  edges?: EdgeEntry[],
): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  const withId = { id: generateId(), ...meta };
  const frontmatter = stringify(withId, { lineWidth: 0 }).trim();
  const body = content ?? '';
  writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');

  // Write sidecar edges if provided
  if (edges?.length) {
    const fileName = filePath.replace(/\.md$/, '');
    const baseName = fileName.split('/').pop()!;
    const sidecarDir = baseName === 'README'
      ? join(filePath, '..', '..', '.' + filePath.split('/').slice(-2, -1)[0])
      : join(filePath, '..', '.' + baseName);
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, 'edges.yaml'), stringify(edges), 'utf-8');
  }
}
