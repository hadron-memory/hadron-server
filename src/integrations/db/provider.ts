/**
 * Database provider adapter — abstracts differences between PostgreSQL and SQLite.
 *
 * PostgreSQL uses native arrays (String[]) and JSONB; SQLite stores both as TEXT.
 * This module provides serialization helpers so the rest of the app stays clean.
 */

export const isSqlite = process.env.DB_PROVIDER === 'sqlite';

// ---------------------------------------------------------------------------
// Tags: PostgreSQL String[] ↔ SQLite JSON string
// ---------------------------------------------------------------------------

export function serializeTags(tags: string[]): string[] | string {
  return isSqlite ? JSON.stringify(tags) : tags;
}

export function deserializeTags(raw: string[] | string): string[] {
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// Roles: PostgreSQL Role[] ↔ SQLite JSON string (same pattern as tags)
// ---------------------------------------------------------------------------

export function serializeRoles(roles: string[]): string[] | string {
  return isSqlite ? JSON.stringify(roles) : roles;
}

export function deserializeRoles(raw: string[] | string): string[] {
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// JSON fields: PostgreSQL Json ↔ SQLite TEXT
// ---------------------------------------------------------------------------

export function serializeJson(val: unknown): unknown {
  if (val == null) return val;
  return isSqlite ? JSON.stringify(val) : val;
}

export function deserializeJson(raw: unknown): unknown {
  if (raw == null) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Search: PostgreSQL supports mode: 'insensitive'; SQLite does not (but LIKE
// is already case-insensitive for ASCII).
// ---------------------------------------------------------------------------

export function searchContains(field: string, search: string): object {
  if (isSqlite) {
    return { [field]: { contains: search } };
  }
  return { [field]: { contains: search, mode: 'insensitive' } };
}

// ---------------------------------------------------------------------------
// Tags filter: PostgreSQL hasEvery; SQLite uses string contains as fallback.
// ---------------------------------------------------------------------------

export function tagsFilter(tags: string[]): object {
  if (isSqlite) {
    // Each tag must appear in the JSON string. Not perfect for substring
    // collisions, but tags are short distinct tokens and this matches the
    // PostgreSQL hasEvery semantics closely enough.
    return { AND: tags.map((t) => ({ tags: { contains: `"${t}"` } })) };
  }
  return { tags: { hasEvery: tags } };
}
