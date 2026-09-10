import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DealEngine, SimulatedExecutor } from './engine.mjs';
import { RealExecutor } from './real-executor.mjs';
import { createDealSession, HUB_ROOT, listSessions, PROFILES, readCompletedPublicRecord } from './session.mjs';

export const CONNECTOR_HOST = '127.0.0.1';
export const CONNECTOR_PORT = 8787;
export const PAIRING_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 32 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pairingPath = (root, id) => resolve(root, 'pairing', `blackbox-pairing-${id}.json`);

export async function createPairing({ root = HUB_ROOT, now = () => Date.now(), random = randomBytes, port = CONNECTOR_PORT } = {}) {
  const createdAtMs = now(); const id = random(8).toString('hex'); const token = random(32).toString('base64url');
  const record = { schema: 'tclk-blackbox/connector-pairing/v1', connectorUrl: `http://${CONNECTOR_HOST}:${port}`,
    sessionId: id, token, createdAt: new Date(createdAtMs).toISOString(), expiresAt: new Date(createdAtMs + PAIRING_TTL_MS).toISOString() };
  await mkdir(resolve(root, 'pairing'), { recursive: true, mode: 0o700 });
  const path = pairingPath(root, id); await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return Object.freeze({ record, path });
}

function tokenEqual(left, right) {
  const a = Buffer.from(left ?? '', 'utf8'); const b = Buffer.from(right ?? '', 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function readBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > MAX_BODY) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 }); chunks.push(chunk); }
  if (length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('INVALID_JSON'), { status: 400 }); }
}

export async function createConnector({ root = HUB_ROOT, port = CONNECTOR_PORT, now = () => Date.now(),
  origins = ['http://127.0.0.1:4173', 'http://localhost:4173'], mode = 'real', transport } = {}) {
  const pairing = await createPairing({ root, now, port });
  const executor = mode === 'simulated' ? new SimulatedExecutor({ submitOutcomes: ['SUBMISSION_UNCERTAIN', 'ACK_RECEIVED'] }) : new RealExecutor({ root, ...(transport ? { transport } : {}) });
  const engine = new DealEngine({ root, executor }); const rate = new Map();
  const allowedOrigins = new Set(origins);

  async function handler(request, response) {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return json(response, 403, { error: 'ORIGIN_REFUSED' });
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (request.method === 'OPTIONS') return response.writeHead(204).end();
    const url = new URL(request.url ?? '/', `http://${CONNECTOR_HOST}:${port}`);
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { status: 'CONNECTOR_FOUND', pairingRequired: true, loopbackOnly: true });
    if (!origin) return json(response, 403, { error: 'ORIGIN_REQUIRED' });
    const publicRecord = request.method === 'GET' && url.pathname.match(/^\/records\/(bbx-[0-9a-f]{16})$/);
    if (publicRecord) {
      const bucket = `public:${origin}:${Math.floor(now() / 60000)}`; const count = (rate.get(bucket) ?? 0) + 1; rate.set(bucket, count);
      if (count > 120) return json(response, 429, { error: 'RATE_LIMITED' });
      try { return json(response, 200, await readCompletedPublicRecord(publicRecord[1], { root })); }
      catch (error) { return json(response, error.status ?? 404, { error: error.message }); }
    }
    const authorization = request.headers.authorization ?? ''; const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (now() >= Date.parse(pairing.record.expiresAt) || !tokenEqual(supplied, pairing.record.token)) return json(response, 401, { error: 'PAIRING_REQUIRED' });
    const bucket = `${pairing.record.sessionId}:${Math.floor(now() / 60000)}`; const count = (rate.get(bucket) ?? 0) + 1; rate.set(bucket, count);
    if (count > 120) return json(response, 429, { error: 'RATE_LIMITED' });
    try {
      if (request.method === 'GET' && url.pathname === '/session') return json(response, 200, { status: 'CONNECTED',
        sessionId: pairing.record.sessionId, expiresAt: pairing.record.expiresAt, mode: mode === 'simulated' ? 'SIMULATED / LOCAL TEST' : 'LOCAL REAL EXECUTION' });
      if (request.method === 'GET' && url.pathname === '/profiles') return json(response, 200, { operatorModel: 'ONE_HUMAN_OPERATOR_TWO_DISTINCT_CRYPTOGRAPHIC_DIDS', profiles: PROFILES });
      if (request.method === 'GET' && url.pathname === '/deals') return json(response, 200, { deals: await listSessions({ root }) });
      if (request.method === 'POST' && url.pathname === '/deals') {
        const body = await readBody(request); const deal = await createDealSession({ amount: body.amount, asset: body.asset,
          profileA: body.profileA, profileB: body.profileB, mode }, { root, now }); return json(response, 201, deal);
      }
      const match = url.pathname.match(/^\/deals\/(bbx-[0-9a-f]{16})(?:\/actions\/(bbx-[0-9a-f]{16}-write-[1-6])\/(prepare|execute)|\/(refresh|finalize))?$/);
      if (!match) return json(response, 404, { error: 'ROUTE_NOT_ALLOWED' });
      const [, id, operationId, action, dealAction] = match;
      if (request.method === 'GET' && !operationId && !dealAction) return json(response, 200, await engine.inspect(id));
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (action === 'prepare') return json(response, 200, await engine.prepare(id, operationId));
      if (action === 'execute') return json(response, 200, await engine.execute(id, operationId));
      const body = await readBody(request);
      if (dealAction === 'refresh') return json(response, 200, await engine.refresh(id, body.operationId));
      if (dealAction === 'finalize') return json(response, 200, await engine.finalize(id));
      return json(response, 404, { error: 'ROUTE_NOT_ALLOWED' });
    } catch (error) { return json(response, error.status ?? 409, { error: error.message }); }
  }
  return Object.freeze({ handler, pairing, engine, host: CONNECTOR_HOST, port,
    createServer: () => createServer(handler) });
}

function json(response, status, value) {
  const body = JSON.stringify(value); response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body);
}

async function main() {
  const port = Number.parseInt(process.env.BLACKBOX_CONNECTOR_PORT ?? String(CONNECTOR_PORT), 10);
  const origins = (process.env.BLACKBOX_WEB_ORIGIN ?? 'http://127.0.0.1:4173,http://localhost:4173').split(',').map(item => item.trim()).filter(Boolean);
  const mode = process.argv.includes('--simulated') || process.env.BLACKBOX_CONNECTOR_MODE === 'simulated' ? 'simulated' : 'real';
  const connector = await createConnector({ port, origins, mode }); const server = connector.createServer();
  server.listen(port, CONNECTOR_HOST, () => {
    process.stdout.write(`BLACKBOX connector ready on http://${CONNECTOR_HOST}:${port}\n`);
    process.stdout.write(`Mode: ${mode === 'simulated' ? 'SIMULATED / LOCAL TEST (NO LIVE ACTIONS)' : 'LOCAL REAL EXECUTION'}\n`);
    process.stdout.write(`Pairing file: ${connector.pairing.path}\n`);
    process.stdout.write(`Pairing expires: ${connector.pairing.record.expiresAt}\n`);
    process.stdout.write('Import that file in BLACKBOX. Pairing tokens and custody secrets are never printed.\n');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });

export const pairingFingerprint = record => sha256(`${record.sessionId}|${record.connectorUrl}|${record.expiresAt}`);
