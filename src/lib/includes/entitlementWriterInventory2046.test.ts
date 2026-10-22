/**
 * #2046 S9-3 census tripwire: every writer of compile-relevant authority (grants, subscriptions, installs,
 * Agent base/retirement/pointer, Worker retirement/pointer) is listed with its fence status. A new write
 * site fails this test until it is classified, so a writer cannot be added outside the #2063 fence unseen.
 * Not a substitute for the caller audit: it counts call sites per file, it does not prove lock order (the
 * behavioural pins are in resolvers.writerFences2046.test.ts).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const MODELS = ['agentOrgGrant', 'agentSubscription', 'appAgent', 'agent', 'worker'];
const WRITES = ['create', 'createMany', 'upsert', 'update', 'updateMany', 'delete', 'deleteMany'];
const TABLES = ['agent_org_grants', 'agent_subscriptions', 'app_agents', 'agents', 'workers'];
const RAW = new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"?(${TABLES.join('|')})"?\\b`, 'gi');

it('classifies every write site of compile-relevant entitlement, base, retirement and pointer state', () => {
  const inventory = JSON.parse(readFileSync(new URL('./entitlementWriterInventory2046.json', import.meta.url), 'utf8')) as
    Record<string, { count: number; status: string; reason: string }>;
  const counts: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const name = relative(root, file);
      if (entry.isDirectory()) {
        if (entry.name !== 'generated' && name !== 'src/test') walk(file);
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        const text = readFileSync(file, 'utf8');
        const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
        const bump = (key: string) => { counts[`${name} :: ${key}`] = (counts[`${name} :: ${key}`] ?? 0) + 1; };
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const m = /\.(\w+)\.(\w+)$/.exec(node.expression.getText(tree));
            if (m && MODELS.includes(m[1]) && WRITES.includes(m[2])) bump(`${m[1]}.${m[2]}`);
          }
          if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
            for (const hit of node.getText(tree).matchAll(RAW)) bump(`raw ${hit[1].toUpperCase().replace(/\s+/g, ' ')} ${hit[2]}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(tree);
      }
    }
  };
  walk(join(root, 'src'));
  expect(Object.fromEntries(Object.entries(counts).sort())).toEqual(
    Object.fromEntries(Object.entries(inventory).map(([k, v]) => [k, v.count]).sort()),
  );
  for (const [key, v] of Object.entries(inventory)) {
    expect(['fenced', 'counterparty-pending', 'excluded'], key).toContain(v.status);
    expect(v.reason.length, key).toBeGreaterThan(10);
  }
});
