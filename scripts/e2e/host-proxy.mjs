import http from 'node:http';
const [port, address] = process.argv.slice(2);
http.createServer((req, res) => {
  const upstream = http.request({ hostname: address, port, method: req.method,
    path: req.url, headers: req.headers }, reply => {
    res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(503); res.end('Stack unavailable'); });
  req.pipe(upstream);
}).listen(Number(port), '127.0.0.1');
