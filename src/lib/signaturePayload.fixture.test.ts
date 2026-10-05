import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeApprovalHash, type ApprovalHashFields } from './approvalHash.js';

interface SignatureVector {
  name: string;
  input: { nodeId: string; fields: ApprovalHashFields };
  approvalHash: string;
  payloadUtf8: string;
  canonical: string;
  challengeHex: string;
  challengeBase64url: string;
}

const fixture = JSON.parse(
  readFileSync(new URL('./signaturePayload.fixture.json', import.meta.url), 'utf8'),
) as {
  version: string;
  approvalVersion: string;
  memoryMode: string;
  challengeAlgorithm: string;
  cases: SignatureVector[];
};
const vector = (name: string): SignatureVector => fixture.cases.find((c) => c.name === name)!;

/** S0 #1629: verify the independently generated artifact, not a runtime signing API. */
describe('published plaintext signature v1 fixture (cor:dmo:130:01)', () => {
  it('pins the complete published vector set and every input and expected byte', () => {
    expect(fixture.cases.map((c) => c.name)).toEqual([
      'spec-retention-example', 'all-null', 'empty-strings-differ-from-null',
      'plain-ascii', 'crlf-normalized', 'lone-cr-normalized', 'lf-equals-crlf-twin',
      'multibyte-utf8', 'no-unicode-normalization-nfd', 'field-boundary-injection',
      'whitespace-preserved', 'same-content-different-node',
    ]);
    // Independent Python hashlib pin of compact UTF-8 JSON; excludes file formatting.
    expect(createHash('sha256').update(JSON.stringify(fixture.cases)).digest('hex'))
      .toBe('f8c99a64157dab69ec01c3fb34bbbfbb3e01720988366f11314e7759eb562fa6');
  });

  it('checks lone-CR equivalence and preserves decomposed Unicode', () => {
    const cr = vector('lone-cr-normalized');
    expect(computeApprovalHash({ ...cr.input.fields, content: 'one\ntwo\n' }))
      .toBe(cr.approvalHash);
    const nfd = vector('no-unicode-normalization-nfd');
    expect(computeApprovalHash({ ...nfd.input.fields, title: 'Grüße' }))
      .not.toBe(nfd.approvalHash);
  });

  it('binds the node-id prefix as well as its suffix', () => {
    const example = vector('spec-retention-example');
    const prefixChanged = example.payloadUtf8.replace(
      example.input.nodeId, '11a10408afb6716c80d6944e8845467b',
    );
    expect(createHash('sha256').update(prefixChanged).digest('hex')).not.toBe(example.challengeHex);
  });

  it('names its version and plaintext-only boundary', () => {
    expect(fixture).toMatchObject({
      version: 'hadron-signature-v1',
      approvalVersion: 'hadron-approval-v1',
      memoryMode: 'plaintext',
      challengeAlgorithm: 'SHA-256',
    });
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s has reproducible bytes and raw-digest encodings', (_, c) => {
    expect(c.approvalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeApprovalHash(c.input.fields)).toBe(c.approvalHash);
    const bytes = Buffer.from(c.canonical, 'base64');
    expect(bytes.toString('utf8')).toBe(c.payloadUtf8);
    expect(c.payloadUtf8).toBe(
      `hadron-signature-v1\nnode ${c.input.nodeId}\napproval-hash ${c.approvalHash}\n`,
    );
    const digest = createHash('sha256').update(bytes).digest();
    expect(digest).toHaveLength(32);
    expect(digest.toString('hex')).toBe(c.challengeHex);
    expect(digest.toString('base64url')).toBe(c.challengeBase64url);
    expect(Buffer.from(c.challengeBase64url, 'base64url')).toEqual(digest);
  });

  it('pins the spec example literally to catch coordinated fixture/codec drift', () => {
    const example = vector('spec-retention-example');
    expect(example.payloadUtf8).toBe(
      'hadron-signature-v1\nnode 01a10408afb6716c80d6944e8845467b\n' +
      'approval-hash 82af07de06359450e375ee9f1e3639f5f124d2e2d9ed176001ff108175ce1246\n',
    );
    expect(example.challengeHex).toBe('fc853d4b671d459dad9d811d4ad3d1850a5edda1d6d21976bcc5d45d13f8abca');
    expect(example.challengeBase64url).toBe('_IU9S2cdRZ2tnYEdStPRhQpe3aHW0hl2vMXUXRP4q8o');
  });

  it('binds identical text to the stable node identity', () => {
    const first = vector('spec-retention-example');
    const second = vector('same-content-different-node');
    expect(first.approvalHash).toBe(second.approvalHash);
    expect(first.challengeHex).not.toBe(second.challengeHex);
  });

  it('inherits approval v1 line-ending equivalence and null/empty distinction', () => {
    expect(vector('crlf-normalized').challengeHex).toBe(vector('lf-equals-crlf-twin').challengeHex);
    expect(vector('all-null').challengeHex).not.toBe(vector('empty-strings-differ-from-null').challengeHex);
  });

  it('distinguishes the final LF, digest bytes and hex-text bytes', () => {
    const example = vector('spec-retention-example');
    const noFinalLF = createHash('sha256').update(example.payloadUtf8.slice(0, -1)).digest('hex');
    expect(noFinalLF).not.toBe(example.challengeHex);
    // WebAuthn receives the digest's 32 raw bytes, not UTF-8 of its 64 hex characters.
    expect(Buffer.from(example.challengeHex, 'utf8').toString('base64url')).not.toBe(example.challengeBase64url);
  });
});
