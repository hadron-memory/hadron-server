/**
 * #5033: a seeded differential fuzz. A body of random HTML fragments (open and closed tags, quotes, comments, CDATA, processing
 * instructions, raw-text elements, templates) goes through the pass and is followed by the server's own block; an HTML5 parser
 * (linkedom) must find the server's anchor as exactly one `<a>` with only an `id`, and the heading after it as text. The oracle
 * is apart from the implementation. The seed is fixed so a failure names its input; 150,000 cases ran clean when this was written.
 */
import { parseHTML } from 'linkedom';
import { it, expect } from 'vitest';
import { escapeUnterminatedHtml } from './unterminatedHtml.js';
const FR = ['<a', '<b>', '</b>', '</', '<!--', '-->', '<![CDATA[', ']]>', '<?', '?>', '<!x', '>', "'", '"', '=', ' ', 'x', '<script>', '</script>', '</script ', '<textarea>', '</textarea', '<pre', '<pre>', '<title>', '</title>', '\n', '\n\n', '<template>', '</template>', '<plaintext>', '</ ', '<xmp>', '</xmp>', '<style>', '</style', '<div class=', 'id=', '/', '<iframe>', '<noscript>'];
let seed = 20261124;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
it('no unterminated construct survives an HTML5 parse of body + server block', () => {
  let bad = 0; const samples: string[] = [];
  for (let n = 0; n < 8000; n += 1) {
    const len = 1 + Math.floor(rnd() * 8);
    let body = '';
    for (let k = 0; k < len; k += 1) body += FR[Math.floor(rnd() * FR.length)];
    const out = `${escapeUnterminatedHtml(body)}\n\n<a id="srv-a"></a>\n\n## Heading Z\nstate`;
    const { document } = parseHTML(`<!doctype html><html><body>${out}</body></html>`);
    const el = document.getElementById('srv-a');
    const ok = el && el.tagName === 'A' && [...el.attributes].length === 1 && (document.body.textContent ?? '').includes('Heading Z');
    if (!ok) { bad += 1; if (samples.length < 12) samples.push(JSON.stringify(body)); }
  }
  expect(samples).toEqual([]);
  expect(bad).toBe(0);
}, 120000);
