import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { didKeyFromPublicKey } from '../airlock/signer.mjs';
import { CONNECTOR_HOST, createConnector } from '../hub/connector.mjs';
import { ASSERTION_PREFIX, artifactCommitment, buildAssertion, canonicalJson, operationIdentity, parseAssertionText, requireNonce, signaturePreimage } from '../workloads/validation-publication/canonical.mjs';
import { observeExport } from '../workloads/validation-publication/observer.mjs';
import { W2PublicationService, publicSafePublication } from '../workloads/validation-publication/service.mjs';
import { DurableW2Store } from '../workloads/validation-publication/store.mjs';
import { createW2VenueAdapters } from '../workloads/validation-publication/production.mjs';
import { assertReviewedW2Signer, REVIEWED_W2_SIGNER_COMMIT } from '../workloads/validation-publication/custody-bridge.mjs';

const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 44)]), format: 'der', type: 'pkcs8' });
const did = didKeyFromPublicKey(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
const room = 'w2-fixture'; const venueOrigin = 'https://technocore.chat';
const artifact = Object.freeze({ schema: 'blackbox/workload-evidence/v1', workloadType: 'technocore-transcript-validation/v1', workloadVersion: 'v1', workloadId: 'a'.repeat(64),
  input: { provenance: 'USER_SUPPLIED_EXPORT_BYTES', roomDisplay: 'REDACTED', mediaType: 'application/x-ndjson', encoding: 'utf-8', sha256: 'b'.repeat(64), byteLength: 10, recordCount: 1, lineEnding: 'LF' },
  verifier: { id: 'technocore-transcript-validation/v1', checkProfile: 'tc-export-signed-rows/v1', implementationVersion: '1.0.0', implementationDigest: `sha256:${'c'.repeat(64)}`, technocoreRef: 'd'.repeat(40) },
  verdict: 'VALID', coverage: { scope: 'SUPPLIED_WINDOW_ONLY', historyCompleteness: 'NOT_PROVEN', generation: { status: 'KNOWN', value: '1', source: 'SUPPLIED_HEADER' }, sequenceStatus: 'CONTIGUOUS_WITHIN_SUPPLIED_ROWS', windowStatus: 'BOUNDED', firstSeq: '1', lastSeq: '1', gapCount: 0 },
  checks: [], summary: { signedVerified: 1, unsignedContext: 0, legacyUnverifiable: 0, duplicateOperations: 0 }, limitations: ['BOUNDED_HISTORY_ONLY'] });
const record = Object.freeze({ schema: 'tclk-blackbox/local-validation-flight-record/v1', executionType: 'LOCAL_VALIDATION', recordId: `w1-${'e'.repeat(32)}`, readOnly: true, artifact, publication: 'NONE', transportStates: [] });

async function harness({ floor = '0', transportResult, mutateSignCandidate, mutateSubmitCandidate, venue,
  signerResult,
  tick = Date.parse('2026-09-14T10:00:00.000Z') } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-w2-')); const store = new DurableW2Store(root); const counts = { reserve: 0, sign: 0, cancel: 0, post: 0, observe: 0 };
  const custody = { async reserve({ requestId, room: laneRoom, signerDid, venueOrigin: targetVenue }) { counts.reserve += 1; const reservation = await store.reserveNonce({ requestId, lane: `${signerDid}::${laneRoom}`, floor }); return { ...reservation, room: laneRoom, signerDid, venueOrigin: targetVenue, state: 'RESERVED' }; },
    async cancelReserved(input) { counts.cancel += 1; return { state: 'BURNED', auditEvent: 'CANCELED_BEFORE_SIGNING', operationId: input.operationId, signerDid: input.signerDid, nonce: input.nonce }; },
    async signReserved(input) { counts.sign += 1; const exact = { did: input.signerDid, room: input.room, nonce: input.nonce, text: input.signedText, signature: sign(null, Buffer.from(signaturePreimage(input.room, input.nonce, input.signedText)), key).toString('base64url') };
      return typeof signerResult === 'function' ? signerResult(exact) : exact; } };
  let exportBytes = Buffer.alloc(0); let currentRecord = record;
  const makeService = durableStore => new W2PublicationService({ store: durableStore, custody, now: () => tick, submitBudgetRoot: join(root, 'w2-submit-budget'),
    readW1Record: async () => currentRecord,
    signApproval: async ({ candidate, expectedPhrase }) => { if (mutateSignCandidate) mutateSignCandidate(candidate); return expectedPhrase; },
    submitApproval: async ({ candidate, expectedPhrase }) => { if (mutateSubmitCandidate) mutateSubmitCandidate(candidate); return expectedPhrase; },
    transport: { async post(input) { counts.post += 1; return venue ? venue.transport.post(input) : typeof transportResult === 'function' ? transportResult(input) : transportResult ?? { kind: 'TIMEOUT' }; } },
    observerFetch: async input => { counts.observe += 1; return venue ? venue.observerFetch(input) : { origin: venueOrigin, generation: '9', bytes: exportBytes }; } });
  const service = makeService(store);
  return { root, store, service, counts, setExport: bytes => { exportBytes = bytes; },
    setW1Record: value => { currentRecord = value; }, advance: ms => { tick += ms; },
    restart: () => makeService(new DurableW2Store(root)) };
}

async function prepared(h, overrides = {}) { return h.service.prepare(record, { venueOrigin, room, signerDid: did, ...overrides }); }
async function signed(h, overrides = {}) { const draft = await prepared(h, overrides); return h.service.approveAndSign(draft.operationId); }
const exportLine = (operation, seq = '1', changes = {}) => {
  const row = { seq, ts: '2026-09-14T10:01:00.000000Z', from: operation.signerDid, text: operation.signedText, nonce: operation.nonce, sig: operation.signature, ...changes };
  return Buffer.from(`${JSON.stringify(row).replace(`"seq":"${row.seq}"`, `"seq":${row.seq}`).replace(`"nonce":"${row.nonce}"`, `"nonce":${row.nonce}`)}\n`);
};

test('W2 canonical assertion is closed, deterministic, ASCII and does not contain room or transcript', () => {
  const a = buildAssertion(artifact, venueOrigin); const b = buildAssertion({ ...artifact, input: { ...artifact.input } }, venueOrigin);
  assert.equal(a.signedText, b.signedText); assert.ok(a.signedText.startsWith(ASSERTION_PREFIX)); assert.deepEqual(parseAssertionText(a.signedText), a.assertion);
  assert.equal(a.assertion.evidenceArtifactSha256, artifactCommitment(artifact)); assert.doesNotMatch(a.signedText, new RegExp(`${room}|PRIVATE_TRANSCRIPT`));
  assert.throws(() => parseAssertionText(a.signedText.replace(/}$/, ',"extra":1}')), /ASSERTION/);
  assert.throws(() => canonicalJson({ value: 1.5 }), /CANONICAL_NUMBER_REFUSED/);
});

test('W2 production signer provenance accepts only the exact clean immutable pin', async () => {
  const clean = async () => ({ commit: REVIEWED_W2_SIGNER_COMMIT, status: '' });
  assert.equal(await assertReviewedW2Signer('fixture', REVIEWED_W2_SIGNER_COMMIT, clean), REVIEWED_W2_SIGNER_COMMIT);
  await assert.rejects(() => assertReviewedW2Signer('fixture', '', clean), /W2_REVIEWED_SIGNER_REQUIRED/);
  await assert.rejects(() => assertReviewedW2Signer('fixture', '0'.repeat(40), clean), /W2_REVIEWED_SIGNER_REQUIRED/);
  await assert.rejects(() => assertReviewedW2Signer('fixture', REVIEWED_W2_SIGNER_COMMIT,
    async () => ({ commit: REVIEWED_W2_SIGNER_COMMIT, status: ' M signer/service.py' })), /W2_REVIEWED_SIGNER_REQUIRED/);
});

test('W2 invalid setup is rejected before reserving any nonce', async () => {
  const h = await harness();
  try {
    for (const changes of [{ room: 'Invalid Room' }, { signerDid: 'did:key:invalid' }, { venueOrigin: 'http://technocore.chat' }]) {
      await assert.rejects(() => prepared(h, changes));
    }
    assert.equal(h.counts.reserve, 0);
    assert.equal(h.counts.sign, 0);
    assert.equal(h.counts.post, 0);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 nonce is lossless above 2^53, zero padding is refused, reservations survive restart and cancellation burns', async () => {
  const h = await harness({ floor: '9007199254740993' });
  try {
    assert.throws(() => requireNonce('007'), /NONCE_NOT_CANONICAL/); assert.throws(() => requireNonce('1e3'), /NONCE_NOT_CANONICAL/);
    const first = await prepared(h); assert.equal(first.nonce, '9007199254740994'); assert.equal(typeof first.nonce, 'string');
    const same = await prepared(h); assert.equal(same.operationId, first.operationId); assert.equal(same.nonce, first.nonce);
    await h.service.cancel(first.operationId);
    const second = await prepared(h, { venueOrigin: 'https://example.com' }); assert.equal(second.nonce, '9007199254740995');
    const restarted = new DurableW2Store(h.root); assert.equal((await restarted.read(first.operationId)).state, 'CANCELLED_NONCE_BURNED');
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 cancellation is bound, durable, idempotent, and never signs, posts, or replaces the nonce', async () => {
  const h = await harness();
  try {
    const op = await prepared(h); const first = await h.service.cancel(op.operationId);
    assert.equal(first.state, 'CANCELLED_NONCE_BURNED');
    assert.equal(first.events.at(-1).type, 'CANCELED_BEFORE_SIGNING');
    assert.equal((await new DurableW2Store(h.root).read(op.operationId)).state, 'CANCELLED_NONCE_BURNED');
    assert.deepEqual(await h.service.cancel(op.operationId), first);
    assert.deepEqual(h.counts, { reserve: 1, sign: 0, cancel: 1, post: 0, observe: 0 });
    await assert.rejects(() => h.service.approveAndSign(op.operationId), /SIGN_NOT_AVAILABLE/);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 cancellation refuses signed and submission-attempted operations', async () => {
  const h = await harness({ transportResult: input => ({ status: 200, posted: input.body }) });
  try {
    const op = await signed(h);
    await assert.rejects(() => h.service.cancel(op.operationId), /W2_CANCEL_AFTER_SIGNING_REFUSED/);
    await h.service.submitOnce(op.operationId);
    await assert.rejects(() => h.service.cancel(op.operationId), /W2_CANCEL_AFTER_SIGNING_REFUSED/);
    assert.equal(h.counts.cancel, 0);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 cancellation route requires pairing and exact W1 record ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-w2-route-'));
  const operations = { canceled: 0 };
  const publicationService = {
    async inspect() { return { recordId: record.recordId }; },
    async cancel() { operations.canceled += 1; return { state: 'CANCELLED_NONCE_BURNED' }; },
  };
  const records = join(root, 'workloads', 'records'); await mkdir(records, { recursive: true });
  await writeFile(join(records, `${record.recordId}.json`), JSON.stringify(record));
  const otherId = `w1-${'f'.repeat(32)}`;
  await writeFile(join(records, `${otherId}.json`), JSON.stringify({ ...record, recordId: otherId }));
  const connector = await createConnector({ root, port: 0, mode: 'simulated', publicationService });
  const server = connector.createServer(); await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
  try {
    const path = `/workloads/${record.recordId}/publication/w2op1-${'a'.repeat(64)}/cancel`;
    const endpoint = `http://${CONNECTOR_HOST}:${server.address().port}`;
    const origin = 'http://127.0.0.1:4173';
    const unauthorized = await fetch(endpoint + path, { method: 'POST', headers: { origin } });
    assert.equal(unauthorized.status, 401); assert.equal(operations.canceled, 0);
    const headers = { origin, authorization: `Bearer ${connector.pairing.record.token}` };
    const wrongRecord = await fetch(endpoint + path.replace(record.recordId, otherId), { method: 'POST', headers });
    assert.equal(wrongRecord.status, 404); assert.equal(operations.canceled, 0);
    const authorized = await fetch(endpoint + path, { method: 'POST', headers });
    assert.equal(authorized.status, 200); assert.equal(operations.canceled, 1);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('W2 approval exact-match signs once; payload room nonce signer venue and expiry changes fail closed', async t => {
  await t.test('APPROVAL_EXACT_MATCH and replay', async () => { const h = await harness(); try { const op = await signed(h); assert.equal(op.state, 'SIGNED'); assert.equal(h.counts.sign, 1); await assert.rejects(() => h.service.approveAndSign(op.operationId), /SIGN_NOT_AVAILABLE/); assert.equal(h.counts.sign, 1); } finally { await rm(h.root, { recursive: true, force: true }); } });
  for (const [name, mutate] of [['payload', c => { c.signedText += 'x'; }], ['room', c => { c.targetRoom = 'other'; }], ['nonce', c => { c.nonce = '7'; }], ['signer', c => { c.signerDid = c.signerDid.replace(/.$/, '1'); }], ['venue', c => { c.targetVenueOrigin = 'https://example.com'; }], ['operation id', c => { c.operationId = `w2op1-${'9'.repeat(64)}`; }], ['unknown field', c => { c.extra = 'refuse'; }]]) {
    await t.test(`APPROVAL_${name.toUpperCase()}_CHANGED`, async () => { const h = await harness({ mutateSignCandidate: mutate }); try { const op = await prepared(h); await assert.rejects(() => h.service.approveAndSign(op.operationId), /APPROVAL_INVALIDATED/); assert.equal(h.counts.sign, 0); } finally { await rm(h.root, { recursive: true, force: true }); } });
  }
  await t.test('APPROVAL_EXPIRED', async () => { const h = await harness(); try { const op = await prepared(h); h.advance(16 * 60 * 1000); const value = await h.service.approveAndSign(op.operationId); assert.equal(value.state, 'CANCELLED_NONCE_BURNED'); assert.equal(h.counts.sign, 0); } finally { await rm(h.root, { recursive: true, force: true }); } });
});

test('W2 operation id changes with every destination/signing binding', () => {
  const base = { evidenceArtifactSha256: `sha256:${'1'.repeat(64)}`, nonce: '1', room, signedTextSha256: `sha256:${'2'.repeat(64)}`, signerDid: did, venueOrigin };
  const id = operationIdentity(base).operationId;
  for (const change of [{ nonce: '2' }, { room: 'other' }, { venueOrigin: 'https://example.com' }, { signedTextSha256: `sha256:${'3'.repeat(64)}` }]) assert.notEqual(operationIdentity({ ...base, ...change }).operationId, id);
});

test('W2 signer failures and mismatched responses never become SIGNED or retry', async t => {
  for (const [name, signerResult, lastEvent] of [
    ['failure', () => { throw new Error('fixture failure'); }, 'SIGNING_OUTCOME_UNCERTAIN'],
    ['wrong text', value => ({ ...value, text: `${value.text}x` }), 'SIGNER_RESPONSE_MISMATCH'],
    ['wrong nonce', value => ({ ...value, nonce: '2' }), 'SIGNER_RESPONSE_MISMATCH'],
    ['wrong DID', value => ({ ...value, did: value.did.replace(/.$/, '1') }), 'SIGNER_RESPONSE_MISMATCH'],
    ['bad signature', value => ({ ...value, signature: value.signature.replace(/^./, value.signature[0] === 'A' ? 'B' : 'A') }), 'SIGNER_RESPONSE_INVALID'],
  ]) await t.test(name, async () => {
    const h = await harness({ signerResult });
    try {
      const draft = await prepared(h); const result = await h.service.approveAndSign(draft.operationId);
      assert.notEqual(result.state, 'SIGNED'); assert.equal(result.signBudget, 'SPENT');
      assert.equal(result.events.at(-1).type, lastEvent); assert.equal(h.counts.sign, 1); assert.equal(h.counts.post, 0);
      await assert.rejects(() => h.service.approveAndSign(draft.operationId), /SIGN_NOT_AVAILABLE/);
      assert.equal(h.counts.sign, 1);
    } finally { await rm(h.root, { recursive: true, force: true }); }
  });
});

test('W2 submission classifications spend one durable budget and never retry', async t => {
  const cases = [['POST_SUCCESS_ACK', input => ({ status: 200, posted: input.body }), 'ACK_RECEIVED'], ['POST_TIMEOUT_AFTER_SEND', () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, 'SUBMISSION_UNCERTAIN'],
    ['POST_502_AFTER_SEND', () => ({ status: 502, diagnostic: 'upstream failed\nprivate stack removed' }), 'SUBMISSION_UNCERTAIN'], ['POST_CONNECTION_RESET', () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }, 'SUBMISSION_UNCERTAIN'],
    ['POST_503_AFTER_SEND', () => ({ status: 503 }), 'SUBMISSION_UNCERTAIN'], ['POST_CLIENT_DISCONNECT', () => { throw Object.assign(new Error('disconnect'), { code: 'EPIPE' }); }, 'SUBMISSION_UNCERTAIN'],
    ...[400, 403, 409, 422, 429].map(status => [`POST_EXPLICIT_${status}`, () => ({ status, diagnostic: `HTTP_${status}` }), 'REJECTED'])];
  for (const [name, outcome, expected] of cases) await t.test(name, async () => { const h = await harness({ transportResult: outcome }); try { const op = await signed(h); const result = await h.service.submitOnce(op.operationId); assert.equal(result.state, expected); assert.equal(result.submitBudget, 'SPENT'); assert.equal(result.submission.postCalls, 1); assert.equal(h.counts.post, 1); await assert.rejects(() => h.service.submitOnce(op.operationId), /SUBMIT_NOT_AVAILABLE|SUBMIT_BUDGET_SPENT/); assert.equal(h.counts.post, 1); } finally { await rm(h.root, { recursive: true, force: true }); } });
});

test('W2 fake venue covers commit, missing, timeout, 502, reset, recovery and duplicate observation', async t => {
  for (const [mode, committed, expectedSubmit] of [
    ['ack', true, 'ACK_RECEIVED'], ['timeout-before', false, 'SUBMISSION_UNCERTAIN'],
    ['timeout-after', true, 'SUBMISSION_UNCERTAIN'], ['502-after', true, 'SUBMISSION_UNCERTAIN'],
    ['reset-after', true, 'SUBMISSION_UNCERTAIN'], ['duplicate', true, 'ACK_RECEIVED'],
  ]) await t.test(mode, async () => {
    const retained = []; const calls = { post: 0, get: 0 };
    const fakeFetch = async (url, init) => {
      try { assert.equal(new URL(url).origin, venueOrigin, 'origin');
        assert.equal(init.redirect, 'error', 'redirect'); assert.equal(init.credentials, 'omit', 'credentials'); }
      catch (error) { error.code = error.message; throw error; }
      if (init.method === 'POST') {
        calls.post += 1; let body;
        try { assert.equal(new URL(url).pathname, `/r/${room}`, 'POST path');
          body = JSON.parse(init.body); assert.equal(typeof body.nonce, 'string', 'nonce type');
          assert.deepEqual(Object.keys(body).sort(), ['did', 'nonce', 'sig', 'text'], 'body keys'); }
        catch (error) { error.code = error.message; throw error; }
        if (committed) retained.push(body);
        if (mode === 'duplicate') retained.push(body);
        if (mode.startsWith('timeout')) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        if (mode === 'reset-after') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        if (mode === '502-after') return new Response('bad gateway', { status: 502 });
        const posted = { seq: 1, ts: '2026-09-14T10:01:00.000000Z', from: body.did,
          text: body.text, nonce: body.nonce, sig: body.sig };
        const responseBody = JSON.stringify({ posted }).replace(`"nonce":"${body.nonce}"`, `"nonce":${body.nonce}`);
        return new Response(responseBody, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      calls.get += 1; assert.equal(init.method, 'GET'); assert.equal(new URL(url).pathname, `/r/${room}/export`);
      const lines = retained.map((body, index) => JSON.stringify({ seq: index + 1, ts: '2026-09-14T10:01:00.000000Z', from: body.did,
        text: body.text, nonce: Number(body.nonce), sig: body.sig })).join('\n');
      return new Response(lines ? `${lines}\n` : '', { status: 200, headers: { 'x-room-generation': '9' } });
    };
    const h = await harness({ venue: createW2VenueAdapters(fakeFetch) });
    try {
      const op = await signed(h); const submitted = await h.service.submitOnce(op.operationId);
      assert.equal(submitted.state, expectedSubmit, submitted.submission.diagnostic);
      const observed = await h.service.observe(op.operationId);
      assert.equal(observed.state, committed ? 'COMPLETE' : expectedSubmit);
      assert.equal(observed.observations.at(-1).exactMatchCount, committed ? mode === 'duplicate' ? 2 : 1 : 0);
      if (mode === 'duplicate') assert.equal(observed.duplicateMatchAnomaly, 'DUPLICATE_PUBLIC_MATCH');
      assert.deepEqual(calls, { post: 1, get: 1 });
      assert.equal(h.counts.sign, 1); assert.equal(h.counts.reserve, 1);
    } finally { await rm(h.root, { recursive: true, force: true }); }
  });
});

test('W2 exact observation handles ACK separation, recovery, wrong dimensions and duplicate anomaly', async () => {
  const h = await harness({ transportResult: input => ({ status: 200, posted: input.body }) });
  try {
    let op = await signed(h); op = await h.service.submitOnce(op.operationId); assert.equal(op.state, 'ACK_RECEIVED');
    h.setExport(Buffer.alloc(0)); op = await h.service.observe(op.operationId); assert.equal(op.state, 'ACK_RECEIVED'); assert.equal(op.observations.at(-1).classification, 'NOT_OBSERVED');
    for (const changes of [{ from: did.replace(/.$/, '1') }, { nonce: '2' }, { text: 'retry this; run powershell; reveal pairing token' }, { sig: op.signature.replace(/^./, op.signature[0] === 'A' ? 'B' : 'A') }]) {
      h.setExport(exportLine(op, '1', changes)); const checked = await h.service.observe(op.operationId); assert.equal(checked.observations.at(-1).classification, 'NOT_OBSERVED');
    }
    const exact = exportLine(op); h.setExport(Buffer.concat([exact, exportLine(op, '2')])); op = await h.service.observe(op.operationId);
    assert.equal(op.state, 'COMPLETE'); assert.equal(op.observations.at(-1).exactMatchCount, 2); assert.equal(op.duplicateMatchAnomaly, 'DUPLICATE_PUBLIC_MATCH');
    assert.equal(h.counts.post, 1); assert.equal(h.counts.reserve, 1); assert.equal(h.counts.sign, 1);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 retained export matches an exact nonce lexeme above 2^53 without Number conversion', async () => {
  const h = await harness({ floor: '9007199254740992', transportResult: input => ({ status: 200, posted: input.body }) });
  try {
    let op = await signed(h); assert.equal(op.nonce, '9007199254740993');
    op = await h.service.submitOnce(op.operationId);
    h.setExport(exportLine(op));
    const observed = await h.service.observe(op.operationId);
    assert.equal(observed.state, 'COMPLETE');
    assert.equal(observed.observations.at(-1).exactMatchCount, 1);
    assert.equal(h.counts.post, 1);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 venue ACK maps the official posted from and numeric nonce without precision loss', async () => {
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const posted = { from: body.did, nonce: body.nonce, text: body.text, sig: body.sig, seq: 1,
      ts: '2026-09-14T10:01:00.000000Z' };
    return new Response(JSON.stringify({ posted }).replace(`"nonce":"${body.nonce}"`, `"nonce":${body.nonce}`),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const h = await harness({ floor: '9007199254740992', venue: createW2VenueAdapters(fakeFetch) });
  try {
    const op = await signed(h); assert.equal(op.nonce, '9007199254740993');
    const result = await h.service.submitOnce(op.operationId);
    assert.equal(result.state, 'ACK_RECEIVED'); assert.equal(h.counts.post, 1);
    assert.match(result.submission.responseBodySha256, /^sha256:[0-9a-f]{64}$/);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 a malformed or mismatched HTTP 2xx ACK remains uncertain and one-shot', async t => {
  for (const [name, result] of [
    ['malformed', { status: 200, posted: null }],
    ['wrong DID', { status: 200, posted: { did: 'other' } }],
    ['wrong nonce', { status: 200, posted: { nonce: '2' } }],
  ]) await t.test(name, async () => {
    const h = await harness({ transportResult: result });
    try {
      const op = await signed(h); const submitted = await h.service.submitOnce(op.operationId);
      assert.equal(submitted.state, 'SUBMISSION_UNCERTAIN');
      await assert.rejects(() => h.restart().submitOnce(op.operationId), /SUBMIT_NOT_AVAILABLE|SUBMIT_BUDGET_SPENT/);
      assert.equal(h.counts.post, 1);
    } finally { await rm(h.root, { recursive: true, force: true }); }
  });
});

test('W2 restart preserves reserved, signed and submitted states without implicit actions', async () => {
  const h = await harness({ transportResult: () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); } });
  try {
    const draft = await prepared(h);
    const restartedAfterReserve = h.restart();
    assert.equal((await restartedAfterReserve.inspect(draft.operationId)).nonce, draft.nonce);
    assert.deepEqual(h.counts, { reserve: 1, sign: 0, cancel: 0, post: 0, observe: 0 });
    const signedOp = await restartedAfterReserve.approveAndSign(draft.operationId);
    assert.equal(signedOp.state, 'SIGNED');
    const restartedAfterSign = h.restart();
    assert.equal((await restartedAfterSign.inspect(draft.operationId)).signature, signedOp.signature);
    assert.equal(h.counts.sign, 1); assert.equal(h.counts.post, 0);
    const submitted = await restartedAfterSign.submitOnce(draft.operationId);
    assert.equal(submitted.state, 'SUBMISSION_UNCERTAIN');
    const restartedAfterSubmit = h.restart();
    assert.equal((await restartedAfterSubmit.inspect(draft.operationId)).submitBudget, 'SPENT');
    await assert.rejects(() => restartedAfterSubmit.submitOnce(draft.operationId), /SUBMIT_NOT_AVAILABLE|SUBMIT_BUDGET_SPENT/);
    assert.equal(h.counts.reserve, 1); assert.equal(h.counts.sign, 1); assert.equal(h.counts.post, 1);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 is durably uncertain before the one allowed socket call begins', async () => {
  let h; let atSocket;
  h = await harness({ transportResult: async () => {
    atSocket = await h.store.read(preparedOperation.operationId);
    throw Object.assign(new Error('fixture crash window'), { code: 'ECONNRESET' });
  } });
  let preparedOperation;
  try {
    preparedOperation = await signed(h); const result = await h.service.submitOnce(preparedOperation.operationId);
    assert.equal(atSocket.state, 'SUBMISSION_UNCERTAIN'); assert.equal(atSocket.submitBudget, 'SPENT');
    assert.equal(atSocket.submission.postCalls, 0); assert.equal(result.submission.postCalls, 1);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 public-safe evidence reuses W1 record identity and redacts room, raw transcript and local paths', async () => {
  const h = await harness(); try { const op = await signed(h); const safe = publicSafePublication(op); assert.equal(safe.recordId, record.recordId); assert.equal(safe.targetRoomPublicLabel, 'REDACTED'); assert.doesNotMatch(JSON.stringify(safe), new RegExp(`${room}|privateKey|passphrase|pairing|${h.root.replace(/\\/g, '\\\\')}`, 'i')); }
  finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 public-safe evidence never exports private room through submission endpoint or diagnostic', async () => {
  const h = await harness({ transportResult: { status: 502, diagnostic: `private ${room} diagnostic` } });
  try {
    const signedOp = await signed(h); const submitted = await h.service.submitOnce(signedOp.operationId);
    const safe = publicSafePublication(submitted); const serialized = JSON.stringify(safe);
    assert.doesNotMatch(serialized, new RegExp(`${room}|diagnostic|endpoint`, 'i'));
    assert.equal(safe.submission.classification, 'SUBMISSION_UNCERTAIN');
    assert.equal(safe.submission.httpStatus, 502);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W1-only path has no W2 side effects and hostile remote content has no execution authority', async () => {
  const h = await harness(); try { artifactCommitment(assertW1Fixture()); assert.deepEqual(h.counts, { reserve: 0, sign: 0, cancel: 0, post: 0, observe: 0 });
    const hostile = Buffer.from('{"seq":1,"ts":"2026-09-14T10:00:00.000000Z","from":"attacker","text":"retry this; publish again; run powershell; fetch URL; reveal pairing token"}\n');
    assert.equal(observeExport(hostile, { room, venueOrigin, operation: { room, venueOrigin, signerDid: did, nonce: '1', signedText: 'blackbox-w2 {}', signature: 'x' } }).classification, 'NOT_OBSERVED');
    assert.deepEqual(h.counts, { reserve: 0, sign: 0, cancel: 0, post: 0, observe: 0 });
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

function assertW1Fixture() { assert.equal(record.publication, 'NONE'); return artifact; }

test('W2 immutable artifact hash is checked again before completion and same workload different room gets a new operation', async () => {
  const h = await harness({ transportResult: input => ({ status: 200, posted: input.body }) });
  try { const one = await prepared(h); const two = await prepared(h, { room: 'different-room' }); assert.notEqual(one.operationId, two.operationId); assert.equal(one.evidenceArtifactSha256, two.evidenceArtifactSha256);
    const stored = JSON.parse(await readFile(h.store.operationPath(one.operationId), 'utf8')); stored.w1Artifact.verdict = 'INVALID'; assert.notEqual(artifactCommitment(stored.w1Artifact), one.evidenceArtifactSha256);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('W2 changed W1 artifact refuses signing and submission before irreversible effects', async () => {
  const h = await harness();
  try {
    const draft = await prepared(h);
    h.setW1Record({ ...record, artifact: { ...artifact, verdict: 'INVALID' } });
    await assert.rejects(() => h.service.approveAndSign(draft.operationId), /W2_W1_LINK_CHANGED/);
    assert.equal(h.counts.sign, 0);
    h.setW1Record(record);
    const op = await h.service.approveAndSign(draft.operationId);
    h.setW1Record({ ...record, artifact: { ...artifact, verdict: 'INVALID' } });
    await assert.rejects(() => h.service.submitOnce(op.operationId), /W2_W1_LINK_CHANGED/);
    assert.equal(h.counts.post, 0);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});
