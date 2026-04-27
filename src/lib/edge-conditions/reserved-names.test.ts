import { describe, it, expect } from 'vitest';
import {
  validateExtractionSpec,
  validateNodeDataExtractionSpecs,
} from './reserved-names.js';

describe('edge-conditions / validateExtractionSpec', () => {
  it('accepts an empty array', () => {
    expect(validateExtractionSpec([])).toEqual({ ok: true });
  });

  it('accepts unrelated fields', () => {
    expect(
      validateExtractionSpec([
        { field: 'business_type' },
        { field: 'team_size', shape: 'number' },
        { field: 'country_of_residence' },
      ]),
    ).toEqual({ ok: true });
  });

  it("rejects field === 'exception'", () => {
    const r = validateExtractionSpec([{ field: 'exception' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('RESERVED_NAME');
      expect(r.error.detail.field).toBe('message.data.exception');
    }
  });

  it("rejects field === 'exceptions'", () => {
    const r = validateExtractionSpec([{ field: 'exceptions' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESERVED_NAME');
  });

  it("rejects sub-paths under exception(s)", () => {
    expect(validateExtractionSpec([{ field: 'exception.code' }]).ok).toBe(false);
    expect(validateExtractionSpec([{ field: 'exceptions.0' }]).ok).toBe(false);
    expect(validateExtractionSpec([{ field: 'exceptions[0]' }]).ok).toBe(false);
  });

  it("does not reject lookalike fields like 'exception_count'", () => {
    expect(validateExtractionSpec([{ field: 'exception_count' }])).toEqual({ ok: true });
    expect(validateExtractionSpec([{ field: 'no_exceptions_today' }])).toEqual({ ok: true });
  });

  it('rejects on the first offending entry even if later entries are clean', () => {
    const r = validateExtractionSpec([
      { field: 'business_type' },
      { field: 'exception' },
      { field: 'team_size' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.detail.field).toBe('message.data.exception');
  });

  it('skips entries with non-string fields without errors', () => {
    const entries = [
      { field: 'ok_field' },
      { field: undefined as unknown as string },
      null as unknown as { field: string },
    ];
    expect(validateExtractionSpec(entries).ok).toBe(true);
  });
});

describe('edge-conditions / validateNodeDataExtractionSpecs', () => {
  it('accepts data with no extraction-spec keys', () => {
    expect(validateNodeDataExtractionSpecs({ stageOrder: ['a', 'b'] })).toEqual({ ok: true });
  });

  it('validates agentExtractionSpec on agent config nodes', () => {
    const r = validateNodeDataExtractionSpecs({
      agentExtractionSpec: [{ field: 'exception' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESERVED_NAME');
  });

  it('validates extractionSpec on conversation / stage nodes', () => {
    const r = validateNodeDataExtractionSpecs({
      extractionSpec: [{ field: 'exceptions' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESERVED_NAME');
  });

  it('reports the first offender across both keys', () => {
    const r = validateNodeDataExtractionSpecs({
      agentExtractionSpec: [{ field: 'business_type' }],
      extractionSpec: [{ field: 'exception.code' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.detail.field).toBe('message.data.exception.code');
  });

  it('passes through clean data', () => {
    expect(
      validateNodeDataExtractionSpecs({
        agentExtractionSpec: [{ field: 'business_type' }],
        extractionSpec: [{ field: 'team_size' }],
      }),
    ).toEqual({ ok: true });
  });

  it('handles non-object inputs cleanly', () => {
    expect(validateNodeDataExtractionSpecs(null)).toEqual({ ok: true });
    expect(validateNodeDataExtractionSpecs(undefined)).toEqual({ ok: true });
    expect(validateNodeDataExtractionSpecs('a string')).toEqual({ ok: true });
  });
});
