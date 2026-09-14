import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { didKeyFromPublicKey } from '../airlock/signer.mjs';
import { CONNECTOR_HOST, createConnector } from '../hub/connector.mjs';
import { signaturePreimage } from '../workloads/validation-publication/canonical.mjs';
import { W2TrustedCustody } from '../workloads/validation-publication/custody-bridge.mjs';
import { W2PublicationService } from '../workloads/validation-publication/service.mjs';
import { DurableW2Store } from '../workloads/validation-publication/store.mjs';

const testKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 71)]), format: 'der', type: 'pkcs8' });
const signerDid = didKeyFromPublicKey(createPublicKey(testKey).export({ format: 'der', type: 'spki' }).subarray(-32));
const room = 'w2-terminal-retry';
const venueOrigin = 'https://technocore.chat';
const artifact = Object.freeze({
  schema: 'blackbox/workload-evidence/v1', workloadType: 'technocore-transcript-validation/v1', workloadVersion: 'v1', workloadId: 'a'.repeat(64),
  input: { provenance: 'USER_SUPPLIED_EXPORT_BYTES', roomDisplay: 'REDACTED', mediaType: 'application/x-ndjson', encoding: 'utf-8', sha256: 'b'.repeat(64), byteLength: 10, recordCount: 1, lineEnding: 'LF' },
  verifier: { id: 'technocore-transcript-validation/v1', checkProfile: 'tc-export-signed-rows/v1', implementationVersion: '1.0.0', implementationDigest: `sha256:${'c'.repeat(64)}`, technocoreRef: 'd'.repeat(40) },
  verdict: 'VALID', coverage: { scope: 'SUPPLIED_WINDOW_ONLY', historyCompleteness: 'NOT_PROVEN', generation: { status: 'KNOWN', value: '1', source: 'SUPPLIED_HEADER' }, sequenceStatus: 'CONTIGUOUS_WITHIN_SUPPLIED_ROWS', windowStatus: 'BOUNDED', firstSeq: '1', lastSeq: '1', gapCount: 0 },
  checks: [], summary: { signedVerified: 1, unsignedContext: 0, legacyUnverifiable: 0, duplicateOperations: 0 }, limitations: ['BOUNDED_HISTORY_ONLY'],
});
const record = Object.freeze({ schema: 'tclk-blackbox/local-validation-flight-record/v1', executionType: 'LOCAL_VALIDATION', recordId: `w1-${'e'.repeat(32)}`, readOnly: true, artifact, publication: 'NONE', transportStates: [] });

async function retryHarness() {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-w2-terminal-'));
  const store = new DurableW2Store(root);
  const current = new Map(); const history = new Map();
  const counts = { reserveCalls: 0, allocations: 0, cancel: 0, sign: 0, post: 0 };
  let counter = 0n; let tick = Date.parse('2026-09-14T10:00:00.000Z');
  const custody = {
    async reserve(input) {
      counts.reserveCalls += 1;
      const prior = current.get(input.requestId);
      if (prior && prior.state !== 'BURNED') return structuredClone(prior);
      const priorHistory = history.get(input.requestId) ?? [];
      if (prior) priorHistory.push(structuredClone(prior));
      history.set(input.requestId, priorHistory);
      counter += 1n; counts.allocations += 1;
      const next = { ...input, nonce: counter.toString(), state: 'RESERVED', generation: priorHistory.length + 1,
        createdAt: new Date(tick).toISOString() };
      current.set(input.requestId, next);
      return structuredClone(next);
    },
    async cancelReserved(input) {
      counts.cancel += 1;
      const active = current.get(input.requestId);
      if (!active || active.state === 'BURNED' || active.nonce !== input.nonce) throw new Error('STALE_W2_RESERVATION');
      current.set(input.requestId, { ...active, state: 'BURNED', operationId: input.operationId, auditEvent: 'CANCELED_BEFORE_SIGNING' });
      return { state: 'BURNED', operationId: input.operationId, signerDid: input.signerDid, nonce: input.nonce, auditEvent: 'CANCELED_BEFORE_SIGNING' };
    },
    async signReserved(input) {
      counts.sign += 1;
      const active = current.get(input.requestId);
      if (!active || active.state !== 'RESERVED' || active.nonce !== input.nonce) throw new Error('STALE_W2_RESERVATION');
      return { did: input.signerDid, room: input.room, nonce: input.nonce, text: input.signedText,
        signature: sign(null, Buffer.from(signaturePreimage(input.room, input.nonce, input.signedText)), testKey).toString('base64url') };
    },
  };
  const service = new W2PublicationService({ store, custody, now: () => tick, readW1Record: async () => record,
    signApproval: async ({ expectedPhrase }) => expectedPhrase, submitApproval: async ({ expectedPhrase }) => expectedPhrase,
    transport: { async post() { counts.post += 1; throw new Error('TEST_POST_DISABLED'); } }, observerFetch: async () => { throw new Error('TEST_OBSERVE_DISABLED'); } });
  return { root, store, service, custody, counts, current, history, advance: ms => { tick += ms; } };
}

const prepare = harness => harness.service.prepare(record, { venueOrigin, room, signerDid });

test('explicit prepare after cancellation advances generation while active duplicate prepare remains idempotent', async () => {
  const h = await retryHarness();
  try {
    const first = await prepare(h);
    const duplicate = await prepare(h);
    assert.equal(first.nonce, '1'); assert.equal(first.reservation.generation, 1);
    assert.equal(duplicate.operationId, first.operationId); assert.equal(h.counts.allocations, 1);

    await h.service.cancel(first.operationId);
    const second = await prepare(h);
    assert.equal(second.nonce, '2'); assert.equal(second.reservation.generation, 2);
    assert.equal(second.reservation.requestId, first.reservation.requestId);
    assert.notEqual(second.operationId, first.operationId);
    assert.equal((await h.store.read(first.operationId)).state, 'CANCELLED_NONCE_BURNED');
    assert.equal(h.history.get(first.reservation.requestId)[0].nonce, '1');
    assert.equal(h.history.get(first.reservation.requestId)[0].state, 'BURNED');

    const secondDuplicate = await prepare(h);
    assert.equal(secondDuplicate.operationId, second.operationId); assert.equal(h.counts.allocations, 2);
    await assert.rejects(() => h.custody.signReserved({ requestId: first.reservation.requestId, nonce: '1' }), /STALE_W2_RESERVATION/);
    const signed = await h.service.approveAndSign(second.operationId);
    assert.equal(signed.state, 'SIGNED'); assert.equal(signed.nonce, '2');
    assert.equal(h.counts.sign, 2); assert.equal(h.counts.post, 0);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('expired approval burns its generation and an explicit prepare receives the next nonce without signing or posting', async () => {
  const h = await retryHarness();
  try {
    const first = await prepare(h); h.advance(16 * 60 * 1000);
    const expired = await h.service.approveAndSign(first.operationId);
    assert.equal(expired.state, 'CANCELLED_NONCE_BURNED'); assert.equal(expired.signApproval.status, 'EXPIRED');
    const second = await prepare(h);
    assert.equal(second.nonce, '2'); assert.equal(second.reservation.generation, 2);
    assert.equal(h.counts.allocations, 2); assert.equal(h.counts.sign, 0); assert.equal(h.counts.post, 0);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('trusted custody normalizes the reviewed signer reservation timestamp before durable canonical storage', async () => {
  const custody = new W2TrustedCustody({ identities: { async existingSignerProfile() { return { name: 'fixture' }; } } });
  custody.invoke = async frame => ({ schema: 'technocore-w2-reservation/v1', custodyMode: 'real', canonicalCommit: 'fixture',
    requestId: frame.requestId, signerDid, room, venueOrigin, nonce: '2', state: 'RESERVED', generation: 2, createdAt: 1789372800.125 });
  const value = await custody.reserve({ requestId: `w2draft1-${'f'.repeat(64)}`, room, signerDid, venueOrigin, signedTextSha256: `sha256:${'1'.repeat(64)}` });
  assert.equal(value.generation, 2); assert.equal(value.createdAt, '2026-09-14T08:00:00.125Z');
});

async function connectorHarness(publicationService) {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-w2-errors-'));
  const records = join(root, 'workloads', 'records'); await mkdir(records, { recursive: true });
  await writeFile(join(records, `${record.recordId}.json`), JSON.stringify(record));
  const connector = await createConnector({ root, port: 0, mode: 'simulated', publicationService });
  const server = connector.createServer(); await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
  return { root, connector, server, endpoint: `http://${CONNECTOR_HOST}:${server.address().port}`,
    headers: { origin: 'http://127.0.0.1:4173', authorization: `Bearer ${connector.pairing.record.token}`, 'content-type': 'application/json' } };
}

test('W2 publication errors use a truthful bounded category and never leak custody diagnostics', async () => {
  const h = await connectorHarness({ async prepare() { throw new Error('private path seed passphrase stack'); } });
  try {
    const response = await fetch(`${h.endpoint}/workloads/${record.recordId}/publication/prepare`, { method: 'POST', headers: h.headers, body: '{}' });
    assert.equal(response.status, 409);
    const body = await response.json(); assert.deepEqual(body, { category: 'W2_PUBLICATION_ERROR', code: 'W2_PREPARATION_REFUSED' });
    assert.doesNotMatch(JSON.stringify(body), /UNEXPECTED_VERIFIER_FAILURE|private|seed|passphrase|stack/i);
  } finally { await new Promise(resolve => h.server.close(resolve)); await rm(h.root, { recursive: true, force: true }); }
});

test('W1 input failures retain their existing safe verifier classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-w1-errors-'));
  const connector = await createConnector({ root, port: 0, mode: 'simulated', publicationService: {} });
  const server = connector.createServer(); await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
  try {
    const endpoint = `http://${CONNECTOR_HOST}:${server.address().port}/workloads/import`;
    const response = await fetch(endpoint, { method: 'POST', headers: { origin: 'http://127.0.0.1:0', authorization: `Bearer ${connector.pairing.record.token}`,
      'content-type': 'application/x-ndjson', 'x-blackbox-room': 'Invalid Room' }, body: '{}\n' });
    assert.equal(response.status, 400);
    const body = await response.json(); assert.equal(body.category, 'INPUT_REJECTED'); assert.equal(body.code, 'UNSUPPORTED_INPUT_ENVELOPE');
    assert.notEqual(body.category, 'W2_PUBLICATION_ERROR');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
