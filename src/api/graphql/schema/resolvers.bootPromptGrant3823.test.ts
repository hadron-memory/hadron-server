/**
 * #3823 (ruling 0267; cor:agt:040:11 r8, cor:acl:140:01/:04) — a worker session edits the text of its OWN boot-prompt source
 * only under a grant: one edit, one source node, held by the worker, an hour from activation, signed by a person who could make
 * the edit. A holder's instruction alone never admits it. Everything else stays refused (V46).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, insertGrantUnguarded, raw, type World } from '../../../lib/grants/grantFixtures3668.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const EDIT = 'bootprompt.source.edit';

let admin: { id: string };
let stranger: { id: string };
let orgId: string;
let appId: string;
let agentId: string;
let workerId: string;
let otherWorkerId: string;
let installMemoryId: string;
let agentMemoryId: string;
const asWorker = <T>(fn: () => Promise<T>, id = workerId) => runAsActor({ workerId: id, agentId: null }, fn);
const ctx = (): Context => ({ db, userId: admin.id, roles: [] });
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const src = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: 'Source', content: 'original', role: 'boot-prompt' },
});
const world = () => ({ appId, userId: admin.id } as unknown as World);
/** An ACTIVE grant (the signature ceremony is a different slice; the row is built the way live3668 builds one). */
const grant = (nodeId: string, over: Record<string, unknown> = {}) => insertGrantUnguarded(world(), {
  user_id: null, worker_id: workerId, action: EDIT, action_values: { sourceNode: nodeId }, max_uses: 1,
  activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id,
  expires_at: raw(`${DB_NOW} + interval '1 hour'`), ...over,
} as never);
const uses = (grantId: string) => db.grantEvent.count({ where: { grantId, action: 'USE' } });
const edit = (id: string, content = 'edited') => asWorker(() => resolvers.Mutation.updateNode(null, { input: { id, content } }, ctx()));

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'G Org', urn: 'g3823.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 382301, githubUsername: 'g-admin', handle: 'g-admin', roles: [] } });
  stranger = await db.user.create({ data: { githubId: 382302, githubUsername: 'g-stranger', handle: 'g-stranger', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { id: generateId(), name: 'G App', urn: 'g3823.example:app', organizationId: org.id } });
  appId = app.id;
  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'g3823.example:agent-sys', organizationId: orgId } });
  agentMemoryId = agentMem.id;
  const agent = await db.agent.create({ data: { id: generateId(), name: 'G agent', urn: 'g3823.example:agent', organizationId: org.id, systemMemoryId: agentMem.id } });
  agentId = agent.id;
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  installMemoryId = (await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'g3823.example:install', organizationId: orgId, appId, installOfAgentId: agentId, isInstallMemory: true },
  })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Iris', slug: 'iris' } })).id;
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Otto', slug: 'otto' } })).id;
});

describe('the two grant actions are registered (#3823 acceptance 7)', () => {
  it('bootprompt.source.edit and bootprompt.compile.approve exist, SERVER-enforced, refusing a wildcard', async () => {
    const rows = await db.action.findMany({ where: { name: { in: [EDIT, 'bootprompt.compile.approve'] } }, orderBy: { name: 'asc' } });
    expect(rows.map((r) => r.name)).toEqual(['bootprompt.compile.approve', EDIT]);
    for (const r of rows) {
      expect(r.enforcement).toBe('SERVER');
      expect((r.parameters as Array<{ refusesWildcard: boolean }>).every((p) => p.refusesWildcard)).toBe(true);
    }
  });
});

describe('a worker edits its own source under a grant (#3823 acceptance 1, 6)', () => {
  it('no grant: still BOOT_PROMPT_WORKER_SESSION_REFUSED, and the holder\'s instruction alone changes nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('original');
  });

  it('own worker source, live grant naming it: the text changes, the revision records the worker, the grant is spent', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('edited');
    const revs = await db.nodeRevision.findMany({ where: { nodeId: s.id }, orderBy: { id: 'asc' } });
    expect(revs.some((r) => r.editedByWorkerId === workerId)).toBe(true);
    expect(await uses(g)).toBe(1);
  });

  it('one grant, one edit: the second edit is refused', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id);
    await edit(s.id, 'first');
    expect(await codeOf(edit(s.id, 'second'))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('first');
  });

  it('the role Agent\'s own boot:source (system memory) is in scope when the signer manages the Agent', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('the App\'s boot:source in the install memory is the role Agent\'s source for this App and is in scope', async () => {
    const s = await src(installMemoryId, 'boot:source');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });
});

describe('the grant is the boundary (#3823 refusals that must hold)', () => {
  it('a grant naming another node does not admit this one', async () => {
    const mine = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const other = await src(installMemoryId, 'boot:source');
    const g = await grant(other.id);
    expect(await codeOf(edit(mine.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
  });

  it('another worker\'s source is refused even under a grant that names it (own check, holder who can write it)', async () => {
    const theirs = await src(installMemoryId, `boot:workers:${otherWorkerId}:source`);
    const g = await grant(theirs.id);
    expect(await codeOf(edit(theirs.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
  });

  it('a source in another Agent\'s system memory is refused even under a grant that names it', async () => {
    const otherMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'other-sys', urn: 'g3823.example:other-sys', organizationId: orgId } });
    await db.agent.create({ data: { id: generateId(), name: 'Other', urn: 'g3823.example:other', organizationId: orgId, systemMemoryId: otherMem.id } });
    const s = await src(otherMem.id, 'boot:source');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a grant held by another worker does not admit this one', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { worker_id: otherWorkerId });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a grant an hour past activation is refused, whatever its expires_at says', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`), expires_at: raw(`${DB_NOW} + interval '1 day'`) });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a pending, revoked or expired grant admits nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { activated_at: null, verification_kind: null, verified_by: null, issuer_user_id: null });
    await grant(s.id, { revoked_at: raw(DB_NOW), revoked_by: admin.id });
    await grant(s.id, { activated_at: raw(`${DB_NOW} - interval '10 minutes'`), expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a signer who cannot make the edit themselves (no manager of the App) admits nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { verified_by: stranger.id, issuer_user_id: stranger.id });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a wildcard or list value names no single source and admits nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { action_values: { sourceNode: '*' } });
    await grant(s.id, { action_values: { sourceNode: [s.id] } });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('text in place only: delete, role strip, node-type change, move and merge stay refused, and spend nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const t = await src(installMemoryId, 'boot:other');
    const g = await grant(s.id);
    const ops = [
      () => asWorker(() => resolvers.Mutation.deleteNode(null, { nodeRef: s.id }, ctx())),
      () => asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, role: 'notes' } }, ctx())),
      () => asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, nodeType: 'info' } }, ctx())),
      () => asWorker(() => resolvers.Mutation.moveNode(null, { sourceRef: s.id, targetUrn: 'hrn:node:g3823.example:install:elsewhere' }, ctx())),
      () => asWorker(() => resolvers.Mutation.mergeNodes(null, { input: { source: s.id, target: t.id } }, ctx())),
    ];
    for (const op of ops) expect(await codeOf(op())).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('original');
  });

  it('a create of a boot-prompt source stays refused (a grant names an existing node)', async () => {
    const g = await grant(generateId());
    expect(await codeOf(asWorker(() => resolvers.Mutation.createNode(null, {
      input: { memoryId: installMemoryId, loc: `boot:workers:${workerId}:source`, name: 'S', role: 'boot-prompt', content: 'x' },
    }, ctx())))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
  });

  it('a compiled node is never written by a generic edit, grant or not', async () => {
    const c = await db.node.create({ data: { id: generateId(), memoryId: installMemoryId, loc: `boot:workers:${workerId}:compiled`, name: 'C', content: 'c', role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } });
    await grant(c.id);
    expect(await codeOf(edit(c.id))).toBe('BOOT_PROMPT_COMPILED_WRITE');
  });

  it('a person editing as themselves (no worker session) is unaffected, and spends no grant', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    await resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'by the manager' } }, ctx());
    expect(await uses(g)).toBe(0);
  });

  it('a refused write leaves the grant unspent (the spend rides the write\'s transaction)', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const stale = await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'x', expectedRevSeq: 999 } as never }, ctx())));
    expect(stale).not.toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });
});
