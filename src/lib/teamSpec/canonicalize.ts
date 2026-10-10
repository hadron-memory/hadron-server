/** RFC 8785 encoding for validated JSON values. Never normalizes prompt bytes. */
export function canonicalizeTeamJson(value: unknown): string {
  const active = new Set<object>();
  const quote = (s: string) => {
    // JSON.stringify accepts lone surrogates; RFC 8785 requires refusing them.
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = s.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Invalid Unicode in team JSON');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError('Invalid Unicode in team JSON');
    }
    return JSON.stringify(s);
  };
  const encode = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'string') return quote(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (!v || typeof v !== 'object') throw new TypeError('Not a JSON value');
    if (active.has(v)) throw new TypeError('Cyclic team JSON');
    active.add(v);
    try {
      if (Array.isArray(v)) return '[' + v.map(encode).join(',') + ']';
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError('Not a JSON object');
      return '{' + Object.keys(v).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in descriptor)) throw new TypeError('Not a JSON data property');
        return quote(key) + ':' + encode(descriptor.value);
      }).join(',') + '}';
    } finally { active.delete(v); }
  };
  return encode(value);
}
