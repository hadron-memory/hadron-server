/**
 * #3576: long unbroken client, scope, resource, redirect and notice values wrap inside the
 * consent card; complete values stay in the DOM (nothing truncated or hidden).
 *
 * Two layers. The static pins always run. The geometry pins render the real page in a real
 * Chromium (headless, no network, a file:// page, viewport and color scheme emulated over CDP and asserted) and measure it; they run only where a
 * Chromium binary exists (CONSENT_BROWSER, else the Playwright cache) and are skipped otherwise,
 * because Playwright is operator-provided, not a repo dependency (see scripts/e2e).
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderConsent } from './oauth.js';
import { CONSENT_TEMPLATE } from './consent.template.js';

const LONG = 'Q'.repeat(80);

function findBrowser(): string | null {
  if (process.env.CONSENT_BROWSER) {
    // An explicit opt-in that points nowhere must fail loudly, not degrade to a skip.
    if (!existsSync(process.env.CONSENT_BROWSER)) throw new Error('CONSENT_BROWSER does not exist: ' + process.env.CONSENT_BROWSER);
    return process.env.CONSENT_BROWSER;
  }
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    const bin = join(root, d, 'chrome-linux64', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return null;
}
let browser: string | null = null;
try { browser = findBrowser(); } catch (e) { if (process.env.CONSENT_BROWSER) throw e; }
if (!browser) console.warn('consentWrap3576: no Chromium found (set CONSENT_BROWSER); geometry layer skipped');

type Params = Partial<Parameters<typeof renderConsent>[0]>;
const page = (over: Params) => renderConsent({
  clientName: 'Synthetic QA Client', clientId: 'c1', redirectUri: 'https://synthetic.example/callback',
  oauthScopes: ['mcp'] as ('mcp' | 'account')[], resource: 'https://synthetic.example/mcp', codeChallenge: 'x', codeChallengeMethod: 'S256',
  state: 's', csrfToken: 't', grantProof: 'p', ...over,
} as Parameters<typeof renderConsent>[0]);

// Measurer, run in the page by CDP: for every element with text, did its content run past the card's right edge?
const MEASURE = `(() => {const main=document.querySelector('main').getBoundingClientRect();
const bad=[];for(const el of document.querySelectorAll('main h1,main p,main li,main code,main strong,main button')){
const r=el.getBoundingClientRect();if(el.scrollWidth>el.clientWidth+1||r.right>main.right+1)bad.push(el.tagName+':'+(el.textContent||'').slice(0,12));}
return JSON.stringify({bad,doc:document.documentElement.scrollWidth,vw:innerWidth,dark:matchMedia('(prefers-color-scheme: dark)').matches,
text:document.body.textContent});})()`;

type Measured = { bad: string[]; doc: number; vw: number; dark: boolean; text: string };

// Real viewport and media emulation over the DevTools protocol (the --window-size and
// --blink-settings flags are not honoured by every headless Chromium build).
async function measure(html: string, width: number, dark: boolean): Promise<Measured> {
  const dir = mkdtempSync(join(tmpdir(), 'consent3576-'));
  const proc = spawn(browser!, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dir, 'u')}`,
    '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('no devtools endpoint: ' + buf.slice(0, 300))), 30000);
      proc.stderr!.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); resolve(m[1]); } });
      proc.on('exit', () => { clearTimeout(t); reject(new Error('chromium exited: ' + buf.slice(0, 300))); });
    });
    const f = join(dir, 'p.html');
    writeFileSync(f, html);
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws connect failed')); });
    let id = 0;
    const pending = new Map<number, (r: any) => void>();
    const loaded: Array<() => void> = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      if (msg.method === 'Page.loadEventFired') loaded.splice(0).forEach((fn) => fn());
    };
    const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((res, rej) => {
      const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sessionId);
    const done = new Promise<void>((res) => loaded.push(res));
    await send('Page.navigate', { url: pathToFileURL(f).href }, sessionId);
    await done;
    const r = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true }, sessionId);
    ws.close();
    const m = JSON.parse(r.result.value) as Measured;
    // The requested state must be the measured state, or the geometry checks prove nothing.
    expect(m.vw).toBe(width);
    expect(m.dark).toBe(dark);
    return m;
  } finally { proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
}

const cases: Array<[string, Params]> = [
  ['control', {}],
  ['clientName', { clientName: LONG }],
  ['scope', { oauthScopes: [LONG] as unknown as ('mcp' | 'account')[] }],
  ['resource', { resource: 'https://' + LONG }],
  ['redirect', { redirectUri: 'https://' + LONG + '/cb' }],
];

describe.skipIf(!browser)('#3576 consent card geometry (real Chromium)', () => {
  for (const [name, over] of cases) for (const width of [1280, 390]) for (const dark of [false, true]) {
    it(`${name} stays inside the card at ${width}px ${dark ? 'dark' : 'light'}`, async () => {
      const m = await measure(page(over), width, dark);
      expect(m.bad).toEqual([]);
      expect(m.doc).toBeLessThanOrEqual(m.vw);
      for (const v of Object.values(over)) for (const s of [v].flat()) expect(m.text.toLowerCase()).toContain(String(s).replace(/^https:\/\//, '').replace(/\/cb$/, '').toLowerCase()); // the anchor shows the host, which the URL parser lowercases
    });
  }
  it('a long notice value (template level) wraps inside the card and stays fully present', async () => {
    const notice = 'R'.repeat(80);
    const html = page({}).replace(/This token is limited[^<]*/, notice);
    const m = await measure(html, 390, false);
    expect(m.bad).toEqual([]);
    expect(m.doc).toBeLessThanOrEqual(m.vw);
    expect(m.text).toContain(notice);
  });
});

describe('#3576 hostile values are escaped, not interpreted', () => {
  it('renders markup in client name, scope and resource as text', () => {
    const evil = '"><img src=x onerror=window.__pwned=1>';
    const html = page({ clientName: evil, oauthScopes: [evil] as unknown as ('mcp' | 'account')[], resource: 'https://x.example/' + evil });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
  });
});

describe('#3576 static pins', () => {
  it('declares an emergency wrapping rule for every surface that shows an external value', () => {
    const css = CONSENT_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]+)\{[^}]*overflow-wrap:\s*anywhere[^}]*\}/.exec(css);
    expect(rule).not.toBeNull();
    // h1: client name; p: redirect anchor and the notice text; code: scope, resource, redirect; .warn: the notice.
    expect(rule![1].split(',').map((x) => x.trim())).toEqual(expect.arrayContaining(['h1', 'p', 'code', '.warn']));
  });
  it('never truncates or hides: no ellipsis, no clipping, no hidden overflow', () => {
    expect(CONSENT_TEMPLATE).not.toMatch(/text-overflow|overflow:\s*hidden|overflow-x:\s*hidden|line-clamp|white-space:\s*nowrap/);
  });
});
