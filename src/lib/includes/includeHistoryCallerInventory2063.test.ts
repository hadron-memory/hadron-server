/** API census tripwire, not a substitute for the final raw-SQL/authority caller audit. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
it('requires explicit classification when a snapshot/reconcile/history-delete API site changes', () => {
  const inventory = JSON.parse(readFileSync(new URL('./includeHistoryCallerInventory2063.json', import.meta.url), 'utf8'));
  const counts: Record<string, number> = {};
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const name = relative(root, file);
      if (entry.isDirectory()) {
        if (entry.name !== 'generated' && name !== 'src/test') walk(file);
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        const text = readFileSync(file, 'utf8');
        if (!/createNodeRevision|ensureCurrentNodeRevisionInTransaction|reconcileNodeWithIncludeHistory|withReconciledNodeRead|nodeRevision|reconcileStampedSourceNodes|cloneMemoryGraphInTx/.test(text)) continue;
        const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node) {
          if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(tree);
            if (['createNodeRevision', 'ensureCurrentNodeRevisionInTransaction', 'reconcileNodeWithIncludeHistory', 'withReconciledNodeRead', 'reconcileStampedSourceNodes', 'cloneMemoryGraphInTx'].includes(callee)
              || /\.nodeRevision\.(delete|deleteMany)$/.test(callee)) {
              const key = `${name} :: ${callee}`;
              counts[key] = (counts[key] ?? 0) + 1;
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(tree);
      }
    }
  }
  walk(join(root, 'src'));
  expect(counts).toEqual(inventory);
});
