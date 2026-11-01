/** #3057: hostile thrown values at every diagnostic boundary; no network or shared DB. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import type { PrismaClient } from '../../generated/prisma/index.js';

const fault = vi.hoisted(() => ({ site: '', value: undefined as unknown }));
vi.mock('../../config.js', () => ({ GRAPHS_PATH: '/private-test-3057' }));
vi.mock('fs', async original => ({ ...(await original<typeof import('fs')>()), existsSync: () => true }));
vi.mock('./githubApp.js', () => ({
  getInstallationToken: async () => { if (fault.site === 'token') throw fault.value; return 'synthetic-installation-token'; },
  toHttpsUrl: () => 'https://x-access-token:fixture@github.com/example/repo.git',
}));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: async () => {}, unpublishedCommitCount: async () => 1 }));
vi.mock('./execGit.js', () => ({ execGit: async (args: string[]) => {
  if ((fault.site === 'branch' && args[0] === 'fetch') || (fault.site === 'push' && args[0] === 'push') ||
      (fault.site === 'restore' && args[0] === 'remote' && args[3] === 'https://github.com/example/repo.git')) throw fault.value;
  return { stdout: args[0] === 'status' ? ' M node.md' : '', stderr: '' };
} }));
vi.mock('./mirrorCheckoutLock.js', () => ({
  EncryptedMemoryFenceError: class extends Error {},
  withMirrorCheckoutLock: async (_id: string, work: () => Promise<unknown>) => {
    if (fault.site === 'lock') throw fault.value;
    return work();
  },
}));
import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { settleMirrorObligations, tryTakeAttemptSeq } from './mirrorObligations.js';
import { startGitMirrorObligationSweepLoop } from '../../jobs/sweepGitMirrorObligations.js';

const SECRET = 'https://x-access-token:synthetic-secret-3057@github.com/private/repo Bearer synthetic-bearer-3057';
function hostile() {
  return Object.assign(new Error(SECRET), { stack: SECRET, cause: { cause: { token: SECRET } },
    extra: SECRET, name: SECRET, code: SECRET, exitCode: 128, status: 503, toString: () => SECRET });
}
const memory = { id: 'memory-3057', urn: 'org:mirror', source: 'https://github.com/example/repo.git',
  organization: { urn: 'org', name: 'Example', githubInstallationId: 123 }, isEncrypted: false, writeBranch: 'main' };
let output: string[];
let writes: unknown[];
let client: PrismaClient;
beforeEach(() => {
  output = []; writes = []; fault.site = ''; fault.value = hostile();
  for (const channel of ['log', 'warn', 'error'] as const) vi.spyOn(console, channel).mockImplementation((...args) => {
    // Inspect every argument recursively AND exercise string conversion, as real console formatters can do either.
    output.push(inspect(args, { depth: null, getters: false }), args.map(String).join(' '));
  });
  client = { memory: { findUnique: async () => memory },
    $queryRaw: async () => { if (['sequence', 'sweep'].includes(fault.site)) throw fault.value; return [{ seq: 1n }]; },
    $executeRaw: async (...args: unknown[]) => { if (fault.site === 'settle') throw fault.value; writes.push(args); return 1; },
  } as unknown as PrismaClient;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function assertSafe() {
  const serialized = output.join('\n') + inspect(writes, { depth: null });
  for (const secret of [SECRET, 'synthetic-secret-3057', 'synthetic-bearer-3057', 'x-access-token']) expect(serialized).not.toContain(secret);
}
const run = () => withMirrorCheckout({ db: client, memoryId: memory.id, commitSubject: 'test mirror', logPrefix: '[3057]',
  obligations: [{ nodeId: 'node-3057', kind: 'WRITE' }] }, async () => { if (fault.site === 'tree') throw fault.value; });

describe('mirror failure metadata at each real call site', () => {
  it.each(['sequence', 'settle'])('%s keeps a closed code-less Prisma type without hostile text', async site => {
    fault.site = site; fault.value = Object.assign(hostile(), { code: undefined, name: 'PrismaClientInitializationError' });
    if (site === 'sequence') await tryTakeAttemptSeq(client);
    else await settleMirrorObligations(client, memory.id, [{ nodeId: 'node', kind: 'WRITE' }], { result: 'failed', errorClass: 'TREE_WRITE' }, 1n);
    assertSafe(); expect(output.join('\n')).toContain("errorType: 'PrismaClientInitializationError'");
  });

  it.each(['sequence', 'settle'])('%s retains the diagnostic code of a pool timeout (#3057 BLIND P2)', async site => {
    fault.site = site; fault.value = Object.assign(hostile(), { code: 'P2024' });
    if (site === 'sequence') await tryTakeAttemptSeq(client);
    else await settleMirrorObligations(client, memory.id, [{ nodeId: 'node', kind: 'WRITE' }], { result: 'failed', errorClass: 'TREE_WRITE' }, 1n);
    assertSafe(); expect(output.join('\n')).toContain("providerCode: 'P2024'");
  });

  it.each(['token', 'branch', 'tree', 'push', 'lock', 'restore'])('%s: retains bounded diagnostics and drops all hostile fields', async site => {
    fault.site = site;
    await run();
    assertSafe();
    expect(output.join('\n')).toContain('exitCode: 128');
    expect(output.join('\n')).toContain('httpStatus: 503');
    expect(output.join('\n')).toContain(`phase: '${site}'`);
  });
  it.each(['sequence', 'settle'])('%s: an arbitrary error name/code cannot reach the log', async site => {
    fault.site = site;
    if (site === 'sequence') await tryTakeAttemptSeq(client);
    else await settleMirrorObligations(client, memory.id, [{ nodeId: 'node', kind: 'WRITE' }], { result: 'failed', errorClass: 'TREE_WRITE' }, 1n);
    assertSafe();
    expect(output.join('\n')).toContain('exitCode: 128');
    expect(output.join('\n')).toContain(`phase: '${site}'`);
  });
  it('sweep loop catch retains bounded diagnostics', async () => {
    vi.useFakeTimers(); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('DISABLE_GIT_MIRROR_SWEEP', 'false');
    fault.site = 'sweep';
    const timer = startGitMirrorObligationSweepLoop(client, 100);
    try { await vi.advanceTimersByTimeAsync(100); } finally { if (timer) clearInterval(timer); }
    assertSafe();
    expect(output.join('\n')).toContain('exitCode: 128');
    expect(output.join('\n')).toContain("phase: 'sweep'");
  });
  it.each([SECRET, { token: SECRET }, hostile()])('never converts a non-Error or hostile Error to text', async value => {
    fault.site = 'token'; fault.value = value;
    await run(); assertSafe();
    expect(output.join('\n')).toContain("phase: 'token'");
  });
});
