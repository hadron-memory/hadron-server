/**
 * Server-side main-content extraction for importNode's URL path (#457).
 *
 * hadrontool-pdf deliberately does NOT extract main content
 * (cor:cnv:010:00) — callers pass reader-mode content. For server-fetched
 * pages the reader step happens here: Readability over a linkedom DOM
 * (no Chromium; both approved additions, handoff 2026-07-03 decision 2).
 *
 * Returns null when Readability can't identify an article — the caller
 * falls back to converting the whole page.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface ExtractedArticle {
  /** Readability's cleaned article HTML — feed this to the converter. */
  contentHtml: string;
  title?: string;
}

export function extractArticle(html: string, url: string): ExtractedArticle | null {
  try {
    const { document } = parseHTML(html);
    // Give relative links a base to resolve against downstream.
    if (!document.querySelector('base')) {
      const base = document.createElement('base');
      base.setAttribute('href', url);
      document.head?.appendChild(base);
    }
    // Readability's types want a browser DOM Document (a lib.dom global this
    // Node build doesn't load); linkedom's document is structurally
    // compatible for everything Readability touches.
    const article = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
    ).parse();
    if (!article?.content || article.content.trim() === '') return null;
    return {
      contentHtml: article.content,
      ...(article.title ? { title: article.title } : {}),
    };
  } catch {
    // Extraction is an enhancement — a parser blow-up on hostile markup
    // must not fail the import; the caller converts the raw page instead.
    return null;
  }
}
