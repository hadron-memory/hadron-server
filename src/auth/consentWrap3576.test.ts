/**
 * #3576: long unbroken client, scope, resource, redirect and notice values wrap inside the
 * consent card; complete values stay in the DOM (nothing truncated or hidden).
 *
 * Two layers. The static pins always run. The geometry pins render the real page in a real
 * Chromium (headless, no network, a file:// page) and measure it; they run only where a
 * Chromium binary exists (CONSENT_BROWSER, else the Playwright cache) and are skipped otherwise,
 * because Playwright is operator-provided, not a repo dependency (see scripts/e2e).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderConsent } from './oauth.js';
import { CONSENT_TEMPLATE } from './consent.template.js';

const LONG = 'Q'.repeat(80);

function findBrowser(): string | null {
  if (process.env.CONSENT_BROWSER) return existsSync(process.env.CONSENT_BROWSER) ? process.env.CONSENT_BROWSER : null;
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
    const bin = join(root, d, 'chrome-linux64', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return null;
}
const browser = findBrowser();

type Params = Partial<Parameters<typeof renderConsent>[0]>;
const page = (over: Params) => renderConsent({
  clientName: 'Synthetic QA Client', clientId: 'c1', redirectUri: 'https://synthetic.example/callback',
  oauthScopes: ['mcp'], resource: 'https://synthetic.example/mcp', codeChallenge: 'x', codeChallengeMethod: 'S256',
  state: 's', csrfToken: 't', grantProof: 'p', ...over,
} as Parameters<typeof renderConsent>[0]);

// Injected measurer: for every element with text, did its content run past the card's right edge?
const MEASURE = `<script>addEventListener('load',()=>{const main=document.querySelector('main').getBoundingClientRect();
const bad=[];for(const el of document.querySelectorAll('main h1,main p,main li,main code,main strong,main button')){
const r=el.getBoundingClientRect();if(el.scrollWidth>el.clientWidth+1||r.right>main.right+1)bad.push(el.tagName+':'+(el.textContent||'').slice(0,12));}
const o=document.createElement('pre');o.id='m';o.textContent=JSON.stringify({bad,doc:document.documentElement.scrollWidth,vw:innerWidth,
text:document.body.textContent});document.body.appendChild(o);});</script>`;

function measure(html: string, width: number, dark: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'consent3576-'));
  try {
    const f = join(dir, 'p.html');
    writeFileSync(f, html.replace('</body>', MEASURE + '</body>'));
    const r = spawnSync(browser!, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dir, 'u')}`,
      `--window-size=${width},900`, ...(dark ? ['--blink-settings=preferredColorScheme=1'] : []),
      '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(f).href], { encoding: 'utf8', timeout: 60000 });
    const m = /<pre id="m">([\s\S]*?)<\/pre>/.exec(r.stdout);
    if (!m) throw new Error('no measurement: ' + r.stderr.slice(0, 300));
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) as
      { bad: string[]; doc: number; vw: number; text: string };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const cases: Array<[string, Params]> = [
  ['control', {}],
  ['clientName', { clientName: LONG }],
  ['scope', { oauthScopes: [LONG] }],
  ['resource', { resource: 'https://' + LONG }],
  ['redirect', { redirectUri: 'https://' + LONG + '/cb' }],
];

describe.skipIf(!browser)('#3576 consent card geometry (real Chromium)', () => {
  for (const [name, over] of cases) for (const width of [1280, 390]) for (const dark of [false, true]) {
    it(`${name} stays inside the card at ${width}px ${dark ? 'dark' : 'light'}`, () => {
      const m = measure(page(over), width, dark);
      expect(m.bad).toEqual([]);
      expect(m.doc).toBeLessThanOrEqual(m.vw);
      for (const v of Object.values(over)) for (const s of [v].flat()) expect(m.text).toContain(String(s).replace(/^https:\/\//, '').slice(0, 40));
    });
  }
  it('a long notice value (template level) wraps inside the card', () => {
    const html = page({}).replace(/This token is limited[^<]*/, 'R'.repeat(80));
    expect(measure(html, 390, false).bad).toEqual([]);
  });
});

describe('#3576 static pins', () => {
  it('declares an emergency wrapping rule for every surface that shows an external value', () => {
    for (const sel of ['h1', 'p', 'li', 'code', '.warn']) {
      expect(CONSENT_TEMPLATE, sel).toMatch(new RegExp(`[^}]*${sel.replace('.', '\\.')}[^{}]*\\{[^}]*overflow-wrap:\\s*anywhere`));
    }
  });
  it('never truncates or hides: no ellipsis, no clipping, no hidden overflow', () => {
    expect(CONSENT_TEMPLATE).not.toMatch(/text-overflow|overflow:\s*hidden|overflow-x:\s*hidden|line-clamp|white-space:\s*nowrap/);
  });
});
