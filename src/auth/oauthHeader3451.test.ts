import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
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
});
