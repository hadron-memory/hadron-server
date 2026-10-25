import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { LIVE_ORG_MEMBERSHIP } from '../lib/auth/liveOrgMembership.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { generateId } from '../lib/id.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify } from 'yaml';
import { createHash, randomBytes } from 'crypto';
import { APP_KEY_PREFIX } from '../middleware/auth.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { drainNodeUsage } from '../lib/usageRecorder.js';

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
  // #1189: a late batched usage INSERT takes FK locks on these parents and
  // can deadlock with their DELETE/SetNull cascades. Finish all recorder chunks
  // before deleting any fixture; deleting usage rows last alone is not enough.
  await drainNodeUsage(db);
  // #1631: test-only cleanup bypasses row-delete guards, before deleting owners.
  // #1632: signature records reference passkeys and requests; both refuse a row
  // DELETE while their node exists, so they are truncated with them.
  await db.$executeRawUnsafe('TRUNCATE TABLE node_signatures, signing_requests, passkey_credentials, worker_reference_fences, user_deletion_audits, agent_clone_audits CASCADE');
  // Pending first-party login states (FK-free; keyed on the OAuth state).
  await db.pendingLoginState.deleteMany();
  // #1079 — the URN alias map. Deliberately FK-FREE: it must outlive the row it
  // describes being hard-deleted, since a published URN keeps being followed
  // afterwards. That also means nothing below cascades it away, so it has to be
  // cleared explicitly or aliases leak between tests.
  await db.urnAlias.deleteMany();
  // #1667 — the public-link audit is FK-free (it outlives the asset), so nothing cascades it away.
  await db.assetPublicLinkAudit.deleteMany();
  // 036-ai-service-config: configs FK every owner level (incl.
  // hadron_server, which nothing below deletes) — clear them first.
  await db.aiServiceConfig.deleteMany();
  await db.hadronServer.deleteMany();
  // Spec 046 — usage metering (prices are FK-free; ledger FKs org only).
  await db.aiModelPrice.deleteMany();
  await db.creditLedgerEntry.deleteMany();
  // Spec 043 — Slack integration (receipts have no FK; connections FK org + app).
  await db.slackEventReceipt.deleteMany();
  await db.slackConnection.deleteMany();
  // hadrontool-mcp conduit registry (FKs org only).
  await db.mcpServer.deleteMany();
  // hadrontool-home-assistant registry (FKs org only).
  await db.homeAssistantInstance.deleteMany();
  // hadrontool-resend BYO sender registry (FKs org only).
  await db.resendSender.deleteMany();
  // General secret store (#677) — polymorphic owner, FK-free.
  await db.secret.deleteMany();
  // #1012 — durable per-client MCP selections. FKs user/app/memory, all of
  // which are deleted below, so it has to go first.
  await db.mcpSessionState.deleteMany();
  // Webfetch polling: receipts + origin bindings both FK AppRun.
  await db.webFetchEventReceipt.deleteMany();
  await db.webFetchPollBinding.deleteMany();
  // Spec 040 — headless-run tables (no FKs between them; order-free).
  await db.appRun.deleteMany();
  await db.agentSchedule.deleteMany();
  await db.agentWebhook.deleteMany();
  await db.quotaCounter.deleteMany();
  await db.actionTicket.deleteMany();
  // #1606 — comment nodes first: their governed edges refuse a delete while
  // the comment exists (prisma/comment-invariants.sql), and go with it.
  await db.node.deleteMany({ where: { nodeType: 'comment' } });
  await db.edge.deleteMany();
  await db.pendingEdge.deleteMany();
  await db.session.deleteMany();
  // #1705 — agent tasks reference workers and users (NO ACTION), so they go
  // before both. TRUNCATE, not deleteMany: the team event stream's trigger
  // refuses a row DELETE while its App exists (append-only), and TRUNCATE
  // fires no row triggers. #1706: agent_team_alarm_schedule references the events, so it is
  // truncated with them. #1708: so is worker_delivery_task_events, for the same reason.
  // #2022: a task's stop holds go with it.
  await db.$executeRawUnsafe('TRUNCATE worker_delivery_task_events, agent_team_alarm_schedule, agent_team_events, automation_adoption_events, agent_task_stop_holds, agent_tasks');
  // #974 Workers before agents: workers_agent_id_fkey is RESTRICT.
  await db.worker.deleteMany();
  await db.node.deleteMany();
  await db.agentMemoryItem.deleteMany();
  await db.appLogEntry.deleteMany();
  await db.appKey.deleteMany();
  // 008-agent-installation: AppAgent join is gone (App.agent_id is the FK).
  // New 008 joins clean up first to satisfy Restrict cascades on AgentImport.
  await db.appMember.deleteMany();
  await db.agentImport.deleteMany();
  await db.agentOrgGrant.deleteMany();
  await db.app.deleteMany();
  await db.agent.deleteMany();
  await db.memorySubscription.deleteMany();
  await db.memoryLicense.deleteMany();
  // Admin impersonation audit rows cascade from both User and Organization;
  // cleared explicitly before their parents to keep cleanup order predictable.
  await db.impersonationSession.deleteMany();
  await db.orgMember.deleteMany();
  // Assets mostly cascade from Memory below — but a STAGED asset has
  // `memoryId: null` (uploaded, not yet attached), so it has no parent to
  // cascade from and survived cleanDb entirely. One such row then leaked
  // into every later test in the same worker and broke the asset-count
  // assertions in storeTools/purge ("expected 1 to be +0"), which look
  // like flakes because they depend on which file ran first.
  await db.asset.deleteMany();
  await db.memory.deleteMany();
  await db.organization.deleteMany();
  // Spec 025-oauth-for-mcp credential models. AuthCode FKs to both
  // OAuthClient and User with onDelete: Cascade; UserApiKey FKs to
  // User. Delete authCode first to keep cascades predictable across
  // Postgres versions, then the parent rows.
  await db.authCode.deleteMany();
  await db.userApiKey.deleteMany();
  await db.oAuthClient.deleteMany();
  // EmailVerificationToken has no user FK (keyed on the email string), so
  // user.deleteMany() doesn't cascade to it — clear it explicitly or rows leak
  // across tests (#505/#511). authHandoffCode DOES cascade via its user FK.
  await db.emailVerificationToken.deleteMany();
  await db.userMergeConsent.deleteMany();
  // #772/#806: user-scoped dashboard widget placements + saved presets (both
  // cascade from user, but cleared explicitly to keep cleanup order predictable).
  await db.dashboardWidget.deleteMany();
  await db.dashboardWidgetPreset.deleteMany();
  await db.user.deleteMany();
  // #692: the principal pool. users/orgs FK it (onDelete SetNull), so it clears
  // last; otherwise reserved/tombstoned rows leak across tests and collide.
  await db.principal.deleteMany();
  // #1069 — usage events clear LAST, after every row they reference.
  //
  // They used to clear near the top, which opened a ~30-statement window in the
  // middle of this function: usage recording is FIRE-AND-FORGET
  // (`void db.usageEvent.createMany().catch()`), so a write from the previous
  // test could land after the usage wipe and before `node.deleteMany()` — too
  // late to be deleted, in time for the node FK's `SetNull` to blank its
  // `nodeId`. The next test then opened with stale `[null, null]` read events,
  // which is exactly what #1069 saw in CI.
  //
  // The initial drain now orders known operation-usage writes before cleanup
  // (#1189), including both fire-and-forget action-run writers. Keeping the
  // wipe last clears SetNull remnants of completed writes. It is NOT a barrier
  // for an untracked writer overlapping parent deletion: new asynchronous
  // usage producers must use trackUsageWrite and finish before this boundary.
  // Safe in this position because every UsageEvent FK is nullable
  // and `SetNull` — node, session, app, user, organization — and `memoryId` is a
  // denormalized column with no FK at all (#796).
  await db.usageEvent.deleteMany();
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
      class: 'knowledge',
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
    isRunnable?: boolean;
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
      ...(fields.isRunnable != null ? { isRunnable: fields.isRunnable } : {}),
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
 * Link an App to an Agent. The journey of this helper:
 *   - Pre-008: created an AppAgent join row.
 *   - 008-agent-installation: switched to setting App.agent_id (direct FK).
 *   - 023-app-shape Phase 2b: App.agent_id was dropped; back to creating an
 *     AppAgent join row. The legacy `role` arg is still accepted for source
 *     compat but ignored (DEVELOP-from-App stays gone). trainingMode is now
 *     per-App, not per-AppAgent, so the helper updates App.training_mode
 *     when the option is supplied.
 *
 * Returns the new AppAgent row.
 */
export async function createDbAppAgent(
  db: PrismaClient,
  appId: string,
  agentId: string,
  opts: {
    role?: 'OPERATE' | 'DEVELOP';
    trainingMode?: boolean;
  } = {},
) {
  void opts.role;
  if (opts.trainingMode !== undefined) {
    await db.app.update({
      where: { id: appId },
      data: { trainingMode: opts.trainingMode },
    });
  }
  return db.appAgent.create({
    data: { appId, agentId },
  });
}

/**
 * 008-agent-installation: insert an AppMember. Caller is responsible for
 * the role string being valid for the App's Agent's installationPolicy
 * (use ensureAppMember if you want validation).
 */
export async function createDbAppMember(
  db: PrismaClient,
  appId: string,
  userId: string,
  role: string = 'owner',
) {
  return db.appMember.create({
    data: { appId, userId, role },
  });
}

/**
 * 008-agent-installation: insert an AgentImport row directly. Bypasses the
 * publishAgentImport validation (grant check, 1-level enforcement) — useful
 * when seeding fixtures where you want to assert *post-publish* behavior
 * without going through the resolver. For tests that exercise the
 * validation, call the resolver / `publishAgentImport` helper instead.
 *
 * Caller is responsible for the AgentOrgGrant existing — the FK requires it.
 */
export async function createDbAgentImport(
  db: PrismaClient,
  parentAgentId: string,
  importedAgentId: string,
  opts: { position?: number; required?: boolean } = {},
) {
  // Look up the parent agent's owning org to derive the grant FK.
  const parent = await db.agent.findUniqueOrThrow({
    where: { id: parentAgentId },
    select: { organizationId: true },
  });
  if (!parent.organizationId) {
    throw new Error('createDbAgentImport requires an org-owned parent Agent (AgentOrgGrant is org-scoped).');
  }
  return db.agentImport.create({
    data: {
      parentAgentId,
      importedAgentId,
      position: opts.position ?? 100,
      required: opts.required ?? true,
      agentOrgGrantOrgId: parent.organizationId,
      agentOrgGrantAgentId: importedAgentId,
    },
  });
}

/**
 * 008-agent-installation: insert an AgentOrgGrant. Defaults match the v1
 * lifecycle (activated immediately, no expiry, not revoked) — same shape
 * as createDbAgentSubscription.
 */
export async function createDbAgentOrgGrant(
  db: PrismaClient,
  orgId: string,
  agentId: string,
  opts: {
    activatedAt?: Date | null;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
  } = {},
) {
  return db.agentOrgGrant.create({
    data: {
      orgId,
      agentId,
      activatedAt: opts.activatedAt === undefined ? new Date() : opts.activatedAt,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    },
  });
}

/**
 * Insert a test AgentSubscription. Defaults match the v1 lifecycle
 * (activated immediately on creation; no expiry; not revoked).
 */
export async function createDbAgentSubscription(
  db: PrismaClient,
  userId: string,
  agentId: string,
  opts: {
    activatedAt?: Date | null;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
  } = {},
) {
  return db.agentSubscription.create({
    data: {
      user: { connect: { id: userId } },
      agent: { connect: { id: agentId } },
      activatedAt: opts.activatedAt === undefined ? new Date() : opts.activatedAt,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    },
  });
}

/**
 * Insert a test personal-class Memory owned by a User. Sets the
 * required class+visibility+userId combo per the bidirectional
 * invariant.
 *
 * 008-agent-installation: personal-class memories address on
 * (app_id, user_id). The chk_memory_class_app_id constraint requires
 * a non-NULL app_id when class IN ('app', 'personal'). Pass `appId`
 * to set it explicitly; if omitted, the helper looks up an App for
 * the agent in the same org and uses that. Tests that don't have an
 * App set up should pass appId explicitly.
 */
export async function createDbPersonalMemory(
  db: PrismaClient,
  opts: {
    userId: string;
    organizationId: string;
    agentId: string;
    name?: string;
    appId?: string;
  },
) {
  const name = opts.name ?? `personal-${opts.userId}-${opts.agentId}`;
  let appId = opts.appId ?? null;
  if (!appId) {
    // Personal memory pivots on (app_id, user_id) — the App can live in any
    // org (cross-org case: Alice's personal-alice org holds the memory; the
    // delivering App lives in OrgA). Look up by AppAgent join (023-app-shape
    // Phase 2b: App.agent_id is gone), preferring the memory's own org if
    // any match exists. Order by AppAgent.createdAt asc so the chosen
    // appId is deterministic when multiple Apps install the same Agent.
    const sameOrg = await db.appAgent.findFirst({
      where: {
        agentId: opts.agentId,
        app: { organizationId: opts.organizationId, deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { appId: true },
    });
    appId = sameOrg?.appId ?? null;
    if (!appId) {
      const anyOrg = await db.appAgent.findFirst({
        where: { agentId: opts.agentId, app: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        select: { appId: true },
      });
      appId = anyOrg?.appId ?? null;
    }
  }
  if (!appId) {
    throw new Error(
      'createDbPersonalMemory: no App found for the agent and none was passed. Personal-class memory requires app_id post-008. Pass `appId` explicitly or seed an App linking the same agent.',
    );
  }
  return db.memory.create({
    data: {
      id: generateId(),
      organizationId: opts.organizationId,
      urn: `${opts.organizationId}:${name}`,
      name,
      userId: opts.userId,
      userMemoryOfAgentId: opts.agentId,
      appId,
      class: 'personal',
      visibility: null,
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
  /** Paragraph-length summary. Spec 031. */
  abstract?: string | number;
  alias?: string;
  tags?: string[];
  nodes?: Array<{ id: string; rel: string }>;
  /** #1348: the collection discriminator; null/blank to exercise the no-opinion forms. */
  objectType?: string | null;
  /** #1348: a governed signal, to pin that objectType handling leaves it alone. */
  role?: string;
  /** #1330: the other governed signal — a runnable node is exempt from strictSubRoles. */
  isRunnable?: boolean;
  placeholder?: boolean;
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

/**
 * Fetch a chat-root node by its chatId — which IS its loc — asserting the loc
 * is unambiguous (#828).
 *
 * Mirrors production's `exactlyOneChatNode`. `loc` is unique per MEMORY, not
 * globally, so `findFirst` here would silently pick a row if a fixture ever
 * created the same chat loc twice. A chat loc is
 * `chats:<ts>-<8 hex>-<name>`, so a collision means the FIXTURE is wrong — and
 * that is precisely the kind of thing a test should shout about rather than
 * paper over.
 *
 * Returns null when nothing matched, so a caller can assert absence.
 */
export async function chatNodeByLoc(
  db: PrismaClient,
  chatId: string,
  opts: { includeDeleted?: boolean } = {},
) {
  const rows = await db.node.findMany({
    // loc-scope-ok: deliberately not narrowed — a test rarely holds the chat's
    // holding memory (startChat picks it). Uniqueness is ASSERTED below instead,
    // which is the property the test actually depends on.
    where: { loc: chatId, ...(opts.includeDeleted ? {} : { deletedAt: null }) },
    take: 2,
  });
  if (rows.length > 1) {
    throw new Error(
      `Fixture bug: chat loc "${chatId}" matches ${rows.length} nodes. ` +
        `Chat locs are expected to be unique; a test asserting on "the" chat ` +
        `node would otherwise pick one arbitrarily.`,
    );
  }
  return rows[0] ?? null;
}

/** `chatNodeByLoc` for the common case where the chat must exist. */
export async function chatNodeByLocOrThrow(
  db: PrismaClient,
  chatId: string,
  opts: { includeDeleted?: boolean } = {},
) {
  const node = await chatNodeByLoc(db, chatId, opts);
  if (!node) throw new Error(`No chat node at loc "${chatId}"`);
  return node;
}

/** #1162: attribution fixtures must name a real Worker, not an invented audit id. */
export async function createDbWorkerAttribution(db: PrismaClient, userId: string, workerId: string, sessionId?: string): Promise<void> {
  const suffix = generateId();
  const membership = await db.orgMember.findFirst({ where: { userId, ...LIVE_ORG_MEMBERSHIP } });
  const ownership = membership ? { organizationId: membership.organizationId } : { ownerUserId: userId };
  const agent = await db.agent.create({ data: { ...ownership, name: 'Attribution fixture', urn: `fixture-${suffix}.example:role` } });
  const app = await db.app.create({ data: { ...ownership, name: 'Attribution fixture', urn: `fixture-${suffix}.example:app` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: workerId, appId: app.id, agentId: agent.id, name: 'Fixture', slug: 'fixture' } });
  if (sessionId) await db.session.create({ data: { id: sessionId, workerId, userId, appId: app.id } });
}

/**
 * Fixture: leave nodes tombstoned the way an earlier soft delete left them,
 * without going through the delete door. The generic delete refuses a governed
 * node (a `spec`, `review` or runnable task), so a test that needs "a deleted
 * spec" as its starting state builds that state directly.
 */
export async function tombstoneNodes(db: PrismaClient, ids: readonly string[]): Promise<void> {
  await db.node.updateMany({ where: { id: { in: [...ids] }, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: null } });
}
