/**
 * #5289 (cor:spc:030:02, option (b); Holger's ruling A on parse5, decisions:2026-11-26-holger-parse5-test-dependency): a tag Markdown does
 * not accept whose value holds `<template` is no longer held back. linkedom models no `template`, so until now no test could show a reader
 * losing the anchor; parse5 (a test-only devDependency, one exact version) does. A body goes through the pass, the server's own block follows
 * it, a Markdown reader makes HTML of the whole string and parse5 reads that, as in unterminatedHtmlRender5151.test.ts.
 *
 * The loss is judged from the parsed tree: the anchor is lost when the document holds no live `<a id>` with nothing but its id. parse5 puts a
 * template's content in a separate fragment (`content`), which a walk of the document's own children never enters, so an anchor inside a
 * template's inert content is not found, and `where` names it.
 */
import * as commonmark from 'commonmark';
import MarkdownIt from 'markdown-it';
import { marked } from 'marked';
import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import { escapeUnterminatedHtml } from './unterminatedHtml.js';

const reader = new commonmark.Parser();
const writer = new commonmark.HtmlRenderer();
const markdownIt = new MarkdownIt({ html: true });
const RENDERERS: Record<string, (md: string) => string> = {
  'commonmark.js': (md) => writer.render(reader.parse(md)),
  'markdown-it': (md) => markdownIt.render(md),
  marked: (md) => marked.parse(md, { async: false }),
};
const NAMES = Object.keys(RENDERERS);
const RAW = new Set(['textarea', 'script', 'style', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

interface TreeNode { nodeName: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: TreeNode[]; content?: TreeNode }
type Where = 'live' | 'in template content' | 'in raw text' | 'missing';

/** Where the element with `id` sits: `inTemplate` walks into template content too, so a find there is told apart from a missing one. */
function locate(node: TreeNode, id: string, inRaw: boolean, inTemplate: boolean): { el: TreeNode; where: Where } | null {
  const children = [...(node.childNodes ?? []), ...(node.content ? [node.content] : [])];
  for (const child of children) {
    const intoTemplate = inTemplate || child === node.content;
    if (child.attrs?.some((a) => a.name === 'id' && a.value === id)) {
      return { el: child, where: intoTemplate ? 'in template content' : inRaw ? 'in raw text' : 'live' };
    }
    const found = locate(child, id, inRaw || RAW.has(child.tagName ?? ''), intoTemplate);
    if (found) return found;
  }
  return null;
}
/** The document's own text, template content left out (it is not shown). */
function shownText(node: TreeNode): string {
  return (node.childNodes ?? []).map((c) => (c.nodeName === '#text' ? c.value ?? '' : shownText(c))).join('');
}
function where(body: string, renderer: string): Where {
  const md = `${body}\n\n<a id="srv-a"></a>\n\n## Heading Z\nstate`;
  const document = parse(`<!doctype html><html><body>${RENDERERS[renderer](md)}</body></html>`) as unknown as TreeNode;
  const found = locate(document, 'srv-a', false, false);
  if (found === null) return 'missing';
  if (found.where !== 'live') return found.where;
  const anchor = found.el;
  return anchor.tagName === 'a' && anchor.attrs?.length === 1 && shownText(document).includes('Heading Z') ? 'live' : 'missing';
}
const losers = (body: string): string[] => NAMES.filter((renderer) => where(body, renderer) !== 'live');

/** Each is held back on main (the pass returns it as written) and loses the anchor in every reader; the head escapes the `<template`. */
const CHANGED: [string, string, string][] = [
  ['inline value', 'a <b y= <template>', 'a <b y= &lt;template>'],
  ['value at the head of the body (#5112 pin)', '<b y= <template>', '<b y= &lt;template>'],
  ['value with no blank after `=`', 'a <b y=<template>', 'a <b y=&lt;template>'],
  ['attribute name holding it', 'a <b b<template> c', 'a <b b&lt;template> c'],
  ['self-closing template', 'a <b y= <template/>', 'a <b y= &lt;template/>'],
  ['template with an attribute', 'a <b y= <template x>', 'a <b y= &lt;template x>'],
  ['an end tag holding it', '</b y= <template>', '</b y= &lt;template>'],
];

/** Every reader keeps the anchor in each, so each stays as written. */
const UNCHANGED: [string, string][] = [
  ['inside an HTML block, where the browser reads one complete tag', '<div>\n<b y= <template>'],
  ['in a code span', 'a `<b y= <template>`'],
  ['in a fence', '```\n<b y= <template>\n```'],
  ['in a quoted value', 'a <b y="<template>">'],
  ['a template closed by its own end tag', 'a <b y= <template></template>'],
  ['with no unterminated construct', 'a <b>bold</b> and <template>x</template>'],
];

describe('#5289 a tag value holding `<template`, judged through parse5', () => {
  it('the judge finds an anchor inside template content and tells it apart from a live one', () => {
    expect(NAMES.map((renderer) => where('a <template>', renderer))).toEqual(NAMES.map(() => 'in template content'));
    expect(NAMES.map((renderer) => where('a', renderer))).toEqual(NAMES.map(() => 'live'));
  });

  it.each(CHANGED)('%s: the authored body loses the anchor into template content in every reader', (_label, body) => {
    expect(NAMES.map((renderer) => where(body, renderer))).toEqual(NAMES.map(() => 'in template content'));
  });

  it.each(CHANGED)('%s: the `<template` is escaped and every reader keeps the anchor', (_label, body, escaped) => {
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped);
    expect(losers(out)).toEqual([]);
    expect(escapeUnterminatedHtml(out)).toBe(out);
  });

  it('a backslash-escaped `<` stays as written: the `<b` is text, so the template after it was escaped on main already', () => {
    expect(escapeUnterminatedHtml('a \\<b y= <template>')).toBe('a \\<b y= &lt;template>');
    expect(losers('a \\<b y= &lt;template>')).toEqual([]);
  });

  it.each(UNCHANGED)('%s: every reader keeps the anchor, and the body comes back byte for byte', (_label, body) => {
    expect(losers(body)).toEqual([]);
    expect(escapeUnterminatedHtml(body)).toBe(body);
  });
});
