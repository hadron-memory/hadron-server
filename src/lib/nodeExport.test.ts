/**
 * Golden tests for the single-node renderer (#386). The expected strings are
 * transcribed from the CLI's `internal/nodedoc` golden tests so the server's
 * canonical output is pinned byte-for-byte to `hadron node export` without a
 * network/binary dependency. computeContentHash matches the CLI's ContentHash
 * (sha256, first 8 hex), so hashes are interpolated, not hard-coded.
 */

import { describe, it, expect } from 'vitest';
import { computeContentHash } from './contentHash.js';
import {
  renderCanonicalMarkdown,
  renderCanonicalJson,
  renderSectionedMarkdown,
  renderSectionedJson,
  renderNodeExport,
  type ExportNode,
  type NodeExportSection,
} from './nodeExport.js';

function sec(...s: NodeExportSection[]): Set<NodeExportSection> {
  return new Set(s);
}

const RICH: ExportNode = {
  id: 'n-1',
  memoryUrn: 'acme.com:kb',
  loc: 'guide:intro',
  name: 'Intro',
  nodeType: 'task',
  alias: 'intro',
  description: 'One-liner',
  abstract: 'A longer summary.',
  abstractOriginHash: 'deadbeef',
  content: '# Intro\n\nBody.',
  tags: ['guide', 'intro'],
  seq: 0,
  data: { k: 'v' },
  properties: undefined,
  edges: [{ target: { id: 'n-2', loc: 'guide:more' }, name: 'next', priority: 5 }],
};

describe('renderCanonicalMarkdown', () => {
  it('matches the CLI standalone file shape (loc/memory after id, recomputed contentHash)', () => {
    const n: ExportNode = {
      id: 'n-1', memoryUrn: 'acme.com:kb', loc: 'findings:flaky-ci',
      name: 'Flaky CI', nodeType: 'task', content: 'Body.', tags: [], edges: [],
    };
    const want =
      '---\nname: Flaky CI\nid: n-1\nloc: findings:flaky-ci\nmemory: acme.com:kb\ntype: task\ncontentHash: ' +
      computeContentHash('Body.') +
      '\n---\n\nBody.\n';
    expect(renderCanonicalMarkdown(n)).toBe(want);
  });

  it('omits contentHash/type for a minimal node, frames an empty body', () => {
    const n: ExportNode = { id: 'x', memoryUrn: 'm:kb', loc: 'x', name: 'X', content: '', tags: [], edges: [] };
    expect(renderCanonicalMarkdown(n)).toBe('---\nname: X\nid: x\nloc: x\nmemory: m:kb\n---\n\n\n');
  });

  it('renders the full field set in CLI order (tags, data, nodes blocks)', () => {
    const want = `---
name: Intro
id: n-1
loc: guide:intro
memory: acme.com:kb
alias: intro
type: task
description: One-liner
abstract: A longer summary.
abstractOriginHash: deadbeef
contentHash: ${computeContentHash('# Intro\n\nBody.')}
tags:
  - guide
  - intro
seq: 0
data:
  k: v
nodes:
  - id: n-2
    loc: guide:more
    rel: next
    priority: 5
---

# Intro

Body.
`;
    expect(renderCanonicalMarkdown(RICH)).toBe(want);
  });
});

describe('renderCanonicalJson', () => {
  it('matches the CLI canonical JSON shape (struct order, recomputed hash, edge fields)', () => {
    const n: ExportNode = {
      id: 'n-1', memoryUrn: 'acme.com:kb', loc: 'findings:flaky-ci',
      name: 'Flaky CI', nodeType: 'task', description: 'One liner',
      abstract: 'A summary.', abstractOriginHash: 'a1b2c3d4',
      content: 'Body.', tags: ['ci'],
      edges: [{ target: { id: 'n-2', loc: 'start' }, name: 'routes-to', priority: 10 }],
    };
    const want = `{
  "id": "n-1",
  "memory": "acme.com:kb",
  "loc": "findings:flaky-ci",
  "name": "Flaky CI",
  "type": "task",
  "objectType": "",
  "alias": "",
  "description": "One liner",
  "abstract": "A summary.",
  "abstractOriginHash": "a1b2c3d4",
  "contentHash": "${computeContentHash('Body.')}",
  "tags": [
    "ci"
  ],
  "seq": null,
  "role": null,
  "isRunnable": null,
  "data": null,
  "properties": null,
  "content": "Body.",
  "edges": [
    {
      "targetId": "n-2",
      "targetLoc": "start",
      "name": "routes-to",
      "condition": null,
      "priority": 10
    }
  ]
}
`;
    expect(renderCanonicalJson(n)).toBe(want);
  });

  it('blanks type for the default info node and emits empty arrays', () => {
    const n: ExportNode = { id: 'x', memoryUrn: 'm:kb', loc: 'x', name: 'X', nodeType: 'info', content: '', tags: [], edges: [] };
    const json = JSON.parse(renderCanonicalJson(n));
    expect(json.type).toBe('');
    expect(json.contentHash).toBe(''); // empty content
    expect(json.tags).toEqual([]);
    expect(json.edges).toEqual([]);
    expect(json.seq).toBeNull();
  });
});

describe('section selection (full: false)', () => {
  it('CONTENT only → just the body, no frontmatter', () => {
    expect(renderSectionedMarkdown(RICH, sec('CONTENT'))).toBe('# Intro\n\nBody.\n');
  });

  it('METADATA only → frontmatter, no body, no abstract/data/edges', () => {
    const out = renderSectionedMarkdown(RICH, sec('METADATA'));
    expect(out.startsWith('---\nname: Intro\nid: n-1\nloc: guide:intro\nmemory: acme.com:kb\n')).toBe(true);
    expect(out).not.toContain('abstract:');
    expect(out).not.toContain('data:');
    expect(out).not.toContain('nodes:');
    expect(out.endsWith('---\n\n\n')).toBe(true); // empty body
  });

  it('METADATA + EDGES → frontmatter keeps nodes:, drops abstract/data', () => {
    const out = renderSectionedMarkdown(RICH, sec('METADATA', 'EDGES'));
    expect(out).toContain('nodes:');
    expect(out).toContain('  - id: n-2');
    expect(out).not.toContain('abstract:');
  });

  it('JSON METADATA only → only identity fields', () => {
    const json = JSON.parse(renderSectionedJson(RICH, sec('METADATA')));
    expect(Object.keys(json).sort()).toEqual(
      ['alias', 'contentHash', 'description', 'id', 'isRunnable', 'loc', 'memory', 'name', 'objectType', 'role', 'seq', 'tags', 'type'].sort(),
    );
    expect(json).not.toHaveProperty('content');
    expect(json).not.toHaveProperty('edges');
    expect(json).not.toHaveProperty('abstract');
  });

  it('JSON CONTENT + EDGES → only those fields', () => {
    const json = JSON.parse(renderSectionedJson(RICH, sec('CONTENT', 'EDGES')));
    expect(Object.keys(json).sort()).toEqual(['content', 'edges'].sort());
  });
});

describe('renderNodeExport section default', () => {
  it('omitted sections (null) defaults to all', () => {
    const md = renderNodeExport(RICH, { format: 'MD', full: false, sections: null }).data;
    expect(md).toContain('abstract:');
    expect(md).toContain('nodes:');
    expect(md).toContain('# Intro');
  });

  it('an explicit empty [] means none, not all', () => {
    const json = renderNodeExport(RICH, { format: 'JSON', full: false, sections: [] }).data;
    expect(json).toBe('{}\n');
    const md = renderNodeExport(RICH, { format: 'MD', full: false, sections: [] }).data;
    expect(md).toBe(''); // no frontmatter, no body
  });

  it('full:true ignores sections entirely (canonical)', () => {
    const a = renderNodeExport(RICH, { format: 'JSON', full: true, sections: [] }).data;
    const b = renderCanonicalJson(RICH);
    expect(a).toBe(b);
  });
});

// #1340 — the governed-kind signals (role, isRunnable) and the collection
// discriminator (objectType) travel in the server-rendered file, keyed and placed
// exactly as the git mirror (buildNodeFrontmatter) and the CLI's nodedoc codec
// carry them (hadron-cli#717 governed_test.go, #725). Before this, a server
// export silently lost a node's kind: re-importing it made a spec an info node.
describe('#1340 — role, isRunnable and objectType', () => {
  const kind = (over: Partial<ExportNode>): ExportNode => ({
    id: 'n1', memoryUrn: 'acme.com:kb', loc: 'x', name: 'N', content: 'b', tags: [], edges: [], ...over,
  });

  it('MD: objectType right after type; role and runnable between seq and data', () => {
    const md = renderCanonicalMarkdown(
      kind({ nodeType: 'task', objectType: 'competitor', seq: 2, role: 'spec', isRunnable: true, data: { k: 'v' } }),
    );
    expect(md).toContain('\ntype: task\nobjectType: competitor\n');
    expect(md).toContain('\nseq: 2\nrole: spec\nrunnable: true\ndata:\n');
  });

  it('MD: an explicit `runnable: false` is kept; absent signals are not written', () => {
    expect(renderCanonicalMarkdown(kind({ isRunnable: false }))).toContain('\nrunnable: false\n');
    const absent = renderCanonicalMarkdown(kind({}));
    for (const key of ['role:', 'runnable:', 'objectType:']) expect(absent, key).not.toContain(key);
  });

  it.each([
    ['ordinary', { role: null, isRunnable: null }],
    ['task', { role: null, isRunnable: true }],
    ['spec', { role: 'spec', isRunnable: null }],
    ['review', { role: 'review', isRunnable: false }],
    ['custom dotted role', { role: 'acme.playbook', isRunnable: true }],
  ] as const)('JSON (%s): role and isRunnable after seq, null when unset, false kept', (_n, sig) => {
    const out = renderCanonicalJson(kind({ ...sig }));
    const json = JSON.parse(out);
    expect(json.role).toBe(sig.role);
    expect(json.isRunnable).toBe(sig.isRunnable);
    const keys = Object.keys(json);
    expect(keys.slice(keys.indexOf('seq'), keys.indexOf('seq') + 4)).toEqual(['seq', 'role', 'isRunnable', 'data']);
  });

  it('JSON: objectType right after type, "" when unset', () => {
    const set = JSON.parse(renderCanonicalJson(kind({ nodeType: 'task', objectType: 'insight' })));
    const keys = Object.keys(set);
    expect(keys.slice(keys.indexOf('type'), keys.indexOf('type') + 3)).toEqual(['type', 'objectType', 'alias']);
    expect(set.objectType).toBe('insight');
    expect(JSON.parse(renderCanonicalJson(kind({}))).objectType).toBe('');
  });

  it('sectioned MD/JSON: the three are METADATA, so a METADATA export keeps them and CONTENT-only drops them', () => {
    const n = kind({ objectType: 'insight', role: 'review', isRunnable: false });
    const md = renderSectionedMarkdown(n, sec('METADATA'));
    expect(md).toContain('\nobjectType: insight\n');
    expect(md).toContain('\nrole: review\nrunnable: false\n');
    expect(JSON.parse(renderSectionedJson(n, sec('METADATA')))).toMatchObject({
      objectType: 'insight', role: 'review', isRunnable: false,
    });
    expect(Object.keys(JSON.parse(renderSectionedJson(n, sec('CONTENT'))))).toEqual(['content']);
    expect(renderSectionedMarkdown(n, sec('CONTENT'))).toBe('b\n');
  });
});
