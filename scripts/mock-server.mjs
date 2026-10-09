import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_ITEMS = 10_000;
const MAX_BODY_BYTES = 16 * 1024;
const TTL_MS = 15 * 60 * 1000;

export async function createMockServer({ port = 0 } = {}) {
  const items = new Map();
  const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(body));
  };
  const prune = () => {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, item] of items) if (item.updatedAt < cutoff) items.delete(id);
  };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && pathname === '/health') return json(response, 200, { status: 'ok' });
      prune();
      if (request.method === 'GET' && pathname === '/items') return json(response, 200, { items: [...items.values()].slice(0, 100).map(({ updatedAt, ...item }) => item) });
      const match = /^\/items\/([A-Za-z0-9-]+)$/.exec(pathname);
      if (match && !items.has(match[1])) return json(response, 404, { error: 'Item not found' });
      if (match && request.method === 'GET') {
        const { updatedAt, ...item } = items.get(match[1]);
        return json(response, 200, item);
      }
      if (match && request.method === 'DELETE') {
        items.delete(match[1]);
        response.writeHead(204);
        return response.end();
      }
      if ((pathname === '/items' && request.method === 'POST') || (match && request.method === 'PATCH')) {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return json(response, 415, { error: 'JSON content type required' });
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            json(response, 413, { error: 'Request body too large' });
            request.resume();
            return;
          }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(response, 400, { error: 'Invalid JSON' }); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return json(response, 400, { error: 'Object body required' });
        const allowed = ['name', 'quantity', 'reference'];
        if (Object.keys(body).some(key => !allowed.includes(key))) return json(response, 400, { error: 'Unexpected field' });
        const existing = match ? items.get(match[1]) : undefined;
        const next = { ...existing, ...body };
        if (typeof next.name !== 'string' || next.name.length < 1 || next.name.length > 200 || !Number.isInteger(next.quantity) || next.quantity < 0 || next.quantity > 100_000 || (next.reference !== undefined && (typeof next.reference !== 'string' || next.reference.length > 200))) return json(response, 400, { error: 'Invalid item fields' });
        if (!match && items.size >= MAX_ITEMS) return json(response, 503, { error: 'Demo capacity reached' });
        const id = match?.[1] ?? randomUUID();
        const item = { id, name: next.name, quantity: next.quantity, ...(next.reference !== undefined ? { reference: next.reference } : {}) };
        items.set(id, { ...item, updatedAt: Date.now() });
        return json(response, match ? 200 : 201, item);
      }
      return json(response, 404, { error: 'Route not found' });
    } catch {
      if (!response.headersSent) json(response, 400, { error: 'Request could not be processed' });
      else response.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  return { server, baseUrl: 'http://127.0.0.1:' + address.port, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rawPort = process.env.MOCK_PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MOCK_PORT must be an integer between 1 and 65535.');
  const mock = await createMockServer({ port });
  console.log('Synthetic API listening on ' + mock.baseUrl);
  const shutdown = () => { mock.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
