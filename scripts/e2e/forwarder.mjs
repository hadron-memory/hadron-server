import http from 'node:http';

// Preserve end-to-end headers (including Authorization), but never replay
// hop-by-hop connection options on the next leg.
function endToEnd(headers) {
  const skip = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
    ...(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !skip.has(key.toLowerCase())));
}
export function createForwarder(hostname, port) {
  return http.createServer((req, res) => {
    const fail = () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else { res.writeHead(503); res.end('Stack unavailable'); }
    };
    const upstream = http.request({ hostname, port, method: req.method,
      path: req.url, headers: endToEnd(req.headers) }, reply => {
      reply.on('error', fail);
      if (res.destroyed) { reply.destroy(); return; }
      res.writeHead(reply.statusCode ?? 502, endToEnd(reply.headers));
      reply.pipe(res);
    });
    upstream.on('error', fail);
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
}
