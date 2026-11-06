import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { renderConsent } from './oauth.js';
import { HADRON_HEADER, HADRON_HEADER_STYLE } from './hadron-header.template.js';
import { SIGNIN_PROMPT_TEMPLATE } from './signin-prompt.template.js';
import { EMAIL_ENTRY_TEMPLATE, EMAIL_SENT_TEMPLATE, REVIEW_CODE_TEMPLATE } from './email-entry.template.js';
import { CONSENT_TEMPLATE } from './consent.template.js';
import { LOGIN_ERROR_TEMPLATE } from './login-error.template.js';

const pages = { signIn: SIGNIN_PROMPT_TEMPLATE, email: EMAIL_ENTRY_TEMPLATE,
  sent: EMAIL_SENT_TEMPLATE, review: REVIEW_CODE_TEMPLATE, consent: CONSENT_TEMPLATE,
  error: LOGIN_ERROR_TEMPLATE };
// The header is static: substitution of the existing page placeholders must
// neither supply nor remove any of its markup.
const render = (template: string) => template.replace(/{{\w+}}/g, 'Test Client');
describe('#3451 shared OAuth branding', () => {
  for (const [name, template] of Object.entries(pages)) {
    it(`${name} renders the same embedded header before its existing heading`, () => {
      const { document } = parseHTML(render(template));
      const header = document.querySelector('main > header.hadron-header');
      expect(header).not.toBeNull();
      expect(header!.nextElementSibling?.tagName).toBe('H1');
      expect(header!.textContent?.trim()).toBe('Hadron');
      expect(header!.querySelector('img')?.getAttribute('alt')).toBe('Hadron');
      expect(header!.querySelector('img')?.getAttribute('width')).toBe('48');
      expect(header!.innerHTML).toBe(parseHTML(render(SIGNIN_PROMPT_TEMPLATE)).document.querySelector('header.hadron-header')!.innerHTML);
      for (const resource of document.querySelectorAll('img, source, script[src], link[href]')) {
        expect(resource.getAttribute('src') ?? resource.getAttribute('srcset') ?? resource.getAttribute('href') ?? '').not.toMatch(/^https?:\/\//i);
      }
      expect(header!.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
      expect(header!.querySelector('source')?.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
    });
  }
  it('keeps the client name in the consent heading and the existing form actions', () => {
    expect(parseHTML(render(CONSENT_TEMPLATE)).document.querySelector('h1')?.textContent).toBe('Authorize Test Client');
    expect(CONSENT_TEMPLATE).toContain('action="/oauth/authorize"');
    expect(EMAIL_ENTRY_TEMPLATE).toContain('action="/oauth/authorize/email"');
  });

// A reusable branding fragment must not restyle the containing page card.
it('the branding stylesheet is scoped to the header, not main layout', () => {
  expect(HADRON_HEADER_STYLE).not.toMatch(/(?:^|[}\s])main\s*\{/);
});

it('the shared header stays parameter-free and cannot introduce network CSS or protocol-relative resources', () => {
  expect(HADRON_HEADER).not.toMatch(/{{/);
  expect(HADRON_HEADER_STYLE).not.toMatch(/@import|url\(\s*["']?\s*(?:https?:)?\/\//i);
  const { document } = parseHTML(HADRON_HEADER);
  for (const resource of document.querySelectorAll('[src], [srcset], link[href]')) {
    for (const attr of ['src', 'srcset', 'href']) {
      expect(resource.getAttribute(attr) ?? '').not.toMatch(/(?:^|,\s*)(?:https?:)?\/\//i);
    }
  }
});

// #3574: strict, intentionally small selector vocabulary for this static shared fragment.
// A prefix alone is insufficient: sibling combinators and pseudo selectors can escape or target page-owned elements.
function headerSelectors(css: string) {
  const { document } = parseHTML(css);
  const sheets = [...document.querySelectorAll('style')];
  expect(sheets).toHaveLength(1);
  const rules = (sheets[0] as any).sheet.cssRules;
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) {
    expect(typeof rule.selectorText).toBe('string'); // no nested/global at-rules in the shared fragment
    for (const selector of rule.selectorText.split(',')) {
      expect(selector.trim(), 'header-owned selector').toMatch(/^\.hadron-header(?:\s+(?:picture|img|span))?$/);
    }
  }
}
function png(uri: string) {
  expect(uri).toMatch(/^data:image\/png;base64,/);
  const bytes = Buffer.from(uri.split(',')[1], 'base64');
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    expect(offset + size + 12).toBeLessThanOrEqual(bytes.length);
    chunks.push({ type: bytes.toString('ascii', offset + 4, offset + 8), data: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += size + 12;
  }
  const ihdr = chunks.find(c => c.type === 'IHDR')!.data;
  return { chunks, width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4),
    streamHash: createHash('sha256').update(inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)))).digest('hex') };
}

it('shared CSS admits only the audited header selector vocabulary', () => headerSelectors(HADRON_HEADER_STYLE));
it('the selector oracle accepts header-only lists and rejects escaping lists/combinators/pseudos/non-header rules', () => {
  headerSelectors('<style>.hadron-header, .hadron-header img { display: block }</style>');
  for (const selector of ['main', 'body', '.other', '.hadron-header, main', '.hadron-header + main',
    '.hadron-header ~ main', 'main > .hadron-header', '.hadron-header :is(img, main)',
    '.hadron-header:has(+ main)', ':not(.hadron-header)', '.hadron-header img, input']) {
    expect(() => headerSelectors(`<style>${selector} { width: 1px }</style>`), selector).toThrow();
  }
});

for (const [name, template] of Object.entries(pages)) {
  it(`${name} owns border-box and the 546px desktop card budget`, () => {
    const { document } = parseHTML(render(template));
    const pageRules = [...document.querySelectorAll('style')].filter(style => style.textContent !==
      parseHTML(HADRON_HEADER_STYLE).document.querySelector('style')!.textContent)
      .flatMap(style => [...(style as any).sheet.cssRules]);
    const mainRules = pageRules.filter((rule: any) => rule.selectorText === 'main');
    expect(mainRules).toHaveLength(1);
    const style = mainRules[0].style;
    expect(style.getPropertyValue('box-sizing')).toBe('border-box');
    expect(style.getPropertyValue('width')).toBe('100%');
    expect(style.getPropertyValue('max-width').replace(/\s/g, '')).toBe('calc(480px+4rem+2px)');
    expect(480 + 4 * 16 + 2).toBe(546); // default 16px root; source pin, not a browser layout measurement
  });
}

it('the production consent renderer retains distinct pixel-identical 128px marks, 48px display and head-only styling', () => {
  const html = renderConsent({ clientName: 'Synthetic <client>', clientId: 'synthetic', redirectUri: 'https://client.example/callback',
    resource: 'https://server.example/mcp', oauthScopes: ['mcp'], codeChallenge: 'synthetic', codeChallengeMethod: 'S256',
    state: 'synthetic', csrfToken: 'synthetic', grantProof: 'synthetic' });
  const { document } = parseHTML(html);
  const header = document.querySelector('main > header.hadron-header')!;
  expect(header).not.toBeNull();
  expect(header.nextElementSibling?.textContent).toBe('Authorize Synthetic <client>');
  expect(document.querySelector('form')?.getAttribute('action')).toBe('/oauth/authorize');
  const img = header.querySelector('img')!, source = header.querySelector('source')!;
  expect(img.getAttribute('width')).toBe('48'); expect(img.getAttribute('height')).toBe('48');
  expect(img.getAttribute('alt')).toBe('Hadron');
  expect(source.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
  const dark = source.getAttribute('srcset')!, light = img.getAttribute('src')!;
  expect(dark).not.toBe(light);
  for (const [uri, hash] of [[dark, '061f8d3949ecc6995c12b46815f631c7f97f69922751c838a09402c2f108239f'],
    [light, '01e6c6c69e7c15afc09f6a5f0ce79c0b2a490ec17d2bb88360b67afdb386f47e']]) {
    const image = png(uri);
    expect([image.width, image.height]).toEqual([128, 128]);
    expect(image.streamHash).toBe(hash); // original filtered scanlines; no re-encoding
    expect(image.chunks.map(c => c.type)).not.toEqual(expect.arrayContaining(['eXIf']));
    expect(image.chunks.map(c => c.type)).not.toEqual(expect.arrayContaining(['iTXt']));
  }
  const headerCss = parseHTML(HADRON_HEADER_STYLE).document.querySelector('style')!.textContent;
  const matches = [...document.querySelectorAll('style')].filter(style => style.textContent === headerCss);
  expect(matches).toHaveLength(1);
  expect(matches[0].parentElement?.tagName).toBe('HEAD');
  expect(document.querySelectorAll('body style')).toHaveLength(0);
  const rules = [...(matches[0] as any).sheet.cssRules];
  const imageStyle = rules.find((rule: any) => rule.selectorText === '.hadron-header img')!.style;
  expect(imageStyle.getPropertyValue('width')).toBe('48px'); expect(imageStyle.getPropertyValue('height')).toBe('48px');
});
});
