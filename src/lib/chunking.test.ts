import { describe, it, expect } from 'vitest';
import { chunkNode } from './chunking.js';

describe('chunkNode — strategy selection (FR-015)', () => {
  it('empty / whitespace-only content → no chunks', () => {
    expect(chunkNode('')).toEqual([]);
    expect(chunkNode('   \n  \n')).toEqual([]);
  });

  it('content with 2+ markdown headings → structure-aware (section per heading)', () => {
    const md = [
      '# Intro',
      'Some intro text.',
      '',
      '## Section A',
      'Body of A.',
      '',
      '## Section B',
      'Body of B.',
    ].join('\n');
    const chunks = chunkNode(md);
    expect(chunks.length).toBe(3); // Intro, A, B
    expect(chunks[0].text.startsWith('# Intro')).toBe(true);
    expect(chunks[1].text.startsWith('## Section A')).toBe(true);
    expect(chunks[2].text.startsWith('## Section B')).toBe(true);
  });

  it('content with only one heading → fixed-size fallback (one heading is not "usable structure")', () => {
    // Single heading + small body; fixed-size emits one window for short
    // content. Different from structure-aware (which would emit one giant
    // chunk for the whole body).
    const md = '# Lonely heading\n\nA short body.';
    const chunks = chunkNode(md);
    // Just verify it didn't go down the structure-aware path: structure-
    // aware would have emitted a single chunk too here, so we check the
    // strategy via the dials behavior — fixed-size respects chunkTokens.
    const small = chunkNode(md, { chunkTokens: 5, chunkOverlap: 1 });
    expect(small.length).toBeGreaterThan(1); // fixed-size split into windows
  });

  it('content with no headings → fixed-size', () => {
    const prose = 'A'.repeat(5000);
    const chunks = chunkNode(prose, { chunkTokens: 100, chunkOverlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].charStart).toBe(0);
    // chunkIndex is 0-based and contiguous.
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  it('forceFixedSize bypasses structure-aware even when headings are present', () => {
    // Use long-enough sections that fixed-size (with the small window
    // below) actually emits MORE chunks than structure-aware (one per
    // heading-section).
    const body = 'A'.repeat(800);
    const md = `# A\n${body}\n## B\n${body}\n## C\n${body}`;
    const structureAware = chunkNode(md);
    const forced = chunkNode(md, { forceFixedSize: true, chunkTokens: 50, chunkOverlap: 0 });
    expect(forced.length).toBeGreaterThan(structureAware.length);
  });
});

describe('chunkNode — locator metadata (FR-016)', () => {
  it('charStart/charEnd are character offsets that slice back to the chunk text', () => {
    const md = '# A\nalpha\n## B\nbeta\n## C\ngamma';
    const chunks = chunkNode(md);
    for (const c of chunks) {
      expect(md.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  it('chunkIndex is 0-based, contiguous, document-order', () => {
    const md = '# A\n## B\n## C\n## D';
    const chunks = chunkNode(md);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3]);
  });

  it('preamble before first heading becomes its own chunk (no content lost)', () => {
    // Need 2+ headings for the structure-aware path to engage (1 heading
    // == "not enough structure" → fixed-size fallback, no preamble split).
    const md = 'Preamble paragraph.\n\n# First heading\nBody.\n\n## Second heading\nMore body.';
    const chunks = chunkNode(md);
    expect(chunks.length).toBe(3);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].text).toContain('Preamble');
    expect(chunks[1].text).toContain('First heading');
    expect(chunks[2].text).toContain('Second heading');
  });
});

describe('chunkNode — fixed-size dials (FR-003 + FR-015)', () => {
  it('chunkTokens controls window size (chars = tokens * 4)', () => {
    const content = 'A'.repeat(400);
    const c50 = chunkNode(content, { forceFixedSize: true, chunkTokens: 50, chunkOverlap: 0 });
    // 50 tokens * 4 chars = 200-char window, no overlap → exactly 2 chunks.
    expect(c50.length).toBe(2);
    expect(c50[0].charStart).toBe(0);
    expect(c50[0].charEnd).toBe(200);
    expect(c50[1].charStart).toBe(200);
    expect(c50[1].charEnd).toBe(400);
  });

  it('chunkOverlap creates sliding-window overlap', () => {
    const content = 'A'.repeat(400);
    const overlapped = chunkNode(content, {
      forceFixedSize: true,
      chunkTokens: 50,
      chunkOverlap: 10,
    });
    // window=200, step=(50-10)*4=160. Chunks at [0,200), [160,360), [320,400).
    expect(overlapped.length).toBe(3);
    expect(overlapped[0].charStart).toBe(0);
    expect(overlapped[0].charEnd).toBe(200);
    expect(overlapped[1].charStart).toBe(160);
    expect(overlapped[1].charEnd).toBe(360);
    expect(overlapped[2].charStart).toBe(320);
    expect(overlapped[2].charEnd).toBe(400);
  });

  it('platform defaults (~512 tokens / ~64 overlap) emit one chunk for small content', () => {
    const content = 'A short note.';
    const chunks = chunkNode(content, { forceFixedSize: true });
    expect(chunks.length).toBe(1);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].charEnd).toBe(content.length);
    expect(chunks[0].text).toBe(content);
  });
});

describe('chunkNode — structure-aware edge cases', () => {
  it('skips heading-like lines inside fenced code blocks', () => {
    // Without the fenced-block guard, the `# comment` inside the code
    // block would create a section boundary mid-snippet — wrong.
    const md = [
      '# Real heading',
      '',
      '```python',
      '# This is a Python comment, not a heading',
      'x = 1',
      '```',
      '',
      '## Another real heading',
      'Body.',
    ].join('\n');
    const chunks = chunkNode(md);
    // 2 real headings → 2 chunks. If the code-fence guard fails, we'd
    // see 3 because the comment would become a third section boundary.
    expect(chunks.length).toBe(2);
  });

  it('long section falls through to fixed-size windowing within section bounds', () => {
    // One heading with a giant body. Structure-aware should fall through
    // to fixed-size for the long body so it doesn't emit one over-long chunk.
    const longBody = 'A'.repeat(20_000);
    const md = `# Heading\n## Subsection\n${longBody}`;
    const chunks = chunkNode(md, { chunkTokens: 500, chunkOverlap: 50 });
    // Multiple chunks for the long subsection.
    expect(chunks.length).toBeGreaterThan(2);
    // First chunk is the Heading section (small).
    expect(chunks[0].text.startsWith('# Heading')).toBe(true);
    // Subsequent chunks cover the Subsection's body.
    expect(chunks[1].text.startsWith('## Subsection')).toBe(true);
  });
});
