// The migration-smoke lane's drift filter (#434 slice B).
//
// Reads the raw `prisma migrate diff --script` output on stdin, drops the
// lines the manifest whitelists (prisma/post-push-manifest.json — each row
// names the exact line and why it is acceptable), and writes the rest to
// stdout. Matching is EXACT STRING equality against the manifest row's
// `line`: any change to an object's definition changes the diff line, which
// then stops matching and re-surfaces as drift. Object-name ownership is NOT
// permission to ignore every definition difference.
//
// Exit codes: 0 filtered (stdout may be empty — an empty diff is success);
// 1 the manifest fails validation (the job goes red — a broken whitelist
// must never read as "no drift"); 2 usage.
//
// The generic noise lines (prisma banners, empty lines, the `-- CreateIndex`
// comment lines) are still filtered by the workflow's grep chain before this
// script; only object-level decisions live here.

import { loadManifest, ManifestError, whitelistedLines } from './postPushManifest.mjs';

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  console.error('usage: migrateDiffFilter.mjs <manifest.json>  (stdin: migrate diff output; stdout: real drift)');
  process.exit(2);
}

let lines;
try {
  lines = whitelistedLines(loadManifest(manifestPath));
} catch (err) {
  if (err instanceof ManifestError) {
    console.error(`migrate-diff filter: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const out = [];
  let dropped = 0;
  const matched = new Set(); // distinct whitelist rows this run consumed
  for (const line of input.split('\n')) {
    const candidate = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (lines.has(candidate)) { dropped++; matched.add(candidate); continue; }
    out.push(line);
  }
  process.stdout.write(out.join('\n'));
  // Unmatched rows are normal in any single run (the whitelist covers every
  // object that CAN drift, a given diff contains only the ones that DID). A
  // row that can never match again surfaces as drift above — the changed
  // line stops matching and is kept in stdout — so this count is telemetry,
  // not a gate.
  console.error(
    `migrate-diff filter: dropped ${dropped} whitelisted line(s) per ${manifestPath} ` +
      `(${matched.size}/${lines.size} whitelist rows matched, ${lines.size - matched.size} unmatched this run)`,
  );
});
