// Unit-only materialization fixtures mock the consent seam; real pin tests
// exercise this guard against persisted adoption and the loaded registry row.
vi.mock('../../automation/pins.js', () => ({ assertPinnedToolIdentity: vi.fn() }));
/**
 * Dynamic Home Assistant run tools (hadrontool-home-assistant) — what
 * this file pins (mirrors mcpTools.test.ts):
 *   - unknownHaToolNames: grammar, the CLOSED op catalog, registration,
 *     enabled, allowlist, and the name-length cap — all checked locally
 *     (loadNodeSpec's fail-loud contract, D-TL-6; no tool round-trip).
 *   - materializeHaRunTools: static defs (cost 1, catalog schema),
 *     deleted/disabled row fails loud, execute proxies with the decrypted
 *     token, bounds the result, and hands author-facing HA errors
 *     (ha_not_found / ha_error / validation_error) to the LLM as isError
 *     while operator-level failures (timeout, auth) rethrow → TOOL_FAILED.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { callHaOp } from '../../haToolClient.js';
import { encryptToken } from '../../tokenCrypto.js';
import { unknownHaToolNames, materializeHaRunTools } from './haTools.js';
import type { RunToolContext } from './types.js';
import type { AppRun } from '../../../generated/prisma/index.js';

vi.mock('../../haToolClient.js', () => ({
  callHaOp: vi.fn(),
}));

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(callHaOp).mockReset();
  const org = await db.organization.create({
    data: { id: generateId(), name: 'ha-run-org', urn: 'ha-run-org' },
  });
  orgId = org.id;
});

async function registerInstance(overrides: Record<string, unknown> = {}) {
  return db.homeAssistantInstance.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      slug: 'home',
      name: 'Holger home',
      url: 'https://ha.example.com',
      tokenEncrypted: encryptToken('ha-token-secret'),
      ...overrides,
    } as never,
  });
}

function fakeRun(): AppRun {
  return { id: 'run-1', organizationId: orgId } as AppRun;
}

function fakeCtx(logs: string[]): RunToolContext {
  return { log: (m) => logs.push(m), db, run: fakeRun(), principal: { db } as never };
}

describe('unknownHaToolNames', () => {
  it('admits a registered, enabled, allowlisted catalog op and rejects everything else', async () => {
    await registerInstance({ opAllowlist: ['get_state', 'call_service'] });
    await registerInstance({ slug: 'disabled', enabled: false });

    const unknown = await unknownHaToolNames(db, orgId, [
      'ha__home__get_state', // OK
      'ha__home__fire_event', // not in allowlist
      'ha__home__reboot_house', // not in the closed catalog
      'ha__disabled__get_state', // disabled instance
      'ha__missing__get_state', // unregistered slug
      'ha__home', // malformed (no op part)
    ]);
    expect(unknown).toEqual([
      'ha__home__fire_event',
      'ha__home__reboot_house',
      'ha__disabled__get_state',
      'ha__missing__get_state',
      'ha__home',
    ]);
  });

  it("scopes registration to the run org — another org's instance does not count", async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other', urn: 'ha-other-org' },
    });
    await db.homeAssistantInstance.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        slug: 'home',
        name: 'Other home',
        url: 'https://ha.other.example',
        tokenEncrypted: encryptToken('t'),
      },
    });
    expect(await unknownHaToolNames(db, orgId, ['ha__home__get_state'])).toEqual(['ha__home__get_state']);
  });
});

describe('materializeHaRunTools', () => {
  it('builds static defs from the catalog (cost 1) — no tool round-trip', async () => {
    await registerInstance();
    const defs = await materializeHaRunTools(db, fakeRun(), ['ha__home__call_service']);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ name: 'ha__home__call_service', cost: 1 });
    expect(defs[0].description).toContain('Holger home');
    expect(defs[0].inputSchema).toMatchObject({ required: ['domain', 'service'] });
    expect(callHaOp).not.toHaveBeenCalled();
  });

  it('fails loud when the row was deleted or disabled between validation and the hop', async () => {
    await expect(materializeHaRunTools(db, fakeRun(), ['ha__home__get_state'])).rejects.toThrow(
      /not registered/,
    );
    await registerInstance({ enabled: false });
    await expect(materializeHaRunTools(db, fakeRun(), ['ha__home__get_state'])).rejects.toThrow(
      /not registered/,
    );
  });

  it('fails loud on an op outside the allowlist', async () => {
    await registerInstance({ opAllowlist: ['get_state'] });
    await expect(materializeHaRunTools(db, fakeRun(), ['ha__home__call_service'])).rejects.toThrow(
      /allowlist/,
    );
  });

  it('execute proxies with the decrypted token and returns the JSON payload', async () => {
    await registerInstance();
    const [def] = await materializeHaRunTools(db, fakeRun(), ['ha__home__get_state']);
    vi.mocked(callHaOp).mockResolvedValue({
      state: { entity_id: 'light.desk', state: 'on', attributes: {} },
    });

    const ok = await def.execute(fakeCtx([]), { entityId: 'light.desk' });
    expect(ok).toEqual({
      result: JSON.stringify({ state: { entity_id: 'light.desk', state: 'on', attributes: {} } }),
    });
    expect(callHaOp).toHaveBeenCalledWith(
      { url: 'https://ha.example.com', accessToken: 'ha-token-secret' },
      'get-state',
      { entityId: 'light.desk' },
    );
  });

  it('hands author-facing HA errors to the LLM as isError instead of throwing', async () => {
    await registerInstance();
    const [def] = await materializeHaRunTools(db, fakeRun(), ['ha__home__get_state']);
    const logs: string[] = [];
    vi.mocked(callHaOp).mockRejectedValue(
      new GraphQLError('Home Assistant does not know /api/states/light.gone.', {
        extensions: { code: 'HA_TOOL_ERROR', haErrorCode: 'ha_not_found' },
      }),
    );

    const err = await def.execute(fakeCtx(logs), { entityId: 'light.gone' });
    expect(err).toMatchObject({ isError: true });
    expect((err as { error: string }).error).toContain('does not know');
    expect(logs.some((l) => l.includes('ha_not_found'))).toBe(true);
  });

  it('rethrows operator-level failures (timeout, auth) → TOOL_FAILED', async () => {
    await registerInstance();
    const [def] = await materializeHaRunTools(db, fakeRun(), ['ha__home__get_state']);
    vi.mocked(callHaOp).mockRejectedValue(
      new GraphQLError('Home Assistant rejected the access token — it may be revoked or mistyped.', {
        extensions: { code: 'HA_TOOL_ERROR', haErrorCode: 'ha_auth_failed' },
      }),
    );
    await expect(def.execute(fakeCtx([]), { entityId: 'light.desk' })).rejects.toThrow(/rejected the access token/);
  });

  it('bounds the serialized result (a 500-entity payload must not flood the hop)', async () => {
    await registerInstance();
    const [def] = await materializeHaRunTools(db, fakeRun(), ['ha__home__list_states']);
    vi.mocked(callHaOp).mockResolvedValue({ states: [{ blob: 'x'.repeat(100_000) }] });

    const big = (await def.execute(fakeCtx([]), {})) as { result: string };
    expect(big.result.length).toBeLessThan(61_000);
    expect(big.result.endsWith('…[truncated by hadron-server]')).toBe(true);
  });
});
