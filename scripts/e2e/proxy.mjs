// Container-private loopback hop preserves the existing dev-login peer gate.
// Only the disposable compose file publishes this port, on host loopback.
import http from 'node:http';
http.createServer((req, res) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: 4000,
    method: req.method, path: req.url, headers: req.headers }, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(503); res.end('Starting'); });
  req.pipe(upstream);
}).listen(4100, '0.0.0.0');
