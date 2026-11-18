/**
 * #3698 (slice 1 of #3682): the one shell every server-hosted ceremony page is built from.
 *
 * Every page gets `<html lang="en">`, a `color-scheme` meta (so the browser's own dark palette applies), one type
 * scale, 2.75rem touch targets, a `:focus-visible` ring, buttons stacked full-width below 480px and a plain card per
 * step. The stylesheet is inlined once per page, so each page's CSP needs `style-src 'unsafe-inline'` and nothing
 * more (no script or network source is involved in styling).
 *
 * The shell is static: callers pass fixed markup, never request data, so a link alone still reveals nothing
 * (cor:dmo:130:08). `body`, `extraCss` and `scriptSrc` are markup authored by this repo, never request- or
 * node-derived: callers interpolate only constants. `title` is text and is escaped here, so the one text-shaped
 * parameter cannot become a markup hole.
 */

export const CEREMONY_CSS =
  ':root{color-scheme:light dark}' +
  'body{font:1rem/1.5 system-ui,sans-serif;margin:0}' +
  'main{display:block;box-sizing:border-box;width:min(32rem,calc(100% - 2rem));margin:2rem auto;padding:1rem;border:1px solid rgba(127,127,127,.4);border-radius:.5rem}main.wide{width:min(44rem,calc(100% - 2rem))}' +
  'h1{font-size:1.5rem;line-height:1.25;margin:0 0 1rem}h2{font-size:1.25rem;line-height:1.3;margin:1.25rem 0 .5rem}h3{font-size:1.0625rem;margin:1rem 0 .25rem}p{margin:0 0 1rem}' +
  'button,.button{font:inherit;display:inline-block;box-sizing:border-box;min-height:2.75rem;min-width:2.75rem;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0;cursor:pointer}' +
  '.button{text-align:center;text-decoration:none;border:1px solid currentColor;border-radius:.25rem;line-height:1.5}' +
  ':focus-visible{outline:3px solid #2563eb;outline-offset:2px}' +
  '@media (max-width:480px){button,.button{display:block;width:100%;margin:.5rem 0}}';

const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface CeremonyShellOptions {
  title: string;
  /**
   * Fixed markup for the card. A body that carries its own `<main>` (the ceremony client pages' `main[data-page]`,
   * which their script reads with `document.querySelector('main')`) is used as is: the shell never puts a second,
   * earlier `<main>` in front of it.
   */
  body: string;
  /** A same-origin script to load after the card, when the page has one. */
  scriptSrc?: string;
  /** Extra rules for a page with its own widgets (the signing view), appended to the shared stylesheet. */
  extraCss?: string;
  /** The wider column the signing view reads in. */
  wide?: boolean;
}

export function ceremonyShell({ title, body, scriptSrc, extraCss = '', wide = false }: CeremonyShellOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeText(title)}</title>
<style>${CEREMONY_CSS}${extraCss}</style></head>
<body>${/<main[\s>]/.test(body) ? body : `<main${wide ? ' class="wide"' : ''}>${body}</main>`}${scriptSrc ? `<script src="${scriptSrc}"></script>` : ''}</body></html>`;
}
