import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createOperation, fixtureSign, namedProfile, writePendingSignedOperation } from '../phase3b2.mjs';
import { fixtureRailWrite } from '../phase3b-rail.mjs';
import { runFixtureJourney } from '../phase3b-fixture.mjs';
import { acquireOneShotAttempt, budgetIdentity, inspectOneShotAttempt } from '../airlock/attempt-budget.mjs';
import {
  inspectSubmitResult, observeMatch, parseJsonLines, requestFor, requireObservedPublic, reviewData, runRealObserve, runRealSubmit,
  submitBudgetIdentity, submitBudgetStatus, SUBMIT_ATTEMPT_IDENTITY, SUBMIT_ENDPOINT,
  validatePendingOperation, WRITE1_OPERATION, validateTransportBody, CORRECTED_REQUEST_BODY_SHA256,
  HISTORICAL_ATTEMPT1_BODY_SHA256, SUBMIT_ATTEMPT_2_IDENTITY, reconcileMissingWrite3Receipt,
  WRITE2_RETENTION_CLASSIFICATION, WRITE2_RESPONSE_BODY_SHA256,
} from '../phase3b-submit-observe.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const quiet = () => {};

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b-submit-observe-'));
  const pendingRoot = resolve(root, 'pending');
  const budgetRoot = resolve(root, 'budget');
  const stateRoot = resolve(root, 'submit');
  const manifestRoot = hash(`fixture-manifest:${root}`);
  const operation = createOperation({ write: 1, type: 'offer', room: 'tclk-offers',
    canonicalFrame: { from: namedProfile().publicDid, role: 'payer', amount: '100', asset: 'FLOP' } }, manifestRoot);
  const signed = fixtureSign(operation);
  const pendingPath = writePendingSignedOperation(signed, pendingRoot).path;
  const expectedBindings = { expectedDid: signed.did, expectedRoom: signed.room, expectedNonce: signed.nonce,
    expectedTextBytes: Buffer.byteLength(signed.text, 'utf8'), expectedTextSha256: hash(Buffer.from(signed.text, 'utf8')) };
  const options = { operationId: WRITE1_OPERATION, pendingPath, budgetRoot, stateRoot, expectedRoot: manifestRoot,
    expectedBindings, reviewSink: quiet };
  const numericBody = JSON.stringify({ did: signed.did, sig: signed.signature, nonce: signed.nonce, text: signed.text });
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(resolve(stateRoot, `${WRITE1_OPERATION}.json`), `${JSON.stringify({
    schema: 'tclk/phase3b-submit-result/v1', operationId: WRITE1_OPERATION,
    submitAttemptIdentity: 'phase3b-write-1-submit-attempt-1', classification: 'REJECTED', httpStatus: 400,
    postCalls: 1, requestBodySha256: HISTORICAL_ATTEMPT1_BODY_SHA256,
    numericRequestBodySha256: hash(numericBody), correctedTransportOnly: true,
    pendingArtifactSha256: hash(readFileSync(pendingPath, 'utf8')),
  })}\n`);
  return { root, pendingPath, budgetRoot, stateRoot, signed, options };
}

async function withFixture(run) {
  const value = fixture();
  try { return await run(value); } finally { rmSync(value.root, { recursive: true, force: true }); }
}

test('A: preflight validates fixture pending bytes without budget or network mutation', () => withFixture(async ({ options, budgetRoot }) => {
  let calls = 0;
  const result = await runRealSubmit({ ...options, preflight: true, transport: async () => { calls += 1; } });
  assert.equal(result.pendingVerification, 'PASS');
  assert.equal(result.networkCalls, 0); assert.equal(calls, 0); assert.equal(result.budgetMutations, 0);
  assert.equal(submitBudgetStatus(budgetRoot).state, 'AVAILABLE');
}));

test('B/C: approved submit performs exactly one locked POST; ACK needs separate exact observation', () => withFixture(async ({ options, signed }) => {
  const calls = [];
  const result = await runRealSubmit({ ...options, confirm: async () => true, transport: async (...args) => { calls.push(args); return { status: 200 }; } });
  assert.equal(result.classification, 'ACK_RECEIVED'); assert.equal(result.postCalls, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], SUBMIT_ENDPOINT);
  assert.deepEqual(calls[0][1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestFor(signed).body, redirect: 'error', credentials: 'omit' });
  assert.equal(observeMatch(signed, [{ ...signed, seq: 999 }]).classification, 'OBSERVED_PUBLIC');
}));

test('transport schema refuses numeric nonce and accepts decimal string; corrected ordering/hash is exact', () => withFixture(({ signed }) => {
  const numeric = { did: signed.did, sig: signed.signature, nonce: signed.nonce, text: signed.text };
  assert.throws(() => validateTransportBody(numeric), /TRANSPORT_SCHEMA_REFUSED/);
  const corrected = { did: signed.did, sig: signed.signature, nonce: '1', text: signed.text };
  assert.equal(validateTransportBody(corrected), true);
  assert.notEqual(hash(JSON.stringify(numeric)), hash(JSON.stringify(corrected)));
  assert.equal(JSON.stringify(corrected), requestFor(signed).body);
}));

test('D/E: timeout is uncertain, never retried, and bounded observe reconciles independently', () => withFixture(async ({ options, signed }) => {
  let posts = 0;
  const result = await runRealSubmit({ ...options, confirm: async () => true, transport: async () => { posts += 1; throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } });
  assert.equal(result.classification, 'SUBMISSION_UNCERTAIN'); assert.equal(posts, 1);
  assert.equal(observeMatch(signed, [signed]).classification, 'OBSERVED_PUBLIC');
  assert.equal(observeMatch(signed, []).classification, 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW');
}));

test('F/G: uncertain statuses, redirect and malformed response never retry; clear rejection stays rejected', async () => {
  for (const status of [408, 425, 429, 500, 503, 302, undefined]) await withFixture(async ({ options }) => {
    let calls = 0;
    const result = await runRealSubmit({ ...options, confirm: async () => true, transport: async () => { calls += 1; return { status }; } });
    assert.equal(result.classification, 'SUBMISSION_UNCERTAIN'); assert.equal(calls, 1);
  });
  await withFixture(async ({ options }) => {
    let calls = 0;
    const result = await runRealSubmit({ ...options, confirm: async () => true, transport: async () => { calls += 1; return {
      status: 400, headers: { get: () => 'application/json' }, text: async () => 'x'.repeat(4096),
    }; } });
    assert.equal(result.classification, 'REJECTED'); assert.equal(calls, 1);
    assert.equal(result.diagnosticExcerpt.length, 2048); assert.equal(result.responseContentType, 'application/json');
  });
});

test('H-M: all pending mutations refuse before budget and transport', async () => {
  const mutations = [
    record => ({ ...record, integrity: `${record.integrity[0] === '0' ? '1' : '0'}${record.integrity.slice(1)}` }),
    record => ({ ...record, signature: `${record.signature}A` }),
    record => ({ ...record, text: `${record.text}x` }),
    record => ({ ...record, manifestRoot: hash('wrong-root') }),
    record => ({ ...record, did: `${record.did}x` }),
    record => ({ ...record, room: 'wrong-room' }),
  ];
  for (const mutate of mutations) await withFixture(async ({ options, pendingPath, budgetRoot }) => {
    const record = JSON.parse(readFileSync(pendingPath, 'utf8'));
    writeFileSync(pendingPath, `${JSON.stringify(mutate(record))}\n`);
    let calls = 0;
    await assert.rejects(runRealSubmit({ ...options, confirm: async () => true, transport: async () => { calls += 1; } }), /PENDING_OPERATION/);
    assert.equal(calls, 0); assert.equal(submitBudgetStatus(budgetRoot).state, 'AVAILABLE');
  });
});

test('N/O: cancellation and post-approval TOCTOU mutation stay before budget and network', async () => {
  await withFixture(async ({ options, budgetRoot }) => {
    let calls = 0;
    await assert.rejects(runRealSubmit({ ...options, confirm: async () => false, transport: async () => { calls += 1; } }), /OPERATOR_CANCELLED/);
    assert.equal(calls, 0); assert.equal(submitBudgetStatus(budgetRoot).state, 'AVAILABLE');
  });
  await withFixture(async ({ options, pendingPath, budgetRoot }) => {
    let calls = 0;
    await assert.rejects(runRealSubmit({ ...options, confirm: async () => true,
      afterApproval: async () => writeFileSync(pendingPath, '{}\n'), transport: async () => { calls += 1; } }), /PENDING_OPERATION|JSON/);
    assert.equal(calls, 0); assert.equal(submitBudgetStatus(budgetRoot).state, 'AVAILABLE');
  });
});

test('P/Q: spent budget blocks every later POST and concurrent submits have one winner', () => withFixture(async ({ options, budgetRoot }) => {
  let calls = 0;
  const transport = async () => { calls += 1; await new Promise(resolvePromise => setTimeout(resolvePromise, 20)); return { status: 200 }; };
  const settled = await Promise.allSettled([
    runRealSubmit({ ...options, confirm: async () => true, transport }),
    runRealSubmit({ ...options, confirm: async () => true, transport }),
  ]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1); assert.equal(calls, 1);
  await assert.rejects(runRealSubmit({ ...options, confirm: async () => true, transport }), /BUDGET_SPENT/);
  assert.equal(calls, 1); assert.equal(submitBudgetStatus(budgetRoot).state, 'SPENT');
}));

test('attempt #1 evidence remains separate and attempt #2 identity is available before approval', () => withFixture(async ({ options, stateRoot, budgetRoot, signed }) => {
  const result = await runRealSubmit({ ...options, preflight: true });
  assert.equal(result.submitAttemptIdentity, SUBMIT_ATTEMPT_2_IDENTITY.subject);
  assert.equal(result.submitBudget, 'AVAILABLE'); assert.equal(result.budgetMutations, 0);
  assert.equal(result.networkCalls, 0); assert.equal(result.requestBodySha256, requestFor(signed).bodySha256);
  assert.equal(existsSync(resolve(stateRoot, `${WRITE1_OPERATION}.json`)), true);
  assert.equal(existsSync(resolve(stateRoot, `${WRITE1_OPERATION}-submit-attempt-2.json`)), false);
}));

test('crash-after-budget state is permanently uncertain and never retryable', () => withFixture(async ({ budgetRoot, stateRoot }) => {
  acquireOneShotAttempt(submitBudgetIdentity(), { root: budgetRoot });
  assert.deepEqual(inspectSubmitResult({ budgetRoot, stateRoot }).classification, 'SUBMISSION_UNCERTAIN');
  assert.equal(inspectSubmitResult({ budgetRoot, stateRoot }).retryAllowed, false);
}));

test('observe is GET-only and exact room+DID+nonce+text matching ignores venue sequence', () => withFixture(async ({ options, signed }) => {
  const calls = [];
  const result = await runRealObserve({ ...options, transport: async (...args) => { calls.push(args); return { ok: true, status: 200,
    json: async () => ({ records: [{ ...signed, seq: 12345 }] }) }; } });
  assert.equal(result.classification, 'OBSERVED_PUBLIC'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [SUBMIT_ENDPOINT, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } }]);
  for (const changed of [{ room: 'x' }, { did: 'x' }, { nonce: 2 }, { text: 'x' }]) {
    assert.equal(observeMatch(signed, [{ ...signed, ...changed }]).classification, 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW');
  }
}));

test('submit and observe production surfaces have no signer, custody, DPAPI, nonce reservation, or sign budget dependency', () => {
  for (const file of ['phase3b-submit-observe.mjs', 'phase3b-submit-cli.mjs', 'phase3b-observe-cli.mjs']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /airlock\/(?:signer|detached-bridge|real-route|budget)\.mjs|DPAPI|reserveNonce|PHASE3B_SIGN/);
  }
});

test('hotfix: endpoint and operation-specific review follow pending room/frame/attempt identity', () => {
  const write2 = JSON.parse(readFileSync(resolve('blackbox/state/phase3b-pending-signed/phase3b-write-2.json'), 'utf8'));
  const write3 = JSON.parse(readFileSync(resolve('blackbox/state/phase3b-pending-signed/phase3b-write-3.json'), 'utf8'));
  assert.equal(requestFor(write3).endpoint, 'https://technocore.chat/r/mb-p-tclk-62b08bcfe4331e3a?format=json');
  assert.equal(requestFor(write3).path, '/r/mb-p-tclk-62b08bcfe4331e3a');
  const pending = record => ({ record, rawSha256: hash(JSON.stringify(record)), integrity: record.integrity });
  const budget = { budgetId: 'fixture-budget', state: 'AVAILABLE' };
  const review2 = reviewData(pending(write2), requestFor(write2), budget);
  const review3 = reviewData(pending(write3), requestFor(write3), budget);
  assert.equal(review2.frame, 'accept'); assert.equal(review3.frame, 'lock');
  assert.equal(review2.submitAttemptIdentity, 'phase3b-write-2-submit');
  assert.equal(review3.submitAttemptIdentity, 'phase3b-write-3-submit-attempt-2');
  assert.notEqual(review2.approvalFingerprint, review3.approvalFingerprint);
  assert.doesNotMatch(JSON.stringify([review2, review3]), /phase3b-write-1-submit-attempt-2/);
});

test('hotfix: JSONL export parses multiple CRLF/LF records, empty input, and malformed line diagnostics', () => {
  assert.deepEqual(parseJsonLines('{"seq":1}\r\n\n{"seq":2}\n'), [{ seq: 1 }, { seq: 2 }]);
  assert.deepEqual(parseJsonLines(' \r\n\n'), []);
  assert.throws(() => parseJsonLines('{"seq":1}\n{"seq":'), /OBSERVATION_EXPORT_JSONL_MALFORMED:LINE_2/);
});

test('hotfix: WRITE #2 retained-ring JSONL exact match persists OBSERVED_PUBLIC without POST', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b-write2-observe-'));
  try {
    const signed = JSON.parse(readFileSync(resolve('blackbox/state/phase3b-pending-signed/phase3b-write-2.json'), 'utf8'));
    const methods = [];
    const result = await runRealObserve({ operationId: 'phase3b-write-2', stateRoot: root,
      transport: async (_url, options) => { methods.push(options.method); return { ok: true, status: 200, json: async () => ({ records: [] }) }; },
      exportTransport: async (_url, options) => { methods.push(options.method); return { ok: true, status: 200,
        text: async () => `${JSON.stringify({ room: 'other', did: 'other', nonce: 1, text: 'other' })}\r\n${JSON.stringify(signed)}\n` }; } });
    assert.equal(result.classification, 'OBSERVED_PUBLIC'); assert.equal(result.observationSource, 'RETAINED_RING_EXPORT');
    assert.deepEqual(methods, ['GET', 'GET']); assert.equal(existsSync(resolve(root, 'phase3b-write-2-observation.json')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hotfix: dependency requires OBSERVED_PUBLIC rather than ACK', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b-dependency-'));
  try {
    writeFileSync(resolve(root, 'phase3b-write-2-observation.json'), JSON.stringify({ operationId: 'phase3b-write-2', classification: 'ACK_RECEIVED' }));
    assert.throws(() => requireObservedPublic('phase3b-write-3', root), /OBSERVED_PUBLIC_REQUIRED/);
    writeFileSync(resolve(root, 'phase3b-write-2-observation.json'), JSON.stringify({ operationId: 'phase3b-write-2', classification: 'OBSERVED_PUBLIC' }));
    assert.equal(requireObservedPublic('phase3b-write-3', root).classification, 'OBSERVED_PUBLIC');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retention hotfix: historical WRITE #2 retention evidence is reduced grade and uniquely satisfies WRITE #3', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b-retention-dependency-'));
  try {
    const evidence = { operationId: 'phase3b-write-2', classification: WRITE2_RETENTION_CLASSIFICATION,
      originalSubmitClassification: 'ACK_RECEIVED', httpStatus: 200, postCalls: 1, room: 'tclk-offers', did: 'did:key:z6Mkk9tS1bieLjbRmh7fa4hy7BQRapTG9rp7q8En9o4GvmfK', signedNonce: 1,
      requestBodySha256: '64e2a38c38b6249b2655e9c17c7b02025706d0b64fff883d97025bf06e70fc3b',
      responseBodySha256: WRITE2_RESPONSE_BODY_SHA256, submitTimestamp: '2026-09-08T23:51:00.618Z', canonicalTextSha256: '172fb6e08e946e91a169a76e8b32b5474df31f8f0cb86e7865d953de624ad93f', retentionObservation: 'NOT_FOUND_IN_RETAINED_RING',
      publicSeq: 'UNKNOWN', publicTimestamp: 'UNKNOWN', evidenceLimitation: 'PUBLIC_RECORD_NO_LONGER_RETAINED' };
    writeFileSync(resolve(root, 'phase3b-write-2-observation.json'), JSON.stringify(evidence));
    assert.notEqual(evidence.classification, 'OBSERVED_PUBLIC');
    assert.equal(requireObservedPublic('phase3b-write-3', root).classification, WRITE2_RETENTION_CLASSIFICATION);
    writeFileSync(resolve(root, 'phase3b-write-3-observation.json'), JSON.stringify({ operationId: 'phase3b-write-3', classification: WRITE2_RETENTION_CLASSIFICATION,
      originalSubmitClassification: 'ACK_RECEIVED', httpStatus: 200, retentionObservation: 'NOT_FOUND_IN_RETAINED_RING',
      publicSeq: 'UNKNOWN', publicTimestamp: 'UNKNOWN', evidenceLimitation: 'PUBLIC_RECORD_NO_LONGER_RETAINED' }));
    assert.throws(() => requireObservedPublic('phase3b-write-4', root), /OBSERVED_PUBLIC_REQUIRED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hotfix: PaperRail write requires durable OBSERVED_PUBLIC predecessor evidence', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b-rail-dependency-'));
  try {
    assert.throws(() => fixtureRailWrite('phase3b-write-5', { completed: ['phase3b-write-1', 'phase3b-write-2', 'phase3b-write-3'], stateRoot: root }), /DEPENDENCY_REFUSED:phase3b-write-3/);
    writeFileSync(resolve(root, 'phase3b-write-3-observation.json'), JSON.stringify({ operationId: 'phase3b-write-3', classification: 'ACK_RECEIVED' }));
    assert.throws(() => fixtureRailWrite('phase3b-write-5', { completed: ['phase3b-write-1', 'phase3b-write-2', 'phase3b-write-3'], stateRoot: root }), /OBSERVED_PUBLIC_REQUIRED/);
    writeFileSync(resolve(root, 'phase3b-write-3-observation.json'), JSON.stringify({ operationId: 'phase3b-write-3', classification: 'OBSERVED_PUBLIC' }));
    const evidence = fixtureRailWrite('phase3b-write-5', { completed: ['phase3b-write-1', 'phase3b-write-2', 'phase3b-write-3'], stateRoot: root });
    assert.equal(evidence.evidenceClass, 'UNSIGNED_RAIL_OBSERVATION');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hotfix: WRITE #3 recovery preserves attempt #1 and pending bytes while preflight uses attempt #2 deal endpoint', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b-write3-recovery-'));
  const budgetRoot = resolve(root, 'budget'); const stateRoot = resolve(root, 'state'); mkdirSync(stateRoot);
  const pendingPath = resolve('blackbox/state/phase3b-pending-signed/phase3b-write-3.json');
  const raw = readFileSync(pendingPath, 'utf8'); const pending = JSON.parse(raw);
  const missingAttempt1Path = resolve(stateRoot, 'phase3b-write-3.json');
  const attempt1Identity = budgetIdentity({ purpose: 'PHASE3B_SUBMIT', operationClass: 'REAL_TECHNOCORE_ROOM_POST', subject: 'phase3b-write-3-submit' });
  acquireOneShotAttempt(attempt1Identity, { root: budgetRoot });
  const markerPath = inspectOneShotAttempt(attempt1Identity, { root: budgetRoot }).path;
  const markerBefore = readFileSync(markerPath, 'utf8');
  writeFileSync(resolve(stateRoot, 'phase3b-write-2-observation.json'), JSON.stringify({ operationId: 'phase3b-write-2',
    classification: WRITE2_RETENTION_CLASSIFICATION, originalSubmitClassification: 'ACK_RECEIVED', httpStatus: 200, postCalls: 1,
    room: 'tclk-offers', did: 'did:key:z6Mkk9tS1bieLjbRmh7fa4hy7BQRapTG9rp7q8En9o4GvmfK', signedNonce: 1,
    requestBodySha256: '64e2a38c38b6249b2655e9c17c7b02025706d0b64fff883d97025bf06e70fc3b',
    responseBodySha256: WRITE2_RESPONSE_BODY_SHA256, submitTimestamp: '2026-09-08T23:51:00.618Z',
    canonicalTextSha256: '172fb6e08e946e91a169a76e8b32b5474df31f8f0cb86e7865d953de624ad93f',
    retentionObservation: 'NOT_FOUND_IN_RETAINED_RING', publicSeq: 'UNKNOWN', publicTimestamp: 'UNKNOWN',
    evidenceLimitation: 'PUBLIC_RECORD_NO_LONGER_RETAINED' }));
  try {
    const reconciliation = reconcileMissingWrite3Receipt({ stateRoot, budgetRoot, pendingPath });
    assert.equal(reconciliation.classification, 'HISTORICAL_SUBMIT_RECEIPT_NOT_PERSISTED');
    assert.equal(reconciliation.source, 'OPERATOR_TERMINAL_TRANSCRIPT_PLUS_DURABLE_BUDGET_MARKER');
    assert.equal(reconciliation.historicalCodeProvenance.wrongRoom, 'tclk-offers');
    assert.equal(reconciliation.historicalCodeProvenance.expectedRoom, 'mb-p-tclk-62b08bcfe4331e3a');
    let review;
    const result = await runRealSubmit({ operationId: 'phase3b-write-3', preflight: true, pendingPath, budgetRoot, stateRoot,
      reviewSink: value => { review = value; } });
    assert.equal(result.submitAttemptIdentity, 'phase3b-write-3-submit-attempt-2');
    assert.equal(result.endpoint, 'https://technocore.chat/r/mb-p-tclk-62b08bcfe4331e3a?format=json');
    assert.equal(review.frame, 'lock'); assert.equal(review.exactPath, '/r/mb-p-tclk-62b08bcfe4331e3a');
    assert.equal(result.submitBudget, 'AVAILABLE'); assert.equal(result.budgetMutations, 0); assert.equal(result.networkCalls, 0);
    assert.equal(readFileSync(pendingPath, 'utf8'), raw); assert.equal(existsSync(missingAttempt1Path), false);
    assert.equal(readFileSync(markerPath, 'utf8'), markerBefore);
    assert.equal(existsSync(resolve(stateRoot, 'phase3b-write-3-submit-attempt-2.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('final capsule input preserves exactly one WRITE #2 retention gap', () => {
  const capsule = runFixtureJourney();
  const gaps = capsule.observations.filter(item => item.classification === 'SERVER_APPENDED_THEN_NOT_RETAINED');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].operationId, 'phase3b-write-2');
  assert.equal(gaps[0].publicSeq, 'UNKNOWN');
  assert.equal(capsule.observations.find(item => item.operationId === 'phase3b-write-1').classification, 'OBSERVED_PUBLIC');
  for (const id of ['phase3b-write-3', 'phase3b-write-4', 'phase3b-write-5', 'phase3b-write-6']) {
    assert.equal(capsule.observations.find(item => item.operationId === id).classification, 'OBSERVED_PUBLIC');
  }
});