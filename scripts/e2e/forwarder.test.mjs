import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createForwarder } from './forwarder.mjs';

test('forwarder survives upstream reset, client abort, and strips connection headers', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/reset') {
      res.writeHead(200); res.write('partial');
      setTimeout(() => res.destroy(), 20); return;
    }
    if (req.url === '/slow') {
      res.writeHead(200); res.write('partial'); return;
    }
    assert.equal(req.headers['x-hop'], undefined);
    assert.equal(req.headers.authorization, 'Bearer synthetic');
    res.writeHead(200, { connection: 'x-reply-hop', 'x-reply-hop': 'hidden' });
    res.end('healthy');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createForwarder('127.0.0.1', upstream.address().port);
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const broken = await fetch(`${base}/reset`);
  await assert.rejects(broken.text());
  await new Promise((resolve, reject) => {
    const req = http.get(`${base}/slow`, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
    });
    req.once('error', reject);
  });
  await new Promise((resolve, reject) => {
    http.get(base, { headers: { authorization: 'Bearer synthetic', connection: 'x-hop', 'x-hop': 'hidden' } }, res => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-reply-hop'], undefined);
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { assert.equal(body, 'healthy'); resolve(); });
    }).on('error', reject);
  });
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  assert.equal((await fetch(base)).status, 503);
});
