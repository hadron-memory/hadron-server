import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Helper to re-import the module with a given DB_PROVIDER value.
// provider.ts reads `process.env.DB_PROVIDER` at module load time, so we must
// reset the module registry and reload after each env change.
async function importProvider(dbProvider: string) {
  vi.resetModules();
  process.env.DB_PROVIDER = dbProvider;
  return import('./provider.js');
}

describe('provider — PostgreSQL mode', () => {
  let provider: Awaited<ReturnType<typeof importProvider>>;

  beforeEach(async () => {
    provider = await importProvider('postgresql');
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('serializeTags', () => {
    it('passes through an array unchanged', () => {
      expect(provider.serializeTags(['a', 'b'])).toEqual(['a', 'b']);
    });
    it('passes through empty array', () => {
      expect(provider.serializeTags([])).toEqual([]);
    });
  });

  describe('deserializeTags', () => {
    it('passes through an array unchanged', () => {
      expect(provider.deserializeTags(['a', 'b'])).toEqual(['a', 'b']);
    });
    it('parses a JSON string (cross-compat)', () => {
      expect(provider.deserializeTags('["a","b"]')).toEqual(['a', 'b']);
    });
  });

  describe('serializeJson', () => {
    it('passes through objects unchanged', () => {
      const obj = { x: 1 };
      expect(provider.serializeJson(obj)).toBe(obj);
    });
    it('passes through null', () => {
      expect(provider.serializeJson(null)).toBeNull();
    });
  });

  describe('deserializeJson', () => {
    it('passes through objects unchanged', () => {
      const obj = { x: 1 };
      expect(provider.deserializeJson(obj)).toBe(obj);
    });
    it('parses a JSON string (cross-compat)', () => {
      expect(provider.deserializeJson('{"x":1}')).toEqual({ x: 1 });
    });
    it('passes through null', () => {
      expect(provider.deserializeJson(null)).toBeNull();
    });
    it('returns raw string if JSON.parse fails', () => {
      expect(provider.deserializeJson('not-json')).toBe('not-json');
    });
  });

  describe('searchContains', () => {
    it('includes mode: insensitive', () => {
      expect(provider.searchContains('name', 'foo')).toEqual({
        name: { contains: 'foo', mode: 'insensitive' },
      });
    });
  });

  describe('tagsFilter', () => {
    it('uses hasEvery', () => {
      expect(provider.tagsFilter(['a', 'b'])).toEqual({
        tags: { hasEvery: ['a', 'b'] },
      });
    });
  });
});

describe('provider — SQLite mode', () => {
  let provider: Awaited<ReturnType<typeof importProvider>>;

  beforeEach(async () => {
    provider = await importProvider('sqlite');
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('serializeTags', () => {
    it('returns a JSON string', () => {
      expect(provider.serializeTags(['a', 'b'])).toBe('["a","b"]');
    });
    it('returns empty JSON array for empty input', () => {
      expect(provider.serializeTags([])).toBe('[]');
    });
  });

  describe('deserializeTags', () => {
    it('parses a JSON string', () => {
      expect(provider.deserializeTags('["a","b"]')).toEqual(['a', 'b']);
    });
    it('passes through an array', () => {
      expect(provider.deserializeTags(['a'])).toEqual(['a']);
    });
  });

  describe('serializeJson', () => {
    it('stringifies an object', () => {
      expect(provider.serializeJson({ x: 1 })).toBe('{"x":1}');
    });
    it('passes through null', () => {
      expect(provider.serializeJson(null)).toBeNull();
    });
  });

  describe('searchContains', () => {
    it('does NOT include mode', () => {
      const result = provider.searchContains('name', 'foo') as Record<string, unknown>;
      expect((result.name as Record<string, unknown>)).not.toHaveProperty('mode');
    });
  });

  describe('tagsFilter', () => {
    it('uses AND + contains for each tag', () => {
      expect(provider.tagsFilter(['x', 'y'])).toEqual({
        AND: [
          { tags: { contains: '"x"' } },
          { tags: { contains: '"y"' } },
        ],
      });
    });
  });
});
