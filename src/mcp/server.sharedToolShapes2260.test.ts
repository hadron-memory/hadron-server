/**
 * #2260 / #2259 — a tool's zod parameter shape is built once per process, not once per MCP session.
 *
 * Before: every `createMcpServerInstance` rebuilt all ~124 shapes, ~15 MB of V8 heap per session, and the
 * `transports` map keeps an instance alive until its client closes it (#2259: heap limit exit 134 on 0.0.1174).
 * This pins what must NOT change (the wire surface and the per-session isolation) and what must (the retained
 * heap per instance). Module scope alone proves neither immutability nor the absence of shared mutable state, so
 * the shared-graph checks below look at the objects, not at the file layout.
 *
 * The heap test needs an exposed `gc`; it enables it in-process (`v8.setFlagsFromString('--expose-gc')` then
 * `vm.runInNewContext('gc')`), so no runner flag is required. Run alone with:
 *   pnpm vitest run src/mcp/server.sharedToolShapes2260.test.ts
 * Regenerate the golden (only when a tool's wire surface is meant to change) with UPDATE_TOOL_GOLDEN=1.
 * Pinned from 92ff99df; #2249 amended exactly three entries (hadron_task_create / _assign / _reassign), whose text states the
 * closeSessionWhenDone default.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServerInstance } from './server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

const GOLDEN = new URL('./__golden__/toolSurface2260.json', import.meta.url);

type Variant = { auth: Record<string, unknown> };
const IMPERSONATION = { sessionId: 's', actorUserId: 'admin', orgId: 'o', expiresAt: new Date('2099-01-01') };
/** One principal of each kind that changes which tools register. */
const VARIANTS: Record<string, Variant> = {
  user: { auth: { userId: 'u-a', roles: ['ADMIN'], clientId: 'github:a' } },
  userWithApp: { auth: { userId: 'u-b', roles: ['READER'], clientId: 'github:b', appId: 'app-b', organizationId: 'org-b' } },
  appKeyOnly: { auth: { appId: 'app-c', appKeyId: 'key-c', roles: [] } },
  impersonation: { auth: { userId: 'u-d', roles: ['READER'], clientId: 'github:d', impersonation: IMPERSONATION } },
};

const build = (auth: Record<string, unknown>) =>
  createMcpServerInstance(auth as never, () => undefined, { kind: 'multi-app' });

async function withClient<T>(auth: Record<string, unknown>, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = build(auth);
  const client = new Client({ name: 'shapes-2260', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** The whole advertised tool surface, in the order the server lists it. */
async function surface(auth: Record<string, unknown>) {
  return withClient(auth, async (client) => {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations ?? null }));
  });
}

describe('#2260 wire surface is unchanged', () => {
  it('lists the same tools, descriptions, annotations and JSON Schema as the pinned golden for every principal kind', async () => {
    // One sha256 per tool over its complete advertised definition: byte-identical or it names the tool that moved.
    const hashes = async (auth: Record<string, unknown>) =>
      (await surface(auth)).map((t) => [t.name, crypto.createHash('sha256').update(JSON.stringify(t)).digest('hex')] as const);
    const actual: Record<string, Array<readonly [string, string]>> = {};
    for (const [name, v] of Object.entries(VARIANTS)) actual[name] = await hashes(v.auth);
    if (process.env.UPDATE_TOOL_GOLDEN === '1') {
      fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + '\n');
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as typeof actual;
    for (const name of Object.keys(VARIANTS)) {
      // Tool set first, so a missing or extra registration reads as that and not as a hash diff.
      expect(actual[name].map(([n]) => n), `${name}: tool set`).toEqual(baseline[name].map(([n]) => n));
      expect(actual[name], `${name}: wire surface`).toEqual(baseline[name]);
    }
  });

  it('keeps the retired team-attention tools absent for every principal (#3082)', async () => {
    const names = async (auth: Record<string, unknown>) => (await surface(auth)).map((t) => t.name);
    const user = await names(VARIANTS.user.auth);
    const app = await names(VARIANTS.appKeyOnly.auth);
    for (const t of ['hadron_team_attention', 'hadron_team_attention_page', 'hadron_team_attention_switchover', 'hadron_team_chat_mark_read']) {
      expect(user).not.toContain(t);
      expect(app).not.toContain(t);
    }
  });
});

describe('#2260 per-session state stays per-session', () => {
  it('answers each concurrent principal from its own auth, even though both instances exist before either is called', async () => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { id: generateId(), name: 'Iso', urn: 'iso2260' } });
    const mkUser = (handle: string) => db.user.create({ data: { id: generateId(), handle, githubUsername: handle } });
    const [ua, ub] = [await mkUser('iso-a'), await mkUser('iso-b')];
    for (const [slug, u] of [['alpha-app', ua], ['beta-app', ub]] as const) {
      const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: slug, urn: `iso2260:${slug}` } });
      await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'owner' } });
    }
    const a = build({ userId: ua.id, roles: ['READER'], clientId: 'github:iso-a' });
    const b = build({ userId: ub.id, roles: ['READER'], clientId: 'github:iso-b' });
    const ca = new Client({ name: 'a', version: '1' });
    const cb = new Client({ name: 'b', version: '1' });
    const [la, ra] = InMemoryTransport.createLinkedPair();
    const [lb, rb] = InMemoryTransport.createLinkedPair();
    await a.connect(ra); await ca.connect(la);
    await b.connect(rb); await cb.connect(lb);
    try {
      const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');
      const [ta, tb] = await Promise.all([
        ca.callTool({ name: 'hadron_list_apps', arguments: {} }),
        cb.callTool({ name: 'hadron_list_apps', arguments: {} }),
      ]);
      expect(text(ta)).toContain('alpha-app');
      expect(text(ta)).not.toContain('beta-app');
      expect(text(tb)).toContain('beta-app');
      expect(text(tb)).not.toContain('alpha-app');
    } finally {
      await ca.close(); await cb.close(); await a.close(); await b.close();
    }
  });

  it('shares parameter schemas across instances without any call mutating them', async () => {
    // A plain user principal, which also registers the userId-gated tools (see the presence test above).
    const a = build(VARIANTS.user.auth);
    const b = build(VARIANTS.user.auth);
    type Registered = Record<string, { inputSchema?: z.ZodObject<z.ZodRawShape> }>;
    const regA = (a as unknown as { _registeredTools: Registered })._registeredTools;
    const regB = (b as unknown as { _registeredTools: Registered })._registeredTools;
    const names = Object.keys(regA).filter((n) => Object.keys(regA[n].inputSchema?.shape ?? {}).length > 0);
    expect(names.length).toBeGreaterThan(50) // #3082: 71 team registrations intentionally removed; all remaining shapes checked below.;

    // Every field schema is the same object in both instances: the hoist actually happened.
    const unshared: string[] = [];
    for (const n of names) {
      for (const [field, schema] of Object.entries(regA[n].inputSchema!.shape)) {
        if (regB[n].inputSchema!.shape[field] !== schema) unshared.push(`${n}.${field}`);
      }
    }
    expect(unshared, 'fields rebuilt per instance (keep any that depend on session state inline, and list them in the PR)').toEqual([]);

    // Snapshot the whole shared graph (JSON Schema covers nested definitions, defaults and bounds), drive both
    // instances through registration + real invocations, and compare again.
    const snap = () => JSON.stringify(names.map((n) => z.toJSONSchema(regA[n].inputSchema!, { io: 'input', unrepresentable: 'any' })));
    const before = snap();
    const ca = new Client({ name: 'a', version: '1' });
    const cb = new Client({ name: 'b', version: '1' });
    const [la, ra] = InMemoryTransport.createLinkedPair();
    const [lb, rb] = InMemoryTransport.createLinkedPair();
    await a.connect(ra); await ca.connect(la);
    await b.connect(rb); await cb.connect(lb);
    try {
      for (const c of [ca, cb, ca]) {
        await c.callTool({ name: 'hadron_whoami', arguments: {} });
        await c.callTool({ name: 'hadron_find_nodes', arguments: { query: 'x', limit: 3 } });
        await c.callTool({ name: 'hadron_search', arguments: { query: 'x' } });
      }
    } finally {
      await ca.close(); await cb.close(); await a.close(); await b.close();
    }
    expect(snap()).toBe(before);
  });
});

describe('#2260 retained heap per MCP session', () => {
  it('stays under the bound (today: ~15.5 MB per instance; shared shapes: ~1.1 MB)', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const heapMb = () => { gc(); gc(); return process.memoryUsage().heapUsed / 1048576; };
    const keep: unknown[] = [];
    keep.push(build(VARIANTS.user.auth)); // warm: first instance pays the one-time module-scope cost
    const base = heapMb();
    const N = 10;
    for (let i = 0; i < N; i++) keep.push(build(VARIANTS.user.auth));
    const perInstance = (heapMb() - base) / N;
    // Wide margin on purpose: the red baseline is ~15.5 and the hoisted target ~1.1, so 4 cannot flake on GC noise.
    expect(perInstance, `retained MB per instance (measured ${perInstance.toFixed(2)})`).toBeLessThan(4);
    expect(keep.length).toBe(N + 1);
  }, 120_000);
});
