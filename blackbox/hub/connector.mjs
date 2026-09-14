import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DealEngine, SimulatedExecutor } from './engine.mjs';
import { RealExecutor } from './real-executor.mjs';
import { createDealSession, HUB_ROOT, listSessions, readCompletedPublicRecord } from './session.mjs';
import { IdentityManager, verifyPublicSignature } from './identity.mjs';
import { describeInput, MAX_INPUT_BYTES, validateTranscript } from '../workloads/transcript-validation/verifier.mjs';
import { publicSafePublication } from '../workloads/validation-publication/service.mjs';
import { assertReviewedW2Signer } from '../workloads/validation-publication/custody-bridge.mjs';
import { createProductionW2Service } from '../workloads/validation-publication/production.mjs';

export const CONNECTOR_HOST = '127.0.0.1';
export const CONNECTOR_PORT = 8787;
export const PAIRING_TTL_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'https://tclk-blackbox.vercel.app',
]);
const MAX_BODY = 32 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pairingPath = (root, id) => resolve(root, 'pairing', `blackbox-pairing-${id}.json`);
const IMPORT_TTL_MS = 10 * 60 * 1000;
const MAX_IMPORTS = 4;
const importPage = new URL('../workloads/transcript-validation/import.html', import.meta.url);
const importScript = new URL('../workloads/transcript-validation/import.js', import.meta.url);

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

async function readTranscript(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > MAX_INPUT_BYTES) throw Object.assign(new Error('INPUT_TOO_LARGE'), { status: 413, category: 'INPUT_REJECTED', code: 'INPUT_TOO_LARGE' }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

function localPage(response, body, type) {
  response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  response.end(body);
}

export async function createConnector({ root = HUB_ROOT, port = CONNECTOR_PORT, now = () => Date.now(),
  origins = DEFAULT_ALLOWED_ORIGINS, mode = 'real', transport, identityManager, publicationService } = {}) {
  const pairing = await createPairing({ root, now, port });
  const executor = mode === 'simulated' ? new SimulatedExecutor({ submitOutcomes: ['SUBMISSION_UNCERTAIN', 'ACK_RECEIVED'] }) : new RealExecutor({ root, ...(transport ? { transport } : {}) });
  const engine = new DealEngine({ root, executor }); const rate = new Map();
  const imports = new Map();
  const identities = identityManager ?? new IdentityManager({ root, now, ...(mode === 'simulated' ? { identityRoot: null } : {}) });
  let activePublication = publicationService;
  if (!activePublication && mode === 'real') {
    try { await assertReviewedW2Signer(); activePublication = createProductionW2Service({ root, identities, now }); } catch { activePublication = null; }
  }
  const allowedOrigins = new Set([...origins, `http://${CONNECTOR_HOST}:${port}`]);

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
    if (request.method === 'GET' && (url.pathname === '/workloads/import' || url.pathname === '/workloads/import.js')) {
      const bytes = await readFile(url.pathname.endsWith('.js') ? importScript : importPage);
      return localPage(response, bytes, url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    }
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
    for (const [id, item] of imports) if (now() - item.createdAtMs >= IMPORT_TTL_MS) imports.delete(id);
    try {
      if (request.method === 'POST' && url.pathname === '/workloads/import') {
        if (origin !== `http://${CONNECTOR_HOST}:${port}`) return json(response, 403, { error: 'LOCAL_IMPORT_ORIGIN_REQUIRED' });
        if (imports.size >= MAX_IMPORTS) return json(response, 429, { category: 'INPUT_REJECTED', code: 'TOO_MANY_IMPORTS' });
        const room = request.headers['x-blackbox-room']; const generation = request.headers['x-room-generation'] ?? null;
        const bytes = await readTranscript(request);
        const inspected = describeInput(bytes, { room, generation, mediaType: request.headers['content-type'] ?? '' });
        if (inspected.category !== 'INPUT_ACCEPTED') return json(response, inspected.category === 'INPUT_REJECTED' ? 400 : 500, inspected);
        const importId = `w1-${randomBytes(16).toString('hex')}`;
        imports.set(importId, { bytes, room, generation, createdAtMs: now(), descriptor: inspected.descriptor });
        return json(response, 201, { importId, ...inspected.descriptor });
      }
      const publication = url.pathname.match(/^\/workloads\/(w1-[0-9a-f]{32})\/publication(?:\/(prepare|w2op1-[0-9a-f]{64})(?:\/(sign|submit|observe|cancel))?)?$/);
      if (publication) {
        if (!activePublication) return json(response, 503, { error: 'W2_CUSTODY_EXTENSION_REQUIRED' });
        const [, recordId, target, action] = publication;
        let record; try { record = JSON.parse(await readFile(resolve(root, 'workloads', 'records', `${recordId}.json`), 'utf8')); }
        catch { return json(response, 404, { error: 'RECORD_NOT_FOUND' }); }
        if (request.method === 'POST' && target === 'prepare') return json(response, 201, await activePublication.prepare(record, await readBody(request)));
        if (/^w2op1-[0-9a-f]{64}$/.test(target ?? '')) {
          const bound = await activePublication.inspect(target);
          if (bound.recordId !== recordId) return json(response, 404, { error: 'PUBLICATION_RECORD_MISMATCH' });
          if (request.method === 'GET' && !action) return json(response, 200, await activePublication.inspect(target));
          if (request.method === 'POST' && action === 'sign') return json(response, 200, await activePublication.approveAndSign(target));
          if (request.method === 'POST' && action === 'submit') return json(response, 200, await activePublication.submitOnce(target));
          if (request.method === 'POST' && action === 'observe') return json(response, 200, await activePublication.observe(target));
          if (request.method === 'POST' && action === 'cancel') return json(response, 200, await activePublication.cancel(target));
        }
        return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      }
      const workload = url.pathname.match(/^\/workloads\/(w1-[0-9a-f]{32})(?:\/(validate|record))?$/);
      if (workload) {
        const [, importId, action] = workload;
        if (request.method === 'GET' && !action) { const item = imports.get(importId); return item ? json(response, 200, { importId, ...item.descriptor }) : json(response, 404, { error: 'IMPORT_EXPIRED' }); }
        if (request.method === 'POST' && action === 'validate') {
          const item = imports.get(importId); if (!item) return json(response, 404, { error: 'IMPORT_EXPIRED' });
          const result = await validateTranscript(item.bytes, { room: item.room, generation: item.generation });
          imports.delete(importId); // raw bytes are never persisted, including after verifier failure
          if (result.category !== 'VALIDATION_RESULT') return json(response, result.category === 'INPUT_REJECTED' ? 400 : 500, result);
          const record = { schema: 'tclk-blackbox/local-validation-flight-record/v1', executionType: 'LOCAL_VALIDATION', recordId: importId,
            readOnly: true, artifact: result.artifact, publication: 'NONE', transportStates: [] };
          await mkdir(resolve(root, 'workloads', 'records'), { recursive: true, mode: 0o700 });
          await writeFile(resolve(root, 'workloads', 'records', `${importId}.json`), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
          return json(response, 200, { recordId: importId, verdict: result.verdict, artifact: result.artifact, flightRecordRoute: `/deal/record/${importId}` });
        }
        if (request.method === 'GET' && action === 'record') {
          let record; try { record = JSON.parse(await readFile(resolve(root, 'workloads', 'records', `${importId}.json`), 'utf8')); }
          catch { return json(response, 404, { error: 'RECORD_NOT_FOUND' }); }
          let publicationEvidence = null;
          const operationId = url.searchParams.get('publication');
          if (operationId && activePublication) {
            const state = await activePublication.inspect(operationId);
            if (state.recordId !== importId) return json(response, 404, { error: 'PUBLICATION_RECORD_MISMATCH' });
            publicationEvidence = publicSafePublication(state);
          }
          return json(response, 200, { source: 'LOCAL_BLACKBOX_CONNECTOR', readOnly: true, record, publicationEnabled: Boolean(activePublication), publicationEvidence });
        }
        return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      }
      if (request.method === 'GET' && url.pathname === '/session') return json(response, 200, { status: 'CONNECTED',
        sessionId: pairing.record.sessionId, expiresAt: pairing.record.expiresAt, mode: mode === 'simulated' ? 'SIMULATED / LOCAL TEST' : 'LOCAL REAL EXECUTION' });
      if (request.method === 'GET' && url.pathname === '/identity') return json(response, 200, await identities.discover());
      if (request.method === 'POST' && url.pathname === '/identity/primary') { const body = await readBody(request); return json(response, 200, await identities.selectPrimary(body.did)); }
      if (request.method === 'POST' && url.pathname === '/identity/link') return json(response, 200, await identities.linkExisting());
      if (request.method === 'GET' && url.pathname === '/identity/activity') return json(response, 200, await identities.activity());
      if (request.method === 'POST' && url.pathname === '/identity/verify') { const body = await readBody(request); return json(response, 200, { valid: verifyPublicSignature(body), proofScope: 'CRYPTOGRAPHIC_KEY_CONTROL_ONLY' }); }
      if (request.method === 'GET' && url.pathname === '/profiles') return json(response, 200, {
        operatorModel: mode === 'simulated' ? 'LOCAL_SELF_TEST_ONE_OPERATOR_TWO_DISTINCT_DIDS' : 'EXISTING_TECHNOCORE_SIGNER_REQUIRED', identity: await identities.discover(), profiles: await identities.dealProfiles({ allowFixtureProfiles: mode === 'simulated' }),
      });
      if (request.method === 'GET' && url.pathname === '/deals') return json(response, 200, { deals: await listSessions({ root }) });
      if (request.method === 'POST' && url.pathname === '/deals') {
        const identity = await identities.discover();
        if (mode !== 'simulated' && (identity.status !== 'IDENTITY_READY' || !identity.primaryDid)) throw new Error('SIGNER_READY_IDENTITY_REQUIRED');
        const body = await readBody(request); const deal = await createDealSession({ amount: body.amount, asset: body.asset,
          profileA: body.profileA, profileB: body.profileB, mode }, { root, now, profiles: await identities.dealProfiles({ allowFixtureProfiles: mode === 'simulated' }) }); return json(response, 201, deal);
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
    } catch (error) {
      if (url.pathname.startsWith('/workloads/')) return error.category === 'INPUT_REJECTED'
        ? json(response, error.status ?? 400, { category: error.category, code: error.code })
        : json(response, 500, { category: 'INTERNAL_ERROR', code: 'UNEXPECTED_VERIFIER_FAILURE' });
      return json(response, error.status ?? 409, { error: error.message });
    }
  }
  return Object.freeze({ handler, pairing, engine, host: CONNECTOR_HOST, port,
    createServer: () => createServer(handler) });
}

function json(response, status, value) {
  const body = JSON.stringify(value); response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body);
}

export function connectorStartupMessages(connector, mode, port) {
  return Object.freeze([
    `BLACKBOX connector ready on http://${CONNECTOR_HOST}:${port}`,
    `Mode: ${mode === 'simulated' ? 'SIMULATED / LOCAL TEST (NO LIVE ACTIONS)' : 'LOCAL REAL EXECUTION'}`,
    `Pairing file: ${connector.pairing.path}`,
    `Pairing expires: ${connector.pairing.record.expiresAt}`,
    'Import that file in BLACKBOX. Pairing tokens and custody secrets are never printed.',
  ]);
}

async function main() {
  const port = Number.parseInt(process.env.BLACKBOX_CONNECTOR_PORT ?? String(CONNECTOR_PORT), 10);
  const origins = process.env.BLACKBOX_WEB_ORIGIN === undefined ? DEFAULT_ALLOWED_ORIGINS
    : process.env.BLACKBOX_WEB_ORIGIN.split(',').map(item => item.trim()).filter(Boolean);
  const mode = process.argv.includes('--simulated') || process.env.BLACKBOX_CONNECTOR_MODE === 'simulated' ? 'simulated' : 'real';
  const connector = await createConnector({ port, origins, mode }); const server = connector.createServer();
  server.listen(port, CONNECTOR_HOST, () => {
    for (const line of connectorStartupMessages(connector, mode, port)) process.stdout.write(`${line}\n`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });

export const pairingFingerprint = record => sha256(`${record.sessionId}|${record.connectorUrl}|${record.expiresAt}`);
