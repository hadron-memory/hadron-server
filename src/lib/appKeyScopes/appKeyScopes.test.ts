import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1749 — Tickers S3 (epic #1659): App key scopes, `attention:deliver` for team routers, and the
 * session-bound refusal. Acceptance list of the issue, one block per heading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { teamChatMutations } from '../../api/graphql/schema/resolvers.teamChat.js';
import { APP_KEY_PREFIX, hashAppKey, resolveAuthContext } from '../../middleware/auth.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import type { AuthContext } from '../../middleware/auth.js';
import { emptyActor, requestActorStorage } from '../requestActor.js';
import { randomBytes } from 'node:crypto';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const AppKeyF = (resolvers as any).AppKey;

const userCtx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return (e as GraphQLError).extensions?.code as string; }
  return undefined;
}

let org: { id: string; urn: string };
let manager: { id: string };
let holder: { id: string };
let member: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let liam: { id: string };
let post: ReturnType<typeof vi.spyOn>;
let key: { id: string; raw: string };

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 98_000 + n, githubUsername: `ak-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });
}
async function mkKey(appId: string, label = 'router') {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const row = await db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label } });
  return { id: row.id, raw };
}
/** What the middleware builds for a bare App key. */
const keyCtx = (k: { id: string }, appId: string, extra: Partial<Context> = {}): Context =>
  ({ db, appId, appKeyId: k.id, organizationId: org.id, roles: [], ...extra }) as Context;
const grant = (k: { id: string }, scope = 'attention:deliver', by = manager.id) =>
  db.appKeyScope.create({ data: { id: generateId(), appKeyId: k.id, scope, grantedByUserId: by } });
async function mkChannel(memoryId: string, loc: string, createdBy: string) {
  const made = await ensureChannelWithRoot(db, { memoryId, loc, name: loc, createdBy });
  return { id: made.channel.id, memoryId, loc, chatRootNodeId: made.rootId };
}
async function say(ch: typeof channel, body: string, data: Record<string, unknown> = {}) {
  const enc = await getMemoryEncryptionInfo(db, ch.memoryId);
  return appendChatMessage(db, { id: ch.chatRootNodeId, memoryId: ch.memoryId, loc: ch.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: ch.memoryId, loc: `${ch.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: ch.id, content: body, data: { mentions: [], ...data } } }),
    { asChannel: true });
}
const mention = (...mentions: string[]) => ({ mentions });
const due = (c: Context, extra: Record<string, unknown> = {}) => Q.dueWakes({}, { appRef: app.id, ...extra }, c);
const ack = (c: Context, proofs: string[]) => M.acknowledgeWakes({}, { proofs }, c);

function holdOpen(work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const locked = new Promise<void>((r) => { ready = r; });
  const done = db.$transaction(async (tx) => { await work(tx); ready(); await gate; });
  return { locked, release, done };
}
async function stillWaiting(p: Promise<unknown>, h: { release: () => void }, ms = 500): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise((r) => setTimeout(r, ms));
    return !settled;
  } finally {
    h.release();
  }
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'ak-org', urn: `ak-org-${suffix}.com` } });
  [manager, holder, member] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  for (const u of [holder, member]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  channel = await mkChannel(memory.id, 'chats:team', manager.id);
  liam = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Liam', slug: 'liam', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: liam.id, role: 'BOTH' } });
  key = await mkKey(app.id);
  post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never);
});
afterEach(() => post.mockRestore());

describe('the scope primitive', () => {
  it('a new key holds nothing; the manager grants and revokes; the list shows live scopes', async () => {
    expect(await db.appKeyScope.count()).toBe(0);
    const k = await M.grantAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id));
    expect(k.id).toBe(key.id);
    const shown = await AppKeyF.scopes({ id: key.id, appId: app.id }, {}, userCtx(manager.id));
    expect(shown.map((s: any) => [s.scope, s.grantedByUserId])).toEqual([['attention:deliver', manager.id]]);
    // Granting again changes nothing: one live row, the first grant's record.
    await M.grantAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id));
    expect(await db.appKeyScope.count()).toBe(1);
    await M.revokeAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id));
    expect(await AppKeyF.scopes({ id: key.id, appId: app.id }, {}, userCtx(manager.id))).toEqual([]);
    const row = await db.appKeyScope.findFirstOrThrow();
    expect(row.revokedByUserId).toBe(manager.id);
    expect(row.revokedAt).not.toBeNull();
    // A revoked scope can be given again: a new row, the old one stays as the record.
    await M.grantAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id));
    expect(await db.appKeyScope.count()).toBe(2);
    expect(await db.appKeyScope.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('an unknown scope is refused, and so is a revoked or foreign key', async () => {
    // #1709: host:operate exists now, but only for a named host.
    expect(await code(M.grantAppKeyScope({}, { id: key.id, scope: 'host:operate' }, userCtx(manager.id)))).toBe('BAD_USER_INPUT');
    expect(await code(M.grantAppKeyScope({}, { id: key.id, scope: '*' }, userCtx(manager.id)))).toBe('BAD_USER_INPUT');
    expect(await db.appKeyScope.count()).toBe(0);
    await db.appKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    expect(await code(M.grantAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id)))).toBe('APP_KEY_NOT_FOUND');
    expect(await code(M.grantAppKeyScope({}, { id: 'nope', scope: 'attention:deliver' }, userCtx(manager.id)))).toBe('APP_KEY_NOT_FOUND');
  });

  it('only whoever manages the App: a holder, a plain member, an outsider, an App key and an impersonation are all refused', async () => {
    const outsider = await mkUser(9);
    const args = { id: key.id, scope: 'attention:deliver' };
    expect(await code(M.grantAppKeyScope({}, args, userCtx(holder.id)))).toBe('FORBIDDEN');
    expect(await code(M.grantAppKeyScope({}, args, userCtx(member.id)))).toBe('FORBIDDEN');
    expect(await code(M.grantAppKeyScope({}, args, userCtx(outsider.id)))).toBe('APP_KEY_NOT_FOUND');
    // The key itself, even a scoped one, cannot give itself or another key anything.
    await grant(key);
    const other = await mkKey(app.id, 'other');
    expect(await code(M.grantAppKeyScope({}, { id: other.id, scope: 'attention:deliver' }, keyCtx(key, app.id)))).toBe('APP_KEY_NOT_FOUND');
    expect(await code(M.revokeAppKeyScope({}, args, keyCtx(key, app.id)))).toBe('APP_KEY_NOT_FOUND');
    expect(await code(M.grantAppKeyScope({}, { id: other.id, scope: 'attention:deliver' }, userCtx(manager.id, { impersonation: { adminUserId: 'x' } } as any)))).toBeDefined();
    expect(await db.appKeyScope.count({ where: { appKeyId: other.id } })).toBe(0);
    expect(await db.appKeyScope.count({ where: { appKeyId: key.id, revokedAt: null } })).toBe(1);
  });

  it('a worker\'s session, even its manager-holder\'s, does not manage', async () => {
    const mgrWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Boss', slug: 'boss', heldByUserId: manager.id, heldAt: new Date() }, select: { id: true } });
    const { runAsActor } = await import('../requestActor.js');
    const c = await runAsActor({ workerId: mgrWorker.id, agentId: agent.id }, () => code(M.grantAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id))));
    expect(c).toBeDefined();
    expect(await db.appKeyScope.count()).toBe(0);
  });

  it('the scope list is for whoever manages the App even when the key is reached another way', async () => {
    await grant(key);
    expect(await code(AppKeyF.scopes({ id: key.id, appId: app.id }, {}, userCtx(holder.id)))).toBe('FORBIDDEN');
    expect(await code(AppKeyF.scopes({ id: key.id, appId: app.id }, {}, keyCtx(key, app.id)))).toBe('FORBIDDEN');
  });

  it('a rotated key starts with none, and the old key\'s scope is dead', async () => {
    await grant(key);
    const rotated = await M.regenerateAppKey({}, { appRef: app.id }, userCtx(manager.id));
    const fresh = await db.appKey.findFirstOrThrow({ where: { appId: app.id, revokedAt: null } });
    expect(fresh.id).not.toBe(key.id);
    expect(await db.appKeyScope.count({ where: { appKeyId: fresh.id } })).toBe(0);
    expect(rotated.rawKey).toBeTruthy();
    await grant(fresh);
    // The revoked old key holds nothing now, scope row or not.
    expect(await code(due(keyCtx(key, app.id)))).toBe('APP_KEY_SCOPE_REQUIRED');
  });

  it('the middleware names the key: appKeyId is set for an App key and for nothing else', async () => {
    const reqOf = (auth: string) => ({ headers: { authorization: auth } }) as any;
    const resolved = await requestActorStorage.run(emptyActor(), () => resolveAuthContext(reqOf(`Bearer ${key.raw}`), db));
    expect(resolved).toMatchObject({ appId: app.id, appKeyId: key.id });
    expect((resolved as AuthContext).userId).toBeUndefined();
  });
});

describe('the invariants file', () => {
  it('the migration carries a byte-identical copy and post-push includes it', () => {
    const source = readFileSync(new URL('../../../prisma/app-key-scope-invariants.sql', import.meta.url), 'utf8');
    // #1709: the newest migration that carries the file (host:operate added to the closed list).
    const migration = readFileSync(new URL('../../../prisma/migrations/20261014010100_host_operate_scope/migration.sql', import.meta.url), 'utf8');
    // Exactly the file, set off from the generated DDL above it by one blank line: nothing else may sit between.
    expect(migration.endsWith(`\n${source}`)).toBe(true);
    expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir app-key-scope-invariants.sql');
  });

  it('the migration APPLIES: every statement runs, on a database that has only what it builds on (Rook, Chip, Riana #1781)', async () => {
    const sql = readFileSync(new URL('../../../prisma/migrations/20261011190000_app_key_scopes/migration.sql', import.meta.url), 'utf8');
    // A containment check passed over two stray lines of shell output that no database accepts; running the file is the proof.
    const statements = sql
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
      .split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
    const ranOk = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE SCHEMA mig_check_1749');
      await tx.$executeRawUnsafe('SET LOCAL search_path TO mig_check_1749');
      await tx.$executeRawUnsafe('CREATE TABLE app_keys (id TEXT PRIMARY KEY)');
      for (const st of statements) await tx.$executeRawUnsafe(st);
      const made = await tx.$queryRawUnsafe<Array<{ n: string }>>(
        "SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'mig_check_1749' ORDER BY 1");
      // Roll back so the scratch schema never outlives the test.
      throw Object.assign(new Error('rollback'), { made: made.map((r) => r.n) });
    }).catch((e) => e);
    expect(ranOk.message).toBe('rollback');
    expect(ranOk.made).toEqual(['app_key_scopes', 'app_key_wake_reads', 'app_keys']);
  });

  it('a key holds a scope at most once while it is live, and only from the closed list', async () => {
    await grant(key);
    await expect(grant(key)).rejects.toThrow(/Unique constraint|app_key_scopes_live_uniq/);
    await expect(grant(await mkKey(app.id, 'b'), 'shell')).rejects.toThrow(/chk_app_key_scopes_shape/);
    // #1709: host:operate is bound to exactly one host, and no other scope names one.
    await expect(grant(await mkKey(app.id, 'c'), 'host:operate')).rejects.toThrow(/chk_app_key_scopes_shape/);
    const hostKey = await mkKey(app.id, 'd');
    await expect(db.appKeyScope.create({ data: { id: generateId(), appKeyId: hostKey.id, scope: 'host:operate', grantedByUserId: manager.id, hostId: 'orca1' } })).resolves.toBeTruthy();
    await expect(db.appKeyScope.create({ data: { id: generateId(), appKeyId: (await mkKey(app.id, 'e')).id, scope: 'attention:deliver', grantedByUserId: manager.id, hostId: 'orca1' } }))
      .rejects.toThrow(/chk_app_key_scopes_shape/);
    await expect(db.appKeyScope.create({ data: { id: generateId(), appKeyId: (await mkKey(app.id, 'f')).id, scope: 'host:operate', grantedByUserId: manager.id, hostId: '-rf' } }))
      .rejects.toThrow(/chk_app_key_scopes_shape/);
    await expect(db.appKeyScope.updateMany({ data: { revokedAt: new Date() } })).rejects.toThrow(/chk_app_key_scopes_shape/);
  });
});

describe('attention:deliver — the key at dueWakes', () => {
  beforeEach(async () => { await say(channel, 'for liam', mention('liam')); });

  it('without the scope: APP_KEY_SCOPE_REQUIRED, and nothing is audited', async () => {
    expect(await code(due(keyCtx(key, app.id)))).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await code(ack(keyCtx(key, app.id), ['x']))).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await db.appKeyWakeRead.count()).toBe(0);
  });

  it('with it: its own App\'s workers, one audit row naming the key, and the key can acknowledge', async () => {
    await grant(key);
    const page = await due(keyCtx(key, app.id));
    expect(page.wakes.map((w: any) => w.worker.id)).toEqual([liam.id]);
    const reads = await db.appKeyWakeRead.findMany();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ appKeyId: key.id, appId: app.id, workerCount: 1 });
    expect(await ack(keyCtx(key, app.id), page.wakes.map((w: any) => w.proof))).toEqual({ acknowledged: 1, unchanged: 0 });
    // #2072 (R53): the wake's receipt names the key; no message mark is written.
    const delivered = await db.workerWakeAck.findFirstOrThrow({ where: { workerId: liam.id } });
    expect(delivered.ackedByAppKeyId).toBe(key.id);
    expect(delivered.ackedByUserId).toBeNull();
    // A second read is a second row.
    await due(keyCtx(key, app.id));
    expect(await db.appKeyWakeRead.count()).toBe(2);
  });

  it('a foreign App\'s key with the scope is refused, and a foreign App is never returned', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    const foreign = await mkKey(other.id);
    await grant(foreign);
    expect(await code(due(keyCtx(foreign, other.id)))).toBe('APP_NOT_FOUND');
    expect(await code(Q.dueWakes({}, { appRef: other.id }, keyCtx(key, app.id)))).toBe('APP_NOT_FOUND');
    await grant(key);
    expect(await code(Q.dueWakes({}, { appRef: other.id }, keyCtx(key, app.id)))).toBe('APP_NOT_FOUND');
  });

  it('only the key\'s own App\'s workers, even when another App\'s worker is named', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    const stranger = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: other.id, agentId: agent.id, name: 'Stray', slug: 'stray' }, select: { id: true } });
    await grant(key);
    const page = await due(keyCtx(key, app.id), { workerRefs: [stranger.id, liam.id] });
    expect(page.wakes.map((w: any) => w.worker.id)).toEqual([liam.id]);
  });

  it('R1/B3: a worker whose only unread is in its holder\'s personal memory gives the key no wake and no trace', async () => {
    const personal = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:liam-personal`, name: 'p', class: 'personal', userId: holder.id } });
    const secret = await mkChannel(personal.id, 'chats:private', holder.id);
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: secret.id, attendeeWorkerId: liam.id, role: 'BOTH' } });
    await db.registerEntry.deleteMany({ where: { channelId: channel.id } });
    await say(secret, 'private news', mention('liam'));
    await grant(key);
    const page = await due(keyCtx(key, app.id));
    expect(page.wakes).toEqual([]);
    expect(page.dormant).toEqual([]);
    expect(JSON.stringify(page)).not.toContain(secret.id);
    // ...while the holder sees it.
    expect((await due(userCtx(holder.id))).wakes).toHaveLength(1);
  });

  it('R4: a proof issued to the key is not for a user or another key; a user\'s is not for the key', async () => {
    await grant(key);
    const otherKey = await mkKey(app.id, 'second');
    await grant(otherKey);
    const keyProof = (await due(keyCtx(key, app.id))).wakes[0].proof;
    expect(await code(ack(userCtx(manager.id), [keyProof]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(ack(userCtx(holder.id), [keyProof]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(ack(keyCtx(otherKey, app.id), [keyProof]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect(await db.workerWakeAck.count()).toBe(0);
    // The reverse: a user's proof.
    const userProof = (await due(userCtx(manager.id))).wakes[0].proof;
    expect(await code(ack(keyCtx(key, app.id), [userProof]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect(await db.workerWakeAck.count()).toBe(0);
  });
});

describe('N5 / #8097 — a key bound to a session is refused, never narrowed and never treated as unbound', () => {
  beforeEach(async () => { await say(channel, 'for liam', mention('liam')); await grant(key); });

  it('bound to a session, on dueWakes and acknowledgeWakes alike; unbound, it succeeds', async () => {
    const session = await db.session.create({ data: { id: generateId(), appId: app.id }, select: { id: true } });
    const proof = (await due(keyCtx(key, app.id))).wakes[0].proof;
    const bound = keyCtx(key, app.id, { sessionId: session.id });
    expect(await code(due(bound))).toBe('APP_KEY_SESSION_BOUND');
    expect(await code(ack(bound, [proof]))).toBe('APP_KEY_SESSION_BOUND');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect(await db.workerWakeAck.count()).toBe(0);
    // Naming a session that failed to bind is the same.
    const failed = keyCtx(key, app.id, { sessionBindingRefused: true });
    expect(await code(due(failed))).toBe('APP_KEY_SESSION_BOUND');
    expect(await code(ack(failed, [proof]))).toBe('APP_KEY_SESSION_BOUND');
    // Unbound it works.
    expect(await ack(keyCtx(key, app.id), [proof])).toEqual({ acknowledged: 1, unchanged: 0 });
  });

  it('without the scope, a bound key is told about the scope first: it learns nothing about sessions it may not use', async () => {
    const bare = await mkKey(app.id, 'bare');
    expect(await code(due(keyCtx(bare, app.id, { sessionBindingRefused: true })))).toBe('APP_KEY_SCOPE_REQUIRED');
  });
});

describe('N4 — the scope is read from the database at every call', () => {
  beforeEach(async () => { await say(channel, 'for liam', mention('liam')); await grant(key); });

  it('the next call after a revocation is refused, with the same auth context', async () => {
    const c = keyCtx(key, app.id);
    expect((await due(c)).wakes).toHaveLength(1);
    await M.revokeAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id));
    expect(await code(due(c))).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await code(ack(c, ['x']))).toBe('APP_KEY_SCOPE_REQUIRED');
  });

  it('revoking the key itself ends it the same way', async () => {
    const c = keyCtx(key, app.id);
    await M.revokeAppKey({}, { id: key.id }, userCtx(manager.id));
    expect(await code(due(c))).toBe('APP_KEY_SCOPE_REQUIRED');
  });

  it('over one long-lived MCP session: a key reads due wakes, the scope is revoked, the next call is refused', async () => {
    const auth = { appId: app.id, appKeyId: key.id, organizationId: org.id, roles: [] } as AuthContext;
    const server = createTestableMcpServer(auth, { sessionId: `ak-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
    const first = text(await server.callTool('hadron_due_wakes', { appRef: app.id }));
    expect(first).toContain('1 due');
    const proof = /proof: (\S+)/.exec(first)![1]!;
    await M.revokeAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id));
    expect(text(await server.callTool('hadron_due_wakes', { appRef: app.id }))).toMatch(/^\[app_key_scope_required\]/);
    expect(text(await server.callTool('hadron_ack_wakes', { proofs: [proof] }))).toMatch(/^\[app_key_scope_required\]/);
    // Granted again, the same open session works again, and acknowledges its own proof.
    await M.grantAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, userCtx(manager.id));
    expect(text(await server.callTool('hadron_ack_wakes', { proofs: [proof] }))).toBe('Acknowledged 1.');
  });

  it('an MCP key that names a session is refused, never narrowed', async () => {
    const session = await db.session.create({ data: { id: generateId(), appId: app.id }, select: { id: true } });
    const auth = { appId: app.id, appKeyId: key.id, organizationId: org.id, roles: [] } as AuthContext;
    const server = createTestableMcpServer(auth, { sessionId: `ak-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    const t = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
    expect(t(await server.callTool('hadron_due_wakes', { appRef: app.id, session: session.id }))).toMatch(/^\[app_key_session_bound\]/);
    expect(t(await server.callTool('hadron_ack_wakes', { proofs: ['x'], session: session.id }))).toMatch(/^\[app_key_session_bound\]/);
  });

  it('a revocation in flight is waited for: the read that starts behind it is refused, not served', async () => {
    const h = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('authorization:app'), hashtext(${app.id}))`;
      await tx.appKeyScope.updateMany({ where: { appKeyId: key.id }, data: { revokedAt: new Date(), revokedByUserId: manager.id } });
    });
    await h.locked;
    const settled = due(keyCtx(key, app.id)).then(() => 'ok', (e: any) => e.extensions?.code);
    // The scope was read before the revoker committed (it holds only the anchor's exclusive lock), so the first check
    // passes; the issuing transaction takes the anchor shared and waits for the revoker, then re-decides.
    expect(await stillWaiting(settled, h)).toBe(true);
    await h.done;
    expect(await settled).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect(await db.workerWakeAck.count()).toBe(0);
  });

  it('an acknowledgement behind a revocation in flight is waited for, then refused', async () => {
    const proof = (await due(keyCtx(key, app.id))).wakes[0].proof;
    const h = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('authorization:app'), hashtext(${app.id}))`;
      await tx.appKeyScope.updateMany({ where: { appKeyId: key.id }, data: { revokedAt: new Date(), revokedByUserId: manager.id } });
    });
    await h.locked;
    const settled = ack(keyCtx(key, app.id), [proof]).then(() => 'ok', (e: any) => e.extensions?.code);
    expect(await stillWaiting(settled, h)).toBe(true);
    await h.done;
    expect(await settled).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect(await db.workerWakeAck.count()).toBe(0);
  });
});

describe('the wake-budget notice is posted by the platform, key-only reads included (#1791, cor:agt:080:15)', () => {
  const notices = () => db.node.findMany({ where: { messageChannelId: channel.id, nodeType: 'chat-message' }, orderBy: { seq: 'asc' } });
  beforeEach(async () => {
    await grant(key);
    const rook = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Rook', slug: 'rook', heldByUserId: member.id, heldAt: new Date() }, select: { id: true } });
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: rook.id, role: 'BOTH' } });
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 1 } });
    // The team chat the notice goes to: the channel of the team space, as the App's default.
    await db.channel.update({ where: { id: channel.id }, data: {} });
    await say(channel, 'both', mention('liam', 'rook'));
  });
  const systemOnes = async () => (await notices()).filter((n) => (n.data as any)?.authorSystem === true);

  it('a key-only read that exhausts the budget produces exactly one system-authored notice that day', async () => {
    for (let i = 0; i < 3; i++) {
      const page = await due(keyCtx(key, app.id));
      expect(page.status).toBe('WAKE_BUDGET_EXHAUSTED');
    }
    const ones = await systemOnes();
    expect(ones).toHaveLength(1);
    expect(ones[0]!.content).toContain('daily wake budget');
    // A person's read the same day adds none, and the chat mock saw no user-authored post either.
    await due(userCtx(manager.id));
    await due(userCtx(manager.id));
    expect(await systemOnes()).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
    expect(await db.appWakeDay.count({ where: { noticePostedAt: { not: null } } })).toBe(1);
  });

  it('the author is the platform: not the key, a user or a worker; no mentions; no creator', async () => {
    await due(keyCtx(key, app.id));
    const [n] = await systemOnes();
    const data = n!.data as Record<string, unknown>;
    expect(data).toMatchObject({ authorSystem: true, authorName: 'Hadron (platform)' });
    for (const k of ['authorUserId', 'authorWorkerId', 'sessionId', 'authorAppId', 'mentions', 'broadcastWakes', 'managerPost']) expect(data[k]).toBeUndefined();
    expect(n!.createdBy).toBeNull();
    // As a reader sees it.
    const page = await Q.teamChatMessages({}, { appRef: app.id }, userCtx(holder.id));
    const shown = page.items.find((m: any) => m.authorSystem);
    expect(shown).toMatchObject({ authorSystem: true, authorUserId: null, authorWorkerId: null, authorName: 'Hadron (platform)', mentions: [] });
    expect(page.items.filter((m: any) => !m.authorSystem).every((m: any) => m.authorSystem === false)).toBe(true);
  });

  it('two concurrent triggering reads, a key and a person, produce one notice', async () => {
    await Promise.all([due(keyCtx(key, app.id)), due(userCtx(manager.id)), due(keyCtx(key, app.id)), due(userCtx(manager.id))]);
    expect(await systemOnes()).toHaveLength(1);
  });

  it('notice text never expands a mention, whatever it says', async () => {
    const { postSystemNotice } = await import('../../api/graphql/schema/resolvers.teamChat.js');
    expect(await postSystemNotice(db, app.id, '@liam @all hello <@rook>')).toBe(true);
    const ones = await systemOnes();
    const data = ones[ones.length - 1]!.data as Record<string, unknown>;
    expect(data.mentions).toBeUndefined();
    expect(ones[ones.length - 1]!.content).not.toMatch(/@/);
  });

  it('with no team chat there is nothing to post to: no claim is taken, so the next read tries again', async () => {
    await db.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } });
    await db.node.updateMany({ where: { id: channel.chatRootNodeId }, data: { deletedAt: new Date() } });
    await due(keyCtx(key, app.id));
    expect(await db.appWakeDay.count({ where: { noticePostedAt: { not: null } } })).toBe(0);
  });

  it('a chat deleted after the notice chose it stays deleted: nothing is restored, posted or claimed (Riana P2)', async () => {
    const { postSystemNotice } = await import('../../api/graphql/schema/resolvers.teamChat.js');
    let tripped = false;
    // The supported delete lands in the gap after the root was selected and before the append.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === 'channel' && tripped === false) {
          return new Proxy(v as object, {
            get(t, p, r) {
              const f = Reflect.get(t, p, r);
              if (p !== 'findFirst') return f;
              return async (...a: unknown[]) => {
                const out = await (f as (...x: unknown[]) => Promise<unknown>).apply(t, a);
                if (!tripped) {
                  tripped = true;
                  await db.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } });
                  await db.node.updateMany({ where: { id: channel.chatRootNodeId }, data: { deletedAt: new Date() } });
                }
                return out;
              };
            },
          });
        }
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as typeof db;
    const claim = vi.fn(async () => true);
    expect(await postSystemNotice(racing, app.id, 'late', claim)).toBe(false);
    expect(tripped).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect((await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).deletedAt).not.toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: channel.chatRootNodeId } })).deletedAt).not.toBeNull();
    expect(await systemOnes()).toHaveLength(0);
  });

  it('the day\'s claim and the notice commit together: an exit after the claim leaves neither', async () => {
    const { postSystemNotice } = await import('../../api/graphql/schema/resolvers.teamChat.js');
    await expect(postSystemNotice(db, app.id, 'x', async (tx) => {
      await tx.$executeRaw`INSERT INTO app_wake_days (app_id, day, wakes, notice_posted_at) VALUES (${app.id}, now()::date, 0, now() AT TIME ZONE 'utc')
        ON CONFLICT (app_id, day) DO UPDATE SET notice_posted_at = now() AT TIME ZONE 'utc'`;
      throw new Error('process exit');
    })).rejects.toThrow('process exit');
    expect(await db.appWakeDay.count({ where: { noticePostedAt: { not: null } } })).toBe(0);
    expect(await systemOnes()).toHaveLength(0);
    await due(keyCtx(key, app.id));
    expect(await systemOnes()).toHaveLength(1);
  });

  it('an encrypted team chat is skipped: no notice is sealed with a key the request did not carry', async () => {
    const { postSystemNotice, canPostSystemNotice } = await import('../../api/graphql/schema/resolvers.teamChat.js');
    const mem = await db.node.findUniqueOrThrow({ where: { id: channel.chatRootNodeId }, select: { memoryId: true } });
    await db.memory.update({ where: { id: mem.memoryId }, data: { isEncrypted: true } });
    const claim = vi.fn(async () => true);
    expect(await canPostSystemNotice(db, app.id)).toBe(false);
    expect(await postSystemNotice(db, app.id, 'x', claim)).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(await systemOnes()).toHaveLength(0);
  });

  it('a failed post hands the day\'s claim back', async () => {
    const mod = await import('../../api/graphql/schema/resolvers.teamChat.js');
    const spy = vi.spyOn(mod, 'postSystemNotice').mockRejectedValueOnce(new Error('boom'));
    try {
      await due(keyCtx(key, app.id));
      expect(await db.appWakeDay.count({ where: { noticePostedAt: { not: null } } })).toBe(0);
    } finally { spy.mockRestore(); }
    await due(keyCtx(key, app.id));
    expect(await systemOnes()).toHaveLength(1);
  });
});

describe('N4 on every result path — a call that issues nothing is decided under the anchor too (Diego, Riana, Rook #1781)', () => {
  const revokerInFlight = () => holdOpen(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('authorization:app'), hashtext(${app.id}))`;
    await tx.appKeyScope.updateMany({ where: { appKeyId: key.id }, data: { revokedAt: new Date(), revokedByUserId: manager.id } });
  });
  /** The read that starts behind a revoker in flight: it must wait, then be refused, and leave no trace. */
  async function behindRevoker(args: Record<string, unknown> = {}) {
    const h = revokerInFlight();
    await h.locked;
    const settled = due(keyCtx(key, app.id), args).then((p: any) => ({ ok: p }), (e: any) => ({ code: e.extensions?.code }));
    expect(await stillWaiting(settled, h)).toBe(true);
    await h.done;
    const out = await settled;
    expect(out).toEqual({ code: 'APP_KEY_SCOPE_REQUIRED' });
    expect(await db.appKeyWakeRead.count()).toBe(0);
    expect(await db.appWakeReservation.count()).toBe(0);
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect(await db.workerWakeAck.count()).toBe(0);
  }
  beforeEach(async () => { await grant(key); });

  it('a dormant-only page (worker names and mention counts) is not returned through a revocation in flight', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 100 * 86_400_000), updatedAt: new Date(Date.now() - 100 * 86_400_000), endedAt: new Date(Date.now() - 100 * 86_400_000) } });
    await say(channel, 'hi', mention('liam'));
    // Sanity: unrevoked, it IS the dormant metadata a key may see.
    const seen = await due(keyCtx(key, app.id));
    expect(seen.wakes).toEqual([]);
    expect(seen.dormant).toHaveLength(1);
    await db.appKeyWakeRead.deleteMany();
    await behindRevoker();
  });

  it('a page with workers and nothing due is not returned through a revocation in flight', async () => {
    await behindRevoker();
  });

  it('an empty page (no worker matches) is not returned through a revocation in flight', async () => {
    await behindRevoker({ workerRefs: [generateId()] });
  });

  it('a revocation that commits after the entry check and before the answer is returned still refuses it', async () => {
    await say(channel, 'for liam', mention('liam'));
    const revoke = () => db.appKeyScope.updateMany({ where: { appKeyId: key.id }, data: { revokedAt: new Date(), revokedByUserId: manager.id } });
    // Revoke while the call is between its entry check and its end: from inside the scan's first query.
    const real = db.channelReadState.findMany.bind(db.channelReadState);
    const spy = vi.spyOn(db.channelReadState, 'findMany').mockImplementationOnce(((a: any) => revoke().then(() => real(a))) as any);
    try {
      expect(await code(due(keyCtx(key, app.id)))).toBe('APP_KEY_SCOPE_REQUIRED');
    } finally {
      spy.mockRestore();
    }
    expect(await db.appKeyWakeRead.count()).toBe(0);
  });
});

describe('default deny — attention:deliver gains nothing elsewhere', () => {
  it('a sample of App-key gates answers a scoped key exactly as it does a scopeless one', async () => {
    const scoped = await mkKey(app.id, 'scoped');
    await grant(scoped);
    const bare = keyCtx(key, app.id);
    const withScope = keyCtx(scoped, app.id);
    const probe = async (c: Context) => ({
      appKeys: await code(Q.appKeys({}, { appRef: app.id }, c)),
      createKey: await code(M.createAppKey({}, { appRef: app.id, label: 'x' }, c)),
      grant: await code(M.grantAppKeyScope({}, { id: key.id, scope: 'attention:deliver' }, c)),
      tickers: await code(Q.tickers({}, { appRef: app.id }, c)),
      settings: await code(M.setAppTickerSettings({}, { appRef: app.id, input: { liveCap: 5 } }, c)),
      create: await code(M.createTicker({}, { appRef: app.id, input: { name: 'x', cadenceSeconds: 600 } }, c)),
    });
    expect(await probe(withScope)).toEqual(await probe(bare));
    expect(await db.appKey.count({ where: { label: 'x' } })).toBe(0);
  });
});
