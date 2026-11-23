/**
 * Run the core-owned `web-search@1` conformance fixture set (#647 S1) against a
 * tool endpoint:
 *
 *   WEBSEARCH_TOOL_URL=http://hadrontool-websearch:8080 [WEBSEARCH_TOOL_TOKEN=...] \
 *   [WEBSEARCH_TOOL_CONTRACT_VERSION=web-search@1] pnpm tsx scripts/web-search-conformance.ts
 *
 * Reads the same variables the server does. Sends no provider credential. Exit
 * 0 = every fixture passed, 1 = a fixture failed or the tool was refused for
 * declaring another version (nothing was sent), 2 = no URL configured.
 */
import { runWebSearchConformance } from '../src/lib/webSearchConformance.js';

const baseUrl = process.env.WEBSEARCH_TOOL_URL?.trim();
if (!baseUrl) {
  console.error('WEBSEARCH_TOOL_URL is not set.');
  process.exit(2);
}
const report = await runWebSearchConformance({
  baseUrl,
  token: process.env.WEBSEARCH_TOOL_TOKEN?.trim() || undefined,
  declaredVersion: process.env.WEBSEARCH_TOOL_CONTRACT_VERSION,
});
if (report.refused) console.error(`refused: ${report.refused}`);
for (const r of report.results) console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}`);
for (const f of report.failures) console.error(`  ${f}`);
console.log(report.passed ? 'conforming' : 'NOT conforming');
process.exitCode = report.passed ? 0 : 1;
