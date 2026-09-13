import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConnector, CONNECTOR_HOST } from '../../blackbox/hub/connector.mjs';
import { didKeyFromPublicKey } from '../../blackbox/airlock/signer.mjs';
import { buildWeb } from '../build.mjs';

const localOrigin = 'http://127.0.0.1:0'; const production = 'https://tclk-blackbox.vercel.app';
const room = 'w1-fixture'; const text = 'FIXTURE_ONLY_PRIVATE_TRANSCRIPT_MARKER';
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 31)]), format: 'der', type: 'pkcs8' });
const did = didKeyFromPublicKey(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
const sig = sign(null, Buffer.from(`${room}|1|${text}`), key).toString('base64url');
const transcript = Buffer.from(`${JSON.stringify({ seq: 1, ts: '2026-09-13T12:00:00.000000Z', from: did, text, nonce: 1, sig })}\n`);

test('localhost import owns raw bytes; production receives only safe descriptor, result and LOCAL_VALIDATION record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-w1-flow-')); let posts = 0;
  const connector = await createConnector({ root, port: 0, origins: [production], transport: async () => { posts += 1; throw new Error('LIVE_WRITE_FORBIDDEN'); } });
  const server = connector.createServer(); await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
  const base = `http://${CONNECTOR_HOST}:${server.address().port}`; const authorization = `Bearer ${connector.pairing.record.token}`;
  const call = (path, options = {}) => fetch(`${base}${path}`, options);
  try {
    const page = await (await call('/workloads/import')).text();
    assert.match(page, /127\.0\.0\.1|localhost connector/); assert.match(page, /type="file"/);
    assert.doesNotMatch(page, /pairing\.record\.token|privateKey/);
    const denied = await call('/workloads/import', { method: 'POST', headers: { origin: production, Authorization: authorization }, body: transcript });
    assert.equal(denied.status, 403);
    const unauthorized = await call('/workloads/import', { method: 'POST', headers: { origin: localOrigin }, body: transcript });
    assert.equal(unauthorized.status, 401);
    const imported = await call('/workloads/import', { method: 'POST', headers: { origin: localOrigin, Authorization: authorization,
      'Content-Type': 'application/x-ndjson', 'X-Blackbox-Room': room, 'X-Room-Generation': '1' }, body: transcript });
    assert.equal(imported.status, 201); const descriptor = await imported.json();
    assert.match(descriptor.importId, /^w1-[0-9a-f]{32}$/); assert.equal(descriptor.roomDisplay, 'REDACTED');
    assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(`${text}|${room}|${connector.pairing.record.token}|blackbox-w1-flow-`));
    const seen = await (await call(`/workloads/${descriptor.importId}`, { headers: { origin: production, Authorization: authorization } })).json();
    assert.equal(seen.sha256, descriptor.sha256); assert.doesNotMatch(JSON.stringify(seen), new RegExp(`${text}|${room}`));
    const validated = await call(`/workloads/${descriptor.importId}/validate`, { method: 'POST', headers: { origin: production, Authorization: authorization } });
    assert.equal(validated.status, 200); const result = await validated.json(); assert.equal(result.verdict, 'VALID');
    assert.equal(result.artifact.input.roomDisplay, 'REDACTED'); assert.equal(result.artifact.summary.signedVerified, 1);
    const publicSafe = JSON.stringify(result); assert.doesNotMatch(publicSafe, new RegExp(`${text}|${room}|${connector.pairing.record.token}|blackbox-w1-flow-|"sig"`));
    const record = await (await call(`/workloads/${descriptor.importId}/record`, { headers: { origin: production, Authorization: authorization } })).json();
    assert.equal(record.record.executionType, 'LOCAL_VALIDATION'); assert.deepEqual(record.record.transportStates, []);
    assert.equal(record.record.publication, 'NONE'); assert.equal(record.record.artifact.workloadId, descriptor.workloadId);
    assert.doesNotMatch(JSON.stringify(record), /"SIGNED"|"SUBMITTED"|"ACK_RECEIVED"|"OBSERVED_PUBLIC"/);
    assert.doesNotMatch(await readFile(join(root, 'workloads', 'records', `${descriptor.importId}.json`), 'utf8'), new RegExp(`${text}|${room}`));
    assert.equal((await call(`/workloads/${descriptor.importId}`, { headers: { origin: production, Authorization: authorization } })).status, 404);
    assert.equal(posts, 0);
    const output = join(root, 'dist'); await buildWeb({ outDir: output });
    const [html, app, w1] = await Promise.all([readFile(join(output, 'technocore', 'index.html'), 'utf8'), readFile(join(output, 'assets', 'app.js'), 'utf8'), readFile(join(output, 'assets', 'workload-record.js'), 'utf8')]);
    assert.match(html, /Import transcript locally/); assert.doesNotMatch(html, /type="file"/);
    assert.match(app, /workload-record\.js/); assert.match(w1, /LOCAL_VALIDATION/);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('imports expire, cap at four, and raw bytes do not survive connector restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-w1-lifetime-')); let tick = Date.now();
  const connector = await createConnector({ root, port: 0, now: () => tick, origins: [production] });
  const server = connector.createServer(); await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
  const base = `http://${CONNECTOR_HOST}:${server.address().port}`; const headers = { origin: localOrigin, Authorization: `Bearer ${connector.pairing.record.token}`,
    'Content-Type': 'application/x-ndjson', 'X-Blackbox-Room': room };
  try {
    const ids = [];
    for (let i = 0; i < 4; i += 1) { const response = await fetch(`${base}/workloads/import`, { method: 'POST', headers, body: transcript }); assert.equal(response.status, 201); ids.push((await response.json()).importId); }
    assert.equal((await fetch(`${base}/workloads/import`, { method: 'POST', headers, body: transcript })).status, 429);
    tick += 11 * 60 * 1000;
    assert.equal((await fetch(`${base}/workloads/${ids[0]}`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/workloads/import`, { method: 'POST', headers, body: transcript })).status, 201);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const restarted = await createConnector({ root, port: 0, origins: [production] }); const next = restarted.createServer();
  await new Promise(resolve => next.listen(0, CONNECTOR_HOST, resolve));
  try { assert.equal((await fetch(`http://${CONNECTOR_HOST}:${next.address().port}/workloads/${'w1-' + '0'.repeat(32)}`, { headers: { origin: production, Authorization: `Bearer ${restarted.pairing.record.token}` } })).status, 404); }
  finally { await new Promise(resolve => next.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('local validation replaces inherited historical footer while the reference retains its copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-w1-footer-'));
  try {
    await buildWeb({ outDir: root });
    const [recordPage, referencePage, source] = await Promise.all([
      readFile(join(root, 'deal', 'record', 'index.html'), 'utf8'),
      readFile(join(root, 'deal', 'phase3b-final', 'index.html'), 'utf8'),
      readFile(join(root, 'assets', 'workload-record.js'), 'utf8'),
    ]);
    assert.match(referencePage, /Agent Deal Flight Recorder · Verified public playback/);
    assert.match(referencePage, /id="footer-record-id">phase3b-final/);
    assert.match(recordPage, /Agent Deal Flight Recorder · Verified public playback/); // shared HTML before W1 rendering

    const node = (textContent = '') => ({ textContent, children: [], append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }, remove() {} });
    const footerText = node('Agent Deal Flight Recorder · Verified public playback');
    const footerId = node('phase3b-final'); const main = node();
    const document = { title: '', createElement: () => node(), getElementById: name => name === 'footer-record-id' ? footerId : null,
      querySelector: selector => ({ main, 'footer .section-shell > p': footerText, dialog: node() })[selector] ?? null };
    const recordId = `w1-${'a'.repeat(32)}`;
    const artifact = { schema: 'blackbox/workload-evidence/v1', workloadType: 'technocore-transcript-validation/v1', verdict: 'VALID',
      coverage: { windowStatus: 'BOUNDED', generation: { status: 'KNOWN' } }, input: { sha256: 'b'.repeat(64), byteLength: 240 },
      summary: { signedVerified: 1, unsignedContext: 0 }, verifier: { id: 'technocore-transcript-validation/v1', implementationDigest: 'sha256:test' },
      workloadId: 'c'.repeat(64), checks: [], limitations: [] };
    const connectorRequest = async path => { assert.equal(path, `/workloads/${recordId}/record`);
      return { record: { executionType: 'LOCAL_VALIDATION', transportStates: [], artifact } }; };
    const stripped = source.replace(/^import \{ connectorRequest \} from '\.\/connector-client\.js';\r?\n/, '');
    assert.notEqual(stripped, source);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('document', 'location', 'connectorRequest', 'URL', 'Blob', stripped)(document,
      { pathname: `/deal/record/${recordId}` }, connectorRequest, { createObjectURL: () => 'blob:local-test' }, Blob);
    assert.equal(main.children.length, 5); // complete LOCAL_VALIDATION presentation, not the unavailable fallback
    assert.equal(footerText.textContent, 'TCLK BLACKBOX · Local validation evidence');
    assert.equal(footerId.textContent, recordId);
    assert.doesNotMatch(`${footerText.textContent} ${footerId.textContent}`, /Verified public playback|phase3b-final/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
