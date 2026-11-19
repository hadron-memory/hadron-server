// Local stand-in for the embedding endpoint (#2598): Ollama batch shape, deterministic vectors, no provider spend,
// no real data. Counts requests and inputs only.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export const EMBED_DIM = 768;
export function vectorFor(text) {
  const out = new Array(EMBED_DIM); let h = createHash('sha256').update(String(text)).digest();
  for (let i = 0; i < EMBED_DIM; i++) { if (i % 32 === 0 && i) h = createHash('sha256').update(h).digest(); out[i] = (h[i % 32] - 127.5) / 127.5; }
  return out;
}
export function embedResponse(body) {
  const inputs = Array.isArray(body?.input) ? body.input : typeof body?.input === 'string' ? [body.input] : null;
  if (!inputs) throw new Error('bad embed request');
  return { embeddings: inputs.map(vectorFor) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = { requests: 0, inputs: 0 };
  createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/count') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(counts)); }
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { const r = embedResponse(JSON.parse(raw)); counts.requests++; counts.inputs += r.embeddings.length; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r)); }
      catch { res.statusCode = 400; res.end('bad request'); }
    });
  }).listen(Number(process.env.PORT ?? 11435), '0.0.0.0');
}
