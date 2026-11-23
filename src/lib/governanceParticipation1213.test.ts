/** #1213: explicit signal attempts, including clearing, must stay as complete as GovernedState. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as governance from './governedRole.js';

describe('input-triggered governance participation', () => {
  it.each([
    ['ordinary omitted', 'update', {}, undefined, false],
    ['role promotion', 'update', { role: 'review' }, undefined, true],
    ['role null', 'update', { role: null }, undefined, true],
    ['role whitespace', 'update', { role: '  ' }, undefined, true],
    ['runnable promotion', 'update', { isRunnable: true }, undefined, true],
    ['runnable demotion', 'update', { isRunnable: false }, undefined, true],
    ['runnable clear', 'update', { isRunnable: null }, undefined, true],
    ['create', 'create', {}, undefined, true],
    ['upsert/revival', 'upsert', {}, undefined, true],
    ['kind content only', 'update', {}, 'review', true],
  ])('%s', (_name, mode, input, kind, expected) => {
    expect(governance.mayChangeGovernance(mode as string, input as governance.GovernedState, kind as governance.GovernedKind | undefined)).toBe(expected);
  });

  it('reads EVERY GovernedState member: adding a signal without extending the predicate fails this pin', () => {
    const source = ts.createSourceFile('governedRole.ts', readFileSync(new URL('./governedRole.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'GovernedState')!;
    expect(declaration).toBeDefined();
    expect(declaration.heritageClauses).toBeUndefined(); // extending via inheritance requires this completeness check to expand too
    const fields = declaration.members.map(member => member.name!.getText(source)).sort();
    const read = new Set<string>();
    const input = new Proxy({}, { get(_target, key) { read.add(String(key)); return undefined; } });
    expect(governance.mayChangeGovernance('update', input)).toBe(false);
    expect([...read].sort()).toEqual(fields);
  });
});
