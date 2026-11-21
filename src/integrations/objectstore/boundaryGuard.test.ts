import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #905 fixture test for the object-store import boundary guard
 * (`scripts/check-objectstore-boundary.sh`, run by the
 * `object-store-import-boundary` CI lane).
 *
 * The guard CI runs and the guard this test proves are the same code: the
 * test points the script at fixture trees via its tree argument.
 *
 * The forbidden strings below are assembled at runtime (join('/')) rather
 * than written as literals: this test file lives under src/, and the SDK
 * check's exclusion covers only objectstore/s3/ — so a literal S3 SDK spec,
 * a noncanonical provider path or the retired r2 path in THIS source would
 * itself violate the guard the test defends.
 */

// The S3 client SDK import — never spelled as one literal in this file.
const SDK_S3_IMPORT = `import { S3Client } from '${['@aws-sdk', 'client-s3'].join('/')}';`;
// The S3 presigner SDK import — same rule.
const SDK_PRESIGN_IMPORT = `import { getSignedUrl } from '${['@aws-sdk', 's3-request-presigner'].join('/')}';`;
// The SageMaker SDK — an unrelated AWS SDK package the guard must NOT flag.
const SDK_UNRELATED_IMPORT = `import { SageMakerRuntimeClient } from '${['@aws-sdk', 'client-sagemaker'].join('/')}';`;
// The retired r2 integration path — assembled, never spelled as one literal.
const RETIRED_PATH = ['integrations', 'r2'].join('/');
// The legal scaffold import.
const SCAFFOLD_IMPORT = "import { getObjectStore } from 'src/integrations/objectstore/index.js';";
// A canonical deep provider reference, 'objectstore/s3/client.js'.
const PROVIDER_REF = `import { S3Client } from 'src/integrations/objectstore/${['s3', 'client.js'].join('/')}';`;
// A NONCANONICAL but equivalent provider reference (a '.' path segment
// inserted): it resolves to the provider without containing the literal
// provider path the naive guard would grep for.
const PROVIDER_NONCANONICAL_REF = `import { S3Client } from 'src/integrations/objectstore/${['.', 's3', 'client.js'].join('/')}';`;

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-objectstore-boundary.sh');

function makeTree(): string {
  return mkdtempSync(join(tmpdir(), 'objectstore-boundary-'));
}

function write(tree: string, relPath: string, content: string): void {
  const abs = join(tree, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${content}\n`);
}

function runGuard(tree: string) {
  return spawnSync('bash', [SCRIPT, tree], { encoding: 'utf8', timeout: 30_000 });
}

describe('object-store import boundary guard (#905)', () => {
  it('accepts a clean tree: scaffold imports and unrelated AWS SDK packages', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/store.ts', SCAFFOLD_IMPORT);
      write(tree, 'lib/embedding/client-sagemaker.ts', SDK_UNRELATED_IMPORT);
      // Provider-internal files may reference the provider and its SDK.
      write(
        tree,
        'integrations/objectstore/s3/client.ts',
        `${SDK_S3_IMPORT}\n${SDK_PRESIGN_IMPORT}\n${PROVIDER_REF}`,
      );
      const res = runGuard(tree);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('OK');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('rejects a direct S3 SDK import outside the provider directory (F1)', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/directSdk.ts', SDK_S3_IMPORT);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/directSdk.ts');
      expect(res.stdout).toContain('S3-family AWS SDK');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('rejects a noncanonical provider reference (objectstore/./s3) outside the scaffold (F2)', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/noncanonical.ts', PROVIDER_NONCANONICAL_REF);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/noncanonical.ts');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('rejects a canonical provider reference outside the scaffold', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/deepRef.ts', PROVIDER_REF);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/deepRef.ts');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('rejects the retired r2/ path', () => {
    const tree = makeTree();
    try {
      write(
        tree,
        'lib/asset/legacy.ts',
        `import { getObjectStore } from 'src/${RETIRED_PATH}/client.js';`,
      );
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/legacy.ts');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('reports every violation at once, not just the first', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/a.ts', SDK_S3_IMPORT);
      write(tree, 'lib/asset/b.ts', PROVIDER_REF);
      write(tree, 'lib/asset/c.ts', `import x from 'src/${RETIRED_PATH}';`);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/a.ts');
      expect(res.stdout).toContain('lib/asset/b.ts');
      expect(res.stdout).toContain('lib/asset/c.ts');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('fails with exit 2 on a search error, never OK (F3)', () => {
    const res = spawnSync('bash', [SCRIPT, join(tmpdir(), 'no-such-tree-905')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain('OK');
  });

  it('is clean against the real src/ tree (what CI scans)', () => {
    const res = runGuard(join(REPO_ROOT, 'src'));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('OK');
  });
});
