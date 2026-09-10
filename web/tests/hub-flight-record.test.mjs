import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConnector, CONNECTOR_HOST } from '../../blackbox/hub/connector.mjs';
import { readCompletedPublicRecord } from '../../blackbox/hub/session.mjs';
import { buildWeb } from '../build.mjs';
import { cachePublicRecord, cachedPublicRecord, publicRecordRoute } from '../connector-client.js';
import { createHubFlightRecorderModel } from '../public-capsule-adapter.js';

const sessionId = 'bbx-635349500140b77a';
const steps = ['OFFER', 'ACCEPT', 'LOCK', 'RAIL_LOCK', 'REVEAL', 'RAIL_CLAIM'];
const didA = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';
const didB = 'did:key:z6MkoetPhd5Aa1pKFCR2a8SinCWaL64U7ytcPP6zg5pnnDoW';
const referencePath = new URL('../../evidence/public/phase3b-final-public-capsule.json', import.meta.url);

function publicCapsule() {
  return {
    schema: 'tclk-blackbox/public-deal-capsule/v1', simulated: false, sessionId, manifestRoot: 'a'.repeat(64),
    venueOrigin: 'https://technocore-chat-production.up.railway.app', complete: true,
    deal: { amount: '25', asset: 'TCLK', contractId: `0x${'b'.repeat(64)}`, dealRoom: 'mb-p-tclk-test',
      paperRail: { namespace: 'tclk-paper-test', key: 'record', valueMoved: false } },
    operatorModel: 'ONE_HUMAN_OPERATOR_TWO_DISTINCT_CRYPTOGRAPHIC_DIDS',
    operations: steps.map((step, index) => ({ operationId: `${sessionId}-write-${index + 1}`, step, state: 'COMPLETE',
      evidence: step.startsWith('RAIL_') ? { classification: 'OBSERVED_PUBLIC', receiptSha256: 'c'.repeat(64), expectedValueSha256: 'd'.repeat(64),
        observedValueSha256: 'd'.repeat(64), exactValueMatch: true, writtenAt: '2026-09-10T21:17:10.465Z', observedAt: '2026-09-10T21:17:17.712Z', signed: false, worldWritable: true, valueMoved: false }
        : { classification: 'OBSERVED_PUBLIC', did: index === 1 || index === 4 ? didB : didA, signedNonce: index + 1,
          canonicalTextSha256: 'e'.repeat(64), exactMatchCount: 1, publicSeq: index + 1, publicTimestamp: '2026-09-10T21:15:02.505406Z', observationSource: 'https://technocore-chat-production.up.railway.app/r/test?format=json' } })),
    limitations: ['ONE HUMAN OPERATOR / TWO DISTINCT CRYPTOGRAPHIC DIDS', 'PaperRail is unsigned, world-writable, moves no value and is not a payment rail.'],
  };
}

test('completed Hub record handoff is session-bound, read-only and renders six public-safe events', async () => {
  const referenceBefore = await readFile(referencePath); const root = await mkdtemp(join(tmpdir(), 'hub-record-'));
  const capsule = publicCapsule(); const state = { id: sessionId, finalized: true, publicCapsule: capsule, operations: steps.map(step => ({ step, state: 'COMPLETE' })) };
  await mkdir(join(root, 'sessions', sessionId), { recursive: true });
  await writeFile(join(root, 'sessions', sessionId, 'session.json'), `${JSON.stringify(state)}\n`);
  try {
    assert.equal(publicRecordRoute(sessionId), `/deal/record/${sessionId}`);
    const browserStore = new Map(); globalThis.sessionStorage = { setItem: (key, value) => browserStore.set(key, value), getItem: key => browserStore.get(key) ?? null };
    cachePublicRecord(capsule); assert.equal(cachedPublicRecord(sessionId).sessionId, sessionId);
    const local = await readCompletedPublicRecord(sessionId, { root });
    assert.equal(local.readOnly, true); assert.equal(local.requiresLocalConnector, true); assert.equal(local.record.sessionId, sessionId);
    const model = createHubFlightRecorderModel(local.record, 'f'.repeat(64));
    assert.equal(model.sourceKind, 'HUB_CREATED_LOCAL_RECORD'); assert.equal(model.steps.length, 6);
    assert.deepEqual(model.steps.map(item => item.code), steps); assert.equal(model.summary.unresolvedSteps, 0);
    assert.doesNotMatch(JSON.stringify(local), /"(?:secret|preimage|privateKey|signerSecret|passphrase|seed|localPath)"/i);

    let liveCalls = 0; const connector = await createConnector({ root, origins: ['http://127.0.0.1:4173'], port: 0, transport: async () => { liveCalls += 1; throw new Error('LIVE_CALL_REFUSED'); } });
    const server = connector.createServer(); await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
    try {
      const base = `http://${CONNECTOR_HOST}:${server.address().port}`;
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`${base}/records/${sessionId}`, { headers: { origin: 'http://127.0.0.1:4173' } });
        assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.record.sessionId, sessionId); assert.equal(body.readOnly, true);
      }
      assert.equal(liveCalls, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }

    const output = join(root, 'dist'); await buildWeb({ outDir: output });
    const [dynamicHtml, app, hubApp] = await Promise.all([readFile(join(output, 'deal', 'record', 'index.html'), 'utf8'), readFile(join(output, 'assets', 'app.js'), 'utf8'), readFile(join(output, 'assets', 'hub-app.js'), 'utf8')]);
    assert.match(dynamicHtml, /id="timeline"/); assert.match(app, /createHubFlightRecorderModel/); assert.match(app, /publicRecordRequest\(dynamicSessionId\)/);
    assert.match(hubApp, /open-record.*publicRecordRoute/s); assert.match(hubApp, /location\.assign\(recordRoute\)/);
    assert.match(hubApp, /Flight record finalized\. No local approval pending\./);
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(await readFile(referencePath), referenceBefore);
});

test('non-finalized local sessions cannot be exposed as flight records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-record-incomplete-')); await mkdir(join(root, 'sessions', sessionId), { recursive: true });
  await writeFile(join(root, 'sessions', sessionId, 'session.json'), JSON.stringify({ id: sessionId, finalized: false, operations: [] }));
  try { await assert.rejects(() => readCompletedPublicRecord(sessionId, { root }), /FLIGHT_RECORD_NOT_FINALIZED/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
