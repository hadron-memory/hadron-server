import type { WebFetchAuth } from '../webfetchClient.js';

/** Remove an injected credential from every string and key in a JSON-shaped tool result (#4000). */
export function redactSecretUse(value: unknown, auth: WebFetchAuth): unknown {
  const raw = auth.type === 'bearer' ? [auth.token] : auth.type === 'header' ? [auth.value] :
    [auth.username, auth.password, `${auth.username}:${auth.password}`, Buffer.from(`${auth.username}:${auth.password}`).toString('base64')];
  const variants = new Set<string>();
  for (const secret of raw) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    variants.add(Buffer.from(secret).toString('base64'));
    variants.add(new URLSearchParams({ v: secret }).toString().slice(2));
    try { const enc = encodeURIComponent(secret); variants.add(enc); variants.add(enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())); } catch { /* a lone surrogate has no URI encoding */ }
  }
  const needles = [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
  // A credential can itself be a substring of the normal marker. Pick a character outside every needle in that case.
  let marker = '[REDACTED]';
  if (needles.some((s) => marker.includes(s))) {
    let code = 0xe000;
    while (code <= 0xf8ff && needles.some((s) => String.fromCharCode(code).includes(s))) code++;
    if (code > 0xf8ff) throw new Error('Cannot safely redact secret use result.');
    marker = String.fromCharCode(code);
  }
  const clean = (s: string) => needles.reduce((out, needle) => out.split(needle).join(marker), s);
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return clean(v);
    if (v === null || typeof v === 'number' || typeof v === 'boolean') {
      const rendered = JSON.stringify(v);
      return needles.some((needle) => rendered.includes(needle)) ? marker : v;
    }
    if (typeof v !== 'object') return v;
    if (seen.has(v)) throw new Error('Cannot safely redact secret use result.');
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map(walk);
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, entry] of Object.entries(v)) out[clean(key)] = walk(entry);
      return out;
    } finally { seen.delete(v); }
  };
  return walk(value);
}
