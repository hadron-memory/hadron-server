/**
 * #3921: the GraphQL `getAccessibleMemoryIds` returns a materialised id list for every caller, never an
 * unrestricted `null` (cor:acl:120:01, "A lens never grants"). After #3916 retired the operator principal it
 * had no null path left; this pins that the type says so and that no caller reads null as read-all.
 *
 * The MCP function of the same name (`src/mcp/access-control.ts`) is a different export whose ADMIN/OWNER -> null
 * is a live contract and is NOT narrowed here; the last test pins that it stays.
 */
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { narrowToAccessible } from '../../../lib/auth/narrowToAccessible.js';
import { getAccessibleMemoryIds as mcpAccessibleMemoryIds } from '../../../mcp/access-control.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { resolvers } from './resolvers.js';
import { getAccessibleMemoryIds, type Context } from './resolvers.helpers.js';

const HELPERS = resolve('src/api/graphql/schema/resolvers.helpers.ts');

/** The exported GraphQL function's declaration, parsed from source so a regression is red at runtime, not only in tsc. */
function declaration(): ts.FunctionDeclaration {
  const source = ts.createSourceFile(HELPERS, readFileSync(HELPERS, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = source.statements.find((s): s is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(s) && s.name?.text === 'getAccessibleMemoryIds' &&
    !!s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  if (!found) throw new Error('getAccessibleMemoryIds export not found');
  return found;
}

/** The value a return statement yields once casts, parentheses and non-null assertions are peeled off. */
function peel(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** `return` statements of the function itself, not of closures declared inside it. */
function ownReturns(fn: ts.FunctionDeclaration): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  (function visit(n: ts.Node) {
    if (ts.isReturnStatement(n)) out.push(n);
    if (n !== fn && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
    ts.forEachChild(n, visit);
  })(fn.body!);
  return out;
}

describe('#3921 the declared contract', () => {
  it('returns Promise<string[]>, with no null in the annotation', () => {
    expect(declaration().type?.getText()).toBe('Promise<string[]>');
  });

  it('has no return path that yields null or undefined', () => {
    const bad = ownReturns(declaration()).filter(r => {
      const e = r.expression && peel(r.expression);
      return !e || e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
    });
    expect(bad.map(r => r.getText())).toEqual([]);
  });

  it('is typed so a caller cannot see null (checked by tsc)', () => {
    expectTypeOf(getAccessibleMemoryIds).returns.resolves.toEqualTypeOf<string[]>();
  });
});

describe('#3921 a materialised set for every caller class', () => {
  let ownerUser: { id: string }; let other: { id: string };
  let othersPersonal: string; let publicMemory: string;
  const ctx = (userId: string | undefined, roles: Context['roles']): Context => ({ db, userId, roles }) as Context;

  beforeEach(async () => {
    await cleanDb(db);
    ownerUser = await db.user.create({ data: { id: generateId(), handle: `ids3921a${generateId().slice(-6)}` } });
    other = await db.user.create({ data: { id: generateId(), handle: `ids3921b${generateId().slice(-6)}` } });
    othersPersonal = (await db.memory.create({ data: {
      id: generateId(), urn: `ids3921:personal:${generateId()}`, name: 'Personal', class: 'personal', userId: other.id, ownerUserId: other.id,
    } })).id;
    publicMemory = (await db.memory.create({ data: {
      id: generateId(), urn: `ids3921:public:${generateId()}`, name: 'Public', class: 'knowledge', visibility: 'PUBLIC', ownerUserId: other.id,
    } })).id;
  });

  it.each([['ADMIN'], ['OWNER']] as const)('a platform %s gets a list that still excludes another user personal memory', async role => {
    const ids = await getAccessibleMemoryIds(ctx(ownerUser.id, [role]));
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).not.toContain(othersPersonal);
  });

  it('an unauthenticated caller gets a list that excludes another user personal memory', async () => {
    const ids = await getAccessibleMemoryIds(ctx(undefined, []));
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).not.toContain(othersPersonal);
  });

  it('a userless, App-less context gets a bounded list, not read-all (#3705)', async () => {
    const ids = await getAccessibleMemoryIds({ db, roles: [] } as Context);
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).not.toContain(othersPersonal);
  });

  it('a scope never grants: an ADMIN narrowing keeps only what the list admits', async () => {
    const ids = await getAccessibleMemoryIds(ctx(ownerUser.id, ['ADMIN']));
    const { kept, droppedIds } = narrowToAccessible([othersPersonal, publicMemory], new Set(ids));
    expect(droppedIds).toContain(othersPersonal);
    expect(kept).not.toContain(othersPersonal);
  });
});

describe('#3921 callers keep filtering by the materialised list', () => {
  let orgId: string; let a: { id: string }; let b: { id: string }; let chA: string; let chB: string;
  const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

  beforeEach(async () => {
    await cleanDb(db);
    const t = generateId().slice(-8);
    orgId = (await db.organization.create({ data: { id: generateId(), name: `ids3921-${t}`, urn: `ids3921-${t}` } })).id;
    const user = (tag: string) => db.user.create({ data: { id: generateId(), handle: `ids3921${tag}${t}` } });
    a = await user('a'); b = await user('b');
    for (const u of [a, b]) await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: u.id, role: 'CONTRIBUTOR' } });
    const personal = (u: { id: string }, tag: string) => db.memory.create({ data: {
      id: generateId(), organizationId: orgId, urn: `ids3921-${t}:${tag}`, name: tag, class: 'personal', userId: u.id, visibility: null,
    } });
    const [ma, mb] = [await personal(a, 'notes-a'), await personal(b, 'notes-b')];
    chA = (await ensureChannelWithRoot(db, { memoryId: ma.id, loc: 'chats:a', name: 'a', createdBy: a.id })).channel.id;
    chB = (await ensureChannelWithRoot(db, { memoryId: mb.id, loc: 'chats:b', name: 'b', createdBy: b.id })).channel.id;
  });

  it('Query.channels lists only the channels whose host memory the caller can read', async () => {
    const page = await (resolvers.Query as any).channels({}, { orgId }, ctx(b.id));
    const ids = page.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(chB);
    expect(ids).not.toContain(chA);
  });

  it('Ticker.channels shows only the channels the reader can read, not the stored list', async () => {
    const shown = await (resolvers as any).Ticker.channels({ channelIds: [chA, chB] }, {}, ctx(b.id));
    expect(shown.map((c: { id: string }) => c.id)).toEqual([chB]);
  });
});

describe('#3921 the narrowToAccessible sentinel is gone (cor:acl:120:01)', () => {
  it('accepts only a materialised set', () => {
    const source = readFileSync(resolve('src/lib/auth/narrowToAccessible.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/unrestricted/);
  });
});

describe('#3921 the MCP function of the same name is untouched', () => {
  it.each([['ADMIN'], ['OWNER']] as const)('keeps its live %s -> null contract', async role => {
    const auth = { userId: generateId(), roles: [role] } as unknown as AuthContext;
    expect(await mcpAccessibleMemoryIds(db, auth)).toBeNull();
  });
});
