/**
 * #457 — Readability-over-linkedom extraction (real libraries, no mocks):
 * pins that the approved dependency pair actually works together, that an
 * article page extracts with its title, and that junk input degrades to
 * null (whole-page fallback) instead of throwing.
 */

import { describe, it, expect } from 'vitest';
import { extractArticle } from './articleExtract.js';

const PARAGRAPH =
  'The platform message bus carries versioned dot-delimited subjects owned by the server. ' +
  'Delivery is at least once, so every handler claims its work atomically before acting. ';

const ARTICLE_HTML = `<!doctype html>
<html>
  <head><title>Bus Design Notes</title></head>
  <body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article>
      <h1>Bus Design Notes</h1>
      <p>${PARAGRAPH.repeat(6)}</p>
      <p>${PARAGRAPH.repeat(6)}</p>
    </article>
    <footer>© 2026 Example</footer>
  </body>
</html>`;

describe('extractArticle', () => {
  it('extracts the main article with its title', () => {
    const out = extractArticle(ARTICLE_HTML, 'https://example.com/bus-notes');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Bus Design Notes');
    expect(out!.contentHtml).toContain('claims its work atomically');
    // Chrome is stripped by Readability.
    expect(out!.contentHtml).not.toContain('About');
  });

  it('returns null for junk input instead of throwing', () => {
    expect(extractArticle('', 'https://example.com/')).toBeNull();
    expect(extractArticle('<div>hi</div>', 'https://example.com/')).toBeNull();
  });
});
