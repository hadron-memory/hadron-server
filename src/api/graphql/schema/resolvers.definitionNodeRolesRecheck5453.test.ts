/**
 * #5453 PR A — the compiled guard's SECOND line on the doors that judge twice.
 *
 * `updateNode` and `restoreNodeRevision` each refuse a compiled node in a fast preflight and again on the locked
 * row inside the write's transaction. The preflight alone makes every ordinary pin green, so a pin that only calls
 * the door cannot tell whether the check under the lock is still there. Each test here switches the door's FIRST
 * check off (the preflight) and asserts the refusal still comes, from the row the transaction locked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

// How many of the next calls to each guard are let through unjudged (the door's preflight), and how many were judged.
const pierce = vi.hoisted(() => ({ skipGranted: 0, skipAllowed: 0, judged: 0 }));
vi.mock('../../../lib/grants/bootPromptGrant.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/grants/bootPromptGrant.js')>();
  return {
    ...real,
    assertBootPromptWriteAllowedOrGranted: (...a: Parameters<typeof real.assertBootPromptWriteAllowedOrGranted>) => {
      if (pierce.skipGranted > 0) { pierce.skipGranted -= 1; return Promise.resolve(); }
      pierce.judged += 1;
      return real.assertBootPromptWriteAllowedOrGranted(...a);
    },
  };
});
vi.mock('../../../lib/bootPrompt.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/bootPrompt.js')>();
  return {
    ...real,
    assertBootPromptWriteAllowed: (...a: Parameters<typeof real.assertBootPromptWriteAllowed>) => {
      if (pierce.skipAllowed > 0) { pierce.skipAllowed -= 1; return; }
      pierce.judged += 1;
      return real.assertBootPromptWriteAllowed(...a);
    },
  };
});

let admin: { id: string };
let memory: { id: string; urn: string };
const ctx = (): Context => ({ db, userId: admin.id, roles: [] });
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const compiled = () => withCompileWrite(() => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc: 'boot:compiled', name: 'Compiled', content: 'You are Basil.', nodeType: 'system', role: 'prompt.boot.compiled' },
}));

beforeEach(async () => {
  await cleanDb(db);
  pierce.skipGranted = 0; pierce.skipAllowed = 0; pierce.judged = 0;
  const org = await db.organization.create({ data: { id: generateId(), name: 'Recheck Org', urn: 'recheck5453.example' } });
  admin = await db.user.create({ data: { githubId: 545311, githubUsername: 'recheck-admin', handle: 'recheck-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'recheck-memory' }, ctx());
});

describe('#5453: with the preflight off, the check on the locked row still refuses a compiled node', () => {
  it('updateNode: the transaction\'s own check refuses, and nothing is written', async () => {
    const c = await compiled();
    pierce.skipGranted = 1;
    expect(await codeOf(resolvers.Mutation.updateNode(null, { input: { ref: c.id, content: 'edited' } }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(pierce.skipGranted).toBe(0); // the preflight was the call let through
    expect(pierce.judged).toBeGreaterThan(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('You are Basil.');
    expect(await db.nodeRevision.count({ where: { nodeId: c.id } })).toBe(0);
  });

  it('updateNode: a plain node cannot be given the compiled role past the preflight either', async () => {
    const plain = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'n:plain', name: 'Plain', content: 'p', nodeType: 'system' } });
    pierce.skipGranted = 1;
    expect(await codeOf(resolvers.Mutation.updateNode(null, { input: { ref: plain.id, role: 'prompt.boot.compiled' } }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(pierce.skipGranted).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: plain.id } })).role).toBeNull();
  });

  it('restoreNodeRevision: the transaction\'s own check refuses, and nothing is written', async () => {
    const c = await compiled();
    await withCompileWrite(() => resolvers.Mutation.updateNode(null, { input: { ref: c.id, content: 'second compile' } }, ctx()));
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: c.id } });
    pierce.judged = 0;
    pierce.skipAllowed = 1;
    expect(await codeOf(resolvers.Mutation.restoreNodeRevision(null, { nodeRevRef: rev.id }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(pierce.skipAllowed).toBe(0);
    expect(pierce.judged).toBeGreaterThan(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('second compile');
  });
});
