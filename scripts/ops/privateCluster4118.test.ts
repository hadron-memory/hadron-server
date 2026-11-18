/** #4118: a hosted lane must fail rather than silently omit private-cluster coverage. */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(), existsSync: vi.fn(),
}));
import { existsSync } from 'node:fs';
import { pgBinDir } from './privateCluster.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe('#4118 private-cluster admission', () => {
  it('still allows an optional developer run to skip without server prerequisites', () => {
    vi.stubEnv('REQUIRE_PRIVATE_CLUSTER', '');
    vi.mocked(existsSync).mockReturnValue(false);
    expect(pgBinDir()).toBeNull();
  });
  it('required mode refuses missing prerequisites', () => {
    vi.stubEnv('REQUIRE_PRIVATE_CLUSTER', '1');
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => pgBinDir()).toThrow(/private cluster.*required/i);
  });
  it('a selected major never falls back to another installed version', () => {
    vi.stubEnv('PRIVATE_CLUSTER_PG_VERSION', '16');
    vi.stubEnv('REQUIRE_PRIVATE_CLUSTER', '1');
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('/17/'));
    expect(() => pgBinDir()).toThrow(/private cluster.*required/i);
  });
  it('checks pg_ctl and pgvector in the selected installation as well as initdb/resetwal', () => {
    vi.stubEnv('PRIVATE_CLUSTER_PG_VERSION', '16');
    vi.stubEnv('REQUIRE_PRIVATE_CLUSTER', '1');
    for (const missing of ['pg_ctl', 'vector.control']) {
      vi.mocked(existsSync).mockImplementation((p) => !String(p).endsWith(missing));
      expect(() => pgBinDir()).toThrow(/private cluster.*required/i);
    }
  });
  it('returns the explicitly selected complete installation', () => {
    vi.stubEnv('PRIVATE_CLUSTER_PG_VERSION', '16');
    vi.mocked(existsSync).mockReturnValue(true);
    expect(pgBinDir()).toBe('/usr/lib/postgresql/16/bin');
  });
});
