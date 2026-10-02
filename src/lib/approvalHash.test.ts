import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { canonicalApprovalBytes, computeApprovalHash, type ApprovalHashFields } from './approvalHash.js';

interface FixtureCase {
  name: string;
  input: ApprovalHashFields;
  canonical: string;
  hash: string;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./approvalHash.fixture.json', import.meta.url)), 'utf8'),
) as { version: string; cases: FixtureCase[] };

const byName = (name: string) => fixture.cases.find((c) => c.name === name)!;

describe('approval hash v1 (#1591)', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s matches the published fixture byte for byte', (_, c) => {
    expect(canonicalApprovalBytes(c.input).toString('base64')).toBe(c.canonical);
    expect(computeApprovalHash(c.input)).toBe(c.hash);
  });

  it('is SHA-256 over exactly the fixture bytes, independent of this module', () => {
    for (const c of fixture.cases) {
      const independent = createHash('sha256').update(Buffer.from(c.canonical, 'base64')).digest('hex');
      expect(independent).toBe(c.hash);
    }
  });

  it('pins one serialization literally, so a symmetric change to code and fixture cannot pass', () => {
    expect(Buffer.from(byName('plain-ascii').canonical, 'base64').toString('utf8')).toBe(
      'hadron-approval-v1\ntitle 9\nApprovals\nabstract 16\nWho may approve.\ncontent 24\nAny writer may approve.\n\n',
    );
    expect(byName('plain-ascii').hash).toBe('14362639449d8a8f810ee4ccef5d61731b9f1e572332d2587e5f7aee84db6815');
  });

  it('normalizes CRLF and lone CR to LF, and nothing else', () => {
    expect(byName('crlf-normalized').hash).toBe(byName('lf-equals-crlf-twin').hash);
    // NFD stays NFD: no Unicode normalization.
    const nfc = computeApprovalHash({ title: 'Grüße', abstract: null, content: null });
    expect(byName('no-unicode-normalization-nfd').hash).not.toBe(nfc);
  });

  it('distinguishes null from the empty string', () => {
    expect(byName('all-null').hash).not.toBe(byName('empty-strings-differ-from-null').hash);
  });

  it('cannot be confused by content that looks like a field header', () => {
    const injected = byName('field-boundary-injection').input;
    const shifted = computeApprovalHash({ title: 'x', abstract: '', content: null });
    expect(computeApprovalHash(injected)).not.toBe(shifted);
  });

  it('covers every field: changing any one changes the hash', () => {
    const base = { title: 'T', abstract: 'A', content: 'C' };
    const h = computeApprovalHash(base);
    expect(computeApprovalHash({ ...base, title: 'T2' })).not.toBe(h);
    expect(computeApprovalHash({ ...base, abstract: 'A2' })).not.toBe(h);
    expect(computeApprovalHash({ ...base, content: 'C2' })).not.toBe(h);
  });
});
