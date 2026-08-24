/**
 * The gate that keeps #1079 from regressing — proven to FAIL, not merely to pass.
 *
 * Its first version was a phantom: the `urn:` matcher was anchored to the start
 * of a line, while this codebase's dominant update idiom is the conditional
 * spread `...(x !== undefined ? { urn: x } : {})`. It therefore matched nothing,
 * passed on every file, and stayed green when a real `recordUrnRename` call was
 * deleted. These tests exist so that cannot recur silently.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run the checker against a throwaway repo containing one source file. */
function runOn(source: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'urn-gate-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.ts'), source);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const script = join(process.cwd(), 'scripts', 'check-urn-rename-aliased.mjs');
    try {
      const out = execFileSync('node', [script], { cwd: dir, encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stderr: string; stdout: string };
      return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-urn-rename-aliased', () => {
  it('FAILS on the conditional-spread idiom with no alias — the phantom case', () => {
    const r = runOn(`
      export async function rename(tx: any, id: string, newUrn?: string) {
        return tx.app.update({
          where: { id },
          data: { ...(newUrn !== undefined ? { urn: newUrn } : {}) },
        });
      }
    `);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/x.ts');
  });

  it('FAILS on a plain urn assignment with no alias', () => {
    const r = runOn(`
      export async function rename(tx: any, id: string, newUrn: string) {
        return tx.memory.update({ where: { id }, data: { urn: newUrn } });
      }
    `);
    expect(r.code).toBe(1);
  });

  it('FAILS on raw SQL that rewrites a urn column', () => {
    const r = runOn(`
      export async function cascade(tx: any) {
        await tx.$executeRaw\`UPDATE memories SET urn = 'x' WHERE id = '1'\`;
      }
    `);
    expect(r.code).toBe(1);
  });

  it('passes when the alias is recorded alongside', () => {
    const r = runOn(`
      export async function rename(tx: any, id: string, newUrn?: string) {
        await recordUrnRename(tx, { entityType: 'APP', entityId: id });
        return tx.app.update({
          where: { id },
          data: { ...(newUrn !== undefined ? { urn: newUrn } : {}) },
        });
      }
    `);
    expect(r.code).toBe(0);
  });

  it('passes when explicitly waived with a reason', () => {
    const r = runOn(`
      export async function rename(tx: any, id: string, newUrn: string) {
        // urn-alias-exempt: freshly minted row, no prior URN could have been published
        return tx.app.update({ where: { id }, data: { urn: newUrn } });
      }
    `);
    expect(r.code).toBe(0);
  });

  it('does NOT fire on an update that touches no urn', () => {
    const r = runOn(`
      export async function rename(tx: any, id: string) {
        return tx.app.update({ where: { id }, data: { name: 'x' } });
      }
    `);
    expect(r.code).toBe(0);
  });

  it('does NOT fire on a bare type declaration or SDL mentioning urn', () => {
    const r = runOn(`
      type App = { urn: string };
      export const typeDefs = 'type App { urn: String! }';
    `);
    expect(r.code).toBe(0);
  });
});
