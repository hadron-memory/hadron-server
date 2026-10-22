/**
 * #2245 source pins for amendments 3-4b: the lock order inside `cloneAgent`, `writeAgentBase` as the only
 * writer of `extends_agent_id`, and the key-before-row order every channel-host key holder keeps (the
 * premise of the clone's inverse-order proof). Static: they fail when a refactor reorders a lock.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const read = (p: string) => readFileSync(p, 'utf8');
const srcFiles = () =>
  execFileSync('git', ['ls-files', 'src/**/*.ts', 'src/*.ts'], { encoding: 'utf8' })
    .split('\n').filter((f) => f && !/\.test\.ts$/.test(f) && !f.includes('/generated/') && !f.includes('/test/'));

function inOrder(text: string, needles: string[]) {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    expect(i, `missing or out of order: ${n}`).toBeGreaterThan(at);
    at = i;
  }
}

describe('cloneAgent lock order', () => {
  const text = read('src/lib/agentClone/cloneAgent.ts');
  it('takes the anchors exclusively, then the advisory key and graph lock, then memory rows, agent rows', () => {
    expect(text).toContain("lockMode: 'exclusive'");
    inOrder(text, [
      'await withAuthorizedTx(',
      'afterAnchors: async (tx) => {',
      'await lockMemoryForChannelChange(tx, plan.systemMemoryId)',
      'await lockAgentBaseGraph(tx)',
      'afterLock: async (tx) => {',
      'FOR UPDATE`',
      'FOR SHARE`',
      'FROM agents WHERE id = ${id} FOR SHARE',
      'samePlan(plan, fresh)',
    ]);
  });
  it('takes each lock exactly once, so an earlier stray call cannot hide behind the ordered one', () => {
    for (const once of ['lockMemoryForChannelChange(tx', 'lockAgentBaseGraph(tx)', 'FOR UPDATE`']) {
      expect(text.split(once).length - 1, once).toBe(1);
    }
  });
  it('sorts the memory rows by id before locking them', () => {
    expect(text).toMatch(/\.sort\(\(a, b\) => a\.id\.localeCompare\(b\.id\)\);\s*for \(const m of memoryLocks\)/);
  });
  it('reads, copies, subscribes, validates, then audits, in that order', () => {
    const body = text.slice(text.indexOf('async function writeClone'));
    inOrder(body, [
      'const read1 = await fingerprint(tx, plan)',
      'await cloneMemoryGraphInTx(',
      'await licenseFor(txCtx, tx, target.orgId, imp.importedAgentId',
      'await writeAgentBase(',
      'await afterCopy()',
      'const read3 = await fingerprint(tx, plan)',
      'throw new CloneRetry()',
      'await tx.agentCloneAudit.create(',
    ]);
  });
  it('re-classifies after a subscribe and requires LICENSED', () => {
    const body = text.slice(text.indexOf('async function licenseFor'));
    inOrder(body, ['classifyOrgAgentLicense(tx, orgId, agentId)', 'subscribeOrgToPublicAgentInTx(', "classifyOrgAgentLicense(tx, orgId, agentId)) !== 'LICENSED'"]);
  });
});

describe('the single writer of extends_agent_id', () => {
  it('only src/lib/agentBase.ts assigns the column', () => {
    const writers: string[] = [];
    for (const file of srcFiles()) {
      const code = read(file);
      if (!/extendsAgentId|extends_agent_id/.test(code)) continue;
      const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
      let writes = /(SET|INSERT[^;`]*)\s[^;`]*extends_agent_id/i.test(code) && /UPDATE\s+agents|INSERT\s+INTO\s+agents/i.test(code);
      const visit = (n: ts.Node) => {
        if (ts.isPropertyAssignment(n) && n.name.getText() === 'extendsAgentId') {
          for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
            if (ts.isPropertyAssignment(p) && p.name.getText() === 'data') { writes = true; break; }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (writes) writers.push(file);
    }
    expect(writers).toEqual(['src/lib/agentBase.ts']);
  });
});

describe('channel-host key holders take the key before any memory row lock', () => {
  const KEY = /\b(lockMemoryForChannelChange|lockEdgeEndpointMemories|lockLiveEdgeEndpoints)\(/;
  const ROW_LOCK = /FROM\s+memories[^`;]*FOR\s+(UPDATE|SHARE|NO KEY UPDATE)/i;
  it('no function locks a memory row before its first key call', () => {
    const offenders: string[] = [];
    let holders = 0;
    for (const file of srcFiles()) {
      const code = read(file);
      if (!KEY.test(code)) continue;
      const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        const fn = n as ts.FunctionLikeDeclaration;
        if (ts.isFunctionLike(n) && fn.body) {
          // Only calls directly in this function (not in a nested one) belong to it.
          const own = (node: ts.Node, acc: ts.Node[] = []): ts.Node[] => {
            ts.forEachChild(node, (c) => {
              if (ts.isFunctionLike(c)) return;
              acc.push(c);
              own(c, acc);
            });
            return acc;
          };
          const nodes = own(fn.body);
          const firstKey = nodes.find((c) => ts.isCallExpression(c) && /^(lockMemoryForChannelChange|lockEdgeEndpointMemories|lockLiveEdgeEndpoints)$/.test(c.expression.getText().replace(/^.*\./, '')));
          if (firstKey) {
            holders++;
            const before = code.slice(fn.body.getStart(), firstKey.getStart());
            const lockedFirst = nodes.some((c) => c.getStart() < firstKey.getStart() && ts.isTemplateLiteral(c) === false && ts.isNoSubstitutionTemplateLiteral(c) && ROW_LOCK.test(c.getText()))
              || nodes.some((c) => c.getStart() < firstKey.getStart() && ts.isTaggedTemplateExpression(c) && ROW_LOCK.test(c.getText()));
            if (lockedFirst || ROW_LOCK.test(before.replace(/\/\/.*$/gm, ''))) {
              offenders.push(`${file}:${sf.getLineAndCharacterOfPosition(firstKey.getStart()).line + 1}`);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(holders).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
