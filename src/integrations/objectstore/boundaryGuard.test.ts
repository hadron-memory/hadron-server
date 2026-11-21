import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #905 fixture test for the object-store import boundary guard
 * (`scripts/check-objectstore-boundary.mjs`, run by the
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
// The S3 Control SDK — a DIFFERENT package whose name starts like client-s3;
// an exact-match package comparison must not flag it (#4668 delta P3).
const SDK_S3_CONTROL_IMPORT = `import { S3ControlClient } from '${['@aws-sdk', 'client-s3-control'].join('/')}';`;
// A DOTTED near-name — also a different package (dots are legal in npm
// names), so neither the raw-line pattern nor the package comparison may
// flag it (#4668 BLIND delta P3, Baloo).
const SDK_S3_DOTTED_IMPORT = `import { Whatever } from '${['@aws-sdk', 'client-s3.foo'].join('/')}';`;
// A subpath import of the BANNED package — same package, must stay flagged.
const SDK_S3_SUBPATH_IMPORT = `import { S3Client } from '${['@aws-sdk', 'client-s3', 'dist-cjs', 'index.js'].join('/')}';`;
// The banned SDK named at sentence end in a comment — the raw-line check
// exists to catch comments, and must keep catching this one after the dotted
// near-name is allowed (dot followed by whitespace ends the token; a dot
// followed by a non-space character continues the package name).
const SDK_S3_SENTENCE_END_COMMENT = `// do not import ${['@aws-sdk', 'client-s3'].join('/')}. it bypasses the scaffold.`;
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
// A TRAVERSAL-equivalent provider reference (a named directory plus a ..
// hop): it resolves to the provider when extra/ exists and evades every
// literal-spelling pattern (#4668 delta P2, Beckett's probe).
const PROVIDER_TRAVERSAL_REF = `import { S3Client } from 'src/integrations/objectstore/${['extra', '..', 's3', 'client.js'].join('/')}';`;
// A deeper traversal (two named hops and two .. hops): still resolves to
// the provider; proves the resolver balances segments, not just one pair.
const PROVIDER_DEEP_TRAVERSAL_REF = `import { S3Client } from 'src/integrations/objectstore/${['a', 'b', '..', '..', 's3', 'client.js'].join('/')}';`;
// A traversal import preceded on the SAME line by a block comment containing
// an apostrophe: the stray quote shifts naive left-to-right string pairing
// so the real specifier is never extracted (#4668 LOCAL delta P2, Beckett —
// the guard said OK while Node imported the module). Relative spec form.
const PROVIDER_TRAVERSAL_REL_SPEC = ['./integrations', 'objectstore', 'extra', '..', 's3', 'client.js'].join('/');
const PROVIDER_APOSTROPHE_SHIFT_REF = `/* ' */ import { value } from '${PROVIDER_TRAVERSAL_REL_SPEC}';`;
// The retired r2 path in a NONCANONICAL spelling: integrations/./r2 resolves
// to the same two segments, so the tripwire must fire on it too (#4668 LOCAL
// delta P3).
const RETIRED_NONCANONICAL_SPEC = ['src', 'integrations', '.', 'r2'].join('/');

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-objectstore-boundary.mjs');

function makeTree(): string {
  return mkdtempSync(join(tmpdir(), 'objectstore-boundary-'));
}

function write(tree: string, relPath: string, content: string): void {
  const abs = join(tree, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${content}\n`);
}

function runGuard(tree: string) {
  return spawnSync(process.execPath, [SCRIPT, tree], { encoding: 'utf8', timeout: 30_000 });
}

describe('object-store import boundary guard (#905)', () => {
  it('accepts a clean tree: scaffold imports and unrelated AWS SDK packages', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/store.ts', SCAFFOLD_IMPORT);
      write(tree, 'lib/embedding/client-sagemaker.ts', SDK_UNRELATED_IMPORT);
      // A package whose name merely STARTS like the banned one is legal.
      write(tree, 'lib/control/s3Control.ts', SDK_S3_CONTROL_IMPORT);
      // A package whose name merely starts like the banned one and adds a
      // DOTTED continuation is legal too.
      write(tree, 'lib/asset/dotted.ts', SDK_S3_DOTTED_IMPORT);
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

  it('rejects a traversal-equivalent provider reference (objectstore/extra/../s3) outside the scaffold (delta P2)', () => {
    const tree = makeTree();
    try {
      // The intermediate directory exists in the fixture, as it would beside
      // a real import: the hop is valid filesystem resolution, not a typo.
      write(tree, 'integrations/objectstore/extra/placeholder.ts', 'export {};');
      write(tree, 'lib/asset/traversal.ts', PROVIDER_TRAVERSAL_REF);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/traversal.ts');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('rejects a balanced deep traversal (objectstore/a/b/../../s3) outside the scaffold', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/deepTraversal.ts', PROVIDER_DEEP_TRAVERSAL_REF);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/deepTraversal.ts');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('rejects a traversal import shifted by an apostrophe in an adjacent block comment (LOCAL delta P2)', () => {
    const tree = makeTree();
    try {
      // The intermediate directory and provider module exist, as they would
      // beside a real import: Beckett's probe ran this line under Node and
      // the import resolved (the guard returned OK before the fix).
      write(tree, 'integrations/objectstore/extra/placeholder.ts', 'export {};');
      write(tree, 'integrations/objectstore/s3/client.js', 'export const value = 42;');
      write(tree, 'lib/asset/apostropheShift.ts', PROVIDER_APOSTROPHE_SHIFT_REF);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/apostropheShift.ts');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('rejects the retired r2 path in a noncanonical spelling (integrations/./r2) (LOCAL delta P3)', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/legacyNoncanonical.ts', `import x from '${RETIRED_NONCANONICAL_SPEC}';`);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/legacyNoncanonical.ts');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('does not flag a differently-named dotted package (client-s3.foo) (BLIND delta P3)', () => {
    const tree = makeTree();
    try {
      // Dots are legal in npm package names: client-s3.foo is NOT the
      // banned S3 client package, and a tree importing only it is clean.
      write(tree, 'lib/asset/dotted.ts', SDK_S3_DOTTED_IMPORT);
      const res = runGuard(tree);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('OK');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('still flags the banned SDK named at sentence end in a comment', () => {
    const tree = makeTree();
    try {
      write(tree, 'lib/asset/prose.ts', SDK_S3_SENTENCE_END_COMMENT);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/prose.ts');
      expect(res.stdout).toContain('S3-family AWS SDK');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('still flags a subpath import of the banned package (a /-continued path is the same package)', () => {
    const tree = makeTree();
    try {
      // A subpath import is still the banned package: the boundary character
      // after the package name is '/', which is not part of any name.
      write(tree, 'lib/asset/subpath.ts', SDK_S3_SUBPATH_IMPORT);
      const res = runGuard(tree);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('lib/asset/subpath.ts');
      expect(res.stdout).toContain('S3-family AWS SDK');
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
    const res = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'no-such-tree-905')], {
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
