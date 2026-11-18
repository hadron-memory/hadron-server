/** #3451: bounded static Chromium layout proof, not a live OAuth/QA run.
 * Run with tsx: <script> <baseline-checkout> <playwright-module> <output-dir>.
 * Playwright/browser are operator-provided; no production or server endpoint.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [baselineArg, playwrightArg, outputArg] = process.argv.slice(2);
if (!baselineArg || !playwrightArg || !outputArg) throw new Error('Need baseline checkout, Playwright module path, output directory');
const output = resolve(outputArg);
const load = (root: string, name: string) => import(pathToFileURL(resolve(root, `src/auth/${name}.template.ts`)).href);
async function render(root: string, kind: string) {
  const [sign, email, consent, error] = await Promise.all(['signin-prompt', 'email-entry', 'consent', 'login-error'].map(name => load(root, name)));
  const pages = { signin: sign.SIGNIN_PROMPT_TEMPLATE, email: email.EMAIL_ENTRY_TEMPLATE,
    sent: email.EMAIL_SENT_TEMPLATE, review: email.REVIEW_CODE_TEMPLATE,
    consent: consent.CONSENT_TEMPLATE, error: error.LOGIN_ERROR_TEMPLATE };
  const dir = resolve(output, kind);
  await mkdir(dir, { recursive: true });
  for (const [name, html] of Object.entries(pages)) {
    // Static synthetic stand-ins; this is not a production-renderer parity test.
    const text = String(html).replace(/{{clientName}}/g, 'Example MCP client')
      .replace(/{{grantHeading}}/g, 'MCP access only')
      .replace(/{{grantBody}}/g, 'This connection is limited to Hadron’s MCP interface.')
      .replace(/{{grantSub}}/g, 'Review this request before approving.')
      .replace(/{{providerLinks}}/g, '').replace(/{{redirectAnchor}}/g, 'client.example')
      .replace(/{{resource}}/g, 'https://hadron.example/mcp').replace(/{{scope}}/g, 'mcp')
      .replace(/{{email}}/g, 'reader@example.test').replace(/{{expiryMinutes}}/g, '10')
      .replace(/{{\w+}}/g, 'fixture');
    await writeFile(resolve(dir, `${name}.html`), text);
  }
  return Object.keys(pages);
}
const pages = await render(resolve(baselineArg), 'baseline');
await render(process.cwd(), 'current');
const { chromium } = await import(pathToFileURL(resolve(playwrightArg)).href);
const browser = await chromium.launch({ headless: true, ...(process.env.OAUTH_LAYOUT_BROWSER ? { executablePath: process.env.OAUTH_LAYOUT_BROWSER } : {}), args: ['--no-sandbox'] });
const rows: Array<Record<string, unknown>> = [];
const errors: string[] = [];
try {
  for (const width of [320, 390, 1280]) for (const colorScheme of ['light', 'dark'] as const) for (const name of pages) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    const remote: string[] = [];
    page.on('request', (request: { url(): string }) => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
    const metrics: Array<{ width: number; documentWidth: number; logoLoaded: boolean }> = [];
    for (const kind of ['baseline', 'current']) {
      await page.goto(pathToFileURL(resolve(output, kind, `${name}.html`)).href);
      metrics.push(await page.evaluate(() => {
        const main = document.querySelector('main')!;
        const img = document.querySelector<HTMLImageElement>('.hadron-header img');
        return { width: main.getBoundingClientRect().width, documentWidth: document.documentElement.scrollWidth,
          background: getComputedStyle(main).backgroundColor, color: getComputedStyle(main).color,
          logoLoaded: !!img?.complete && img.naturalWidth === 128, logoSrc: img?.currentSrc.slice(0, 22) };
      }));
      if (kind === 'current') await page.screenshot({ path: resolve(output, `${name}-${colorScheme}-${width}.png`), fullPage: true });
    }
    rows.push({ name, scheme: colorScheme, viewport: width, metrics, remoteRequests: remote.length });
    if (width === 1280 && metrics[0].width !== metrics[1].width) errors.push(`${name}/${colorScheme}: desktop ${metrics[0].width}->${metrics[1].width}`);
    if (metrics[1].documentWidth > width || !metrics[1].logoLoaded || remote.length) errors.push(`${name}/${colorScheme}/${width}: overflow, logo or remote request`);
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(resolve(output, 'results.json'), JSON.stringify(rows, null, 2) + '\n');
if (errors.length) throw new Error(errors.join('\n'));
console.log(`PASS: ${rows.length} current + ${rows.length} baseline renders; desktop width preserved, no current overflow/remote resource request, logos loaded.`);
