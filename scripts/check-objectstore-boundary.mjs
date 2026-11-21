#!/usr/bin/env node
// Object-store import boundary guard (#905).
//
// Call sites may import ONLY the provider-neutral scaffold
// `src/integrations/objectstore/index.js`. The provider implementation under
// `src/integrations/objectstore/s3/` — and the S3-family AWS SDK it wraps
// (@aws-sdk/client-s3, @aws-sdk/s3-request-presigner) — is an internal detail
// of the scaffold, and the retired `src/integrations/r2/` path must not come
// back.
//
// Path checks RESOLVE import strings instead of matching spellings: a string
// literal that lexically normalizes to a path entering objectstore/s3 is a
// violation whatever it was written as (./ segments, repeated slashes, or
// name/../ traversal hops — the forms a literal grep provably misses; #4668
// review, Baloo + Beckett). Canonical spellings are also flagged on the raw
// line, so a provider path named in a comment is still caught. SDK package
// names are compared EXACTLY after normalization, so the unrelated
// @aws-sdk/client-s3-control package is not flagged. The retired integrations/r2
// path is checked BOTH ways: raw substring (comments) and resolved segments
// (a noncanonical integrations/./r2 spelling is still the retired path).
//
// Text scanning, not TypeScript, because the boundary has to hold for the
// string paths inside `vi.mock(...)` calls too — those are invisible to
// `tsc --noEmit`, so a stale one fails only at test runtime.
//
// Usage: node scripts/check-objectstore-boundary.mjs [tree]   (default: src)
// The tree argument exists so tests can point the same checks at a fixture
// tree — the guard CI runs and the guard the tests prove are the same code.
// Exit codes: 0 = clean, 1 = boundary violation, 2 = search error (fail
// closed: an unreadable tree is never reported clean).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const TREE = resolve(process.argv[2] ?? 'src');
const FWD = (p) => p.split(sep).join('/');

const PROVIDER_EXEMPT = 'integrations/objectstore/'; // may reference its own provider dir
const SDK_EXEMPT = 'integrations/objectstore/s3/'; // may import the SDK it wraps
const BANNED_SDK_PACKAGES = new Set(['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']);

// Canonical spellings, checked against the raw line (comments included).
const CANONICAL_PROVIDER_RE = /objectstore(\/\.?)+s3/;
// The SDK lookahead must reject every character that can CONTINUE a package
// name: word characters, hyphens, and dots (dots are legal in npm names, so
// client-s3.foo is a different package — #4668 BLIND delta P3). But a dot
// followed by whitespace or end-of-line is a sentence END, not a name
// continuation, and still counts: `...from '@aws-sdk/client-s3.` in prose is
// the banned package named in a comment. A `/` after the name is a subpath
// import of the SAME package and stays flagged.
const CANONICAL_SDK_RE = /@aws-sdk\/(s3-request-presigner|client-s3)(?![\w-])(?!\.\S)/;

/** Collect files under dir recursively (deterministic order; symlinks skipped). */
function collectFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read directory ${dir}: ${err.code ?? err.message}`);
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) {
      collectFiles(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Lexically resolve a path string: '.', '' and '..' segments collapse.
 *  Leading '..'s (relative climbs past the string's start) are kept — they
 *  cannot create an objectstore→s3 adjacency that was not written. */
function normalizeSegments(specifier) {
  const stack = [];
  for (const seg of specifier.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop();
      else stack.push('..');
    } else {
      stack.push(seg);
    }
  }
  return stack;
}

function referencesProviderDir(segments) {
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i] === 'objectstore' && segments[i + 1] === 's3') return true;
  }
  return false;
}

function referencesRetiredDir(segments) {
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i] === 'integrations' && segments[i + 1] === 'r2') return true;
  }
  return false;
}

/** Candidate string bodies on a line: each quote paired with the NEXT quote
 *  of the same type. A left-to-right regex pairing is shifted by a stray
 *  apostrophe earlier on the line — a block comment containing one, right
 *  before a traversal import, makes the comment apostrophe pair with the
 *  import's opening quote, so the real body is never extracted (#4668 LOCAL
 *  delta P2, Beckett: guard said OK while Node imported the module).
 *  Immediate-next pairing cannot miss a real body: an unescaped string's
 *  opening quote is always followed by its closing quote before any other
 *  same-type quote. Stray apostrophes only add phantom candidates, which
 *  resolve nowhere. */
function candidateBodies(line) {
  const bodies = [];
  for (const q of ["'", '"', '`']) {
    for (let i = line.indexOf(q); i !== -1; ) {
      const j = line.indexOf(q, i + 1);
      if (j === -1) break;
      bodies.push(line.slice(i + 1, j));
      i = j;
    }
  }
  return bodies;
}

/** The package name of a bare specifier: '@scope/name' before any subpath,
 *  or the first segment for unscoped packages. */
function packageName(segments) {
  if (segments.length === 0) return null;
  if (segments[0].startsWith('@')) return segments.length > 1 ? `${segments[0]}/${segments[1]}` : segments[0];
  return segments[0];
}

const REMEDIES = {
  provider:
    'Call sites must import only integrations/objectstore/index.js (the scaffold). If a neutral operation is missing, extend the barrel rather than reaching into s3/.',
  sdk: 'The AWS SDK is an internal detail of the s3 provider. Add the operation to src/integrations/objectstore/ (the scaffold) and import that instead. (@aws-sdk packages other than client-s3 / s3-request-presigner, e.g. the SageMaker embedding client, are unaffected.)',
  r2: "Import the provider-neutral scaffold 'integrations/objectstore/index.js' instead.",
};
const TITLES = {
  provider: 'References to the s3 provider directory found outside src/integrations/objectstore/ (#905):',
  sdk: 'Direct imports of the S3-family AWS SDK found outside src/integrations/objectstore/s3/ (#905):',
  r2: 'References to the retired integrations/r2 path found (#905 moved it to integrations/objectstore):',
};

function main() {
  const violations = [];
  const files = collectFiles(TREE, []);

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ERR_IS_DIRECTORY' || err.code === 'EISDIR') continue;
      throw new Error(`cannot read file ${file}: ${err.code ?? err.message}`);
    }
    if (content.includes('\u0000')) continue; // binary — not source text

    const rel = FWD(relative(TREE, file));
    const providerExempt = rel.startsWith(PROVIDER_EXEMPT) || `${rel}/`.startsWith(PROVIDER_EXEMPT);
    const sdkExempt = rel.startsWith(SDK_EXEMPT) || `${rel}/`.startsWith(SDK_EXEMPT);

    const lines = content.split('\n');
    for (let n = 0; n < lines.length; n += 1) {
      const line = lines[n];
      const where = `${rel}:${n + 1}`;

      if (line.includes('integrations/r2')) {
        violations.push({ kind: 'r2', where, line: line.trim() });
      }

      if (!providerExempt && CANONICAL_PROVIDER_RE.test(line)) {
        violations.push({ kind: 'provider', where, line: line.trim() });
        continue; // already flagged on this line
      }

      if (!sdkExempt && CANONICAL_SDK_RE.test(line)) {
        violations.push({ kind: 'sdk', where, line: line.trim() });
        continue;
      }

      if (providerExempt && sdkExempt) continue; // inside s3/: everything internal

      // Resolving checks on every candidate string body on the line (catches
      // noncanonical and traversal spellings the canonical regexes miss, and
      // survives quote pairing shifted by comment apostrophes).
      for (const body of candidateBodies(line)) {
        const segments = normalizeSegments(body);
        if (!providerExempt && body.includes('objectstore') && referencesProviderDir(segments)) {
          violations.push({ kind: 'provider', where, line: line.trim() });
          break;
        }
        if (!sdkExempt && body.startsWith('@aws-sdk/')) {
          if (BANNED_SDK_PACKAGES.has(packageName(segments))) {
            violations.push({ kind: 'sdk', where, line: line.trim() });
            break;
          }
        }
        if (referencesRetiredDir(segments)) {
          violations.push({ kind: 'r2', where, line: line.trim() });
          break;
        }
      }
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.log(`::error::${TITLES[v.kind]}`);
      console.log(`${v.where}: ${v.line}`);
      console.log('');
      console.log(REMEDIES[v.kind]);
      console.log('');
    }
    console.log('Object-store import boundary: VIOLATION (see above).');
    process.exit(1);
  }
  console.log('OK — object-store import boundary holds (no retired r2/ path, no provider or S3-SDK reference outside the scaffold).');
}

try {
  main();
} catch (err) {
  console.error(`::error::Search error in object-store import boundary guard: ${err.message}`);
  process.exit(2);
}
