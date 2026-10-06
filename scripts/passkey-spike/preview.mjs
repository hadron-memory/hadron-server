/** S1 preparation: fixture viewer only; ceremony follows the library decision. */
import express from 'express';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const fixture = JSON.parse(readFileSync(new URL('../../src/lib/signaturePayload.fixture.json', import.meta.url)));
const example = fixture.cases.find((c) => c.name === 'spec-retention-example');
const bytes = Buffer.from(example.canonical, 'base64');
if (createHash('sha256').update(bytes).digest('hex') !== example.challengeHex) {
  throw new Error('S0 fixture challenge mismatch');
}
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'");
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.get('/fixture', (_req, res) => res.json(example));
app.get('/', (_req, res) => res.sendFile(new URL('./index.html', import.meta.url).pathname));
app.get('/page.js', (_req, res) => res.sendFile(new URL('./page.js', import.meta.url).pathname));
app.get('/style.css', (_req, res) => res.sendFile(new URL('./style.css', import.meta.url).pathname));
const port = Number(process.env.PASSKEY_SPIKE_PORT || 4380);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PASSKEY_SPIKE_PORT');
app.listen(port, '127.0.0.1', () => process.stdout.write(`S1 fixture preview: http://localhost:${port}\n`));
