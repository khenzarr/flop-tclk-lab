import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  PHASE3B_STATES, createOperation, fixtureSign, fixtureSubmit, inspectBudget,
  namedProfile, readPendingSignedOperation, spendBudget, transition, verifyFixtureSignedOperation,
  writePendingSignedOperation, fixtureObserve, fixtureWrite1E2E,
} from '../phase3b2.mjs';

const ROOT = '9be158c613e68533a1700fdb2e08fac1adcacba16370551a98403b7d10922d8f';
const frame = { write: 1, type: 'offer', room: 'tclk-offers', canonicalFrame: { from: namedProfile().publicDid, role: 'payer', amount: '100', asset: 'FLOP' } };
const operation = () => createOperation(frame, ROOT);

test('named fixture profiles are validated, isolated, and DID-bound', () => {
  const a = namedProfile(); const b = namedProfile('phase3b-counterparty-b');
  assert.equal(a.root, 'DEFAULT_ROOT');
  assert.match(b.root, /^IDENTITIES_ROOT\//);
  assert.notEqual(a.publicDid, b.publicDid);
  assert.throws(() => namedProfile('../escape'), /PROFILE_INVALID/);
});

test('fixture default and named detached signing verify locally', () => {
  const a = fixtureSign(operation());
  assert.equal(verifyFixtureSignedOperation(a), true);
  const bOperation = createOperation({ ...frame, canonicalFrame: { ...frame.canonicalFrame, from: namedProfile('phase3b-counterparty-b').publicDid } }, ROOT);
  const b = fixtureSign(bOperation, { profile: 'phase3b-counterparty-b' });
  assert.equal(verifyFixtureSignedOperation(b), true);
  assert.throws(() => fixtureSign(operation(), { profile: 'phase3b-counterparty-b' }), /EXPECTED_SIGNER_DID_BINDING/);
});

test('pending signed operation is integrity-bound and detects mutation', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b2-pending-'));
  try {
    const record = fixtureSign(operation()); const saved = writePendingSignedOperation(record, root);
    assert.equal(readPendingSignedOperation(saved.path, ROOT, record.operationId).signature, record.signature);
    const mutated = { ...record, text: 'mutation' };
    writeFileSync(saved.path, `${JSON.stringify(mutated)}\n`);
    assert.throws(() => readPendingSignedOperation(saved.path, ROOT, record.operationId), /./);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('durable sign and submit budgets are independent and one-shot', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b2-budget-'));
  try {
    const id = operation().operationId;
    assert.equal(inspectBudget('SIGN', id, root).available, true);
    spendBudget('SIGN', id, root); assert.equal(inspectBudget('SIGN', id, root).available, false);
    assert.equal(inspectBudget('SUBMIT', id, root).available, true);
    assert.throws(() => spendBudget('SIGN', id, root), error => error.code === 'ONE_SHOT_BUDGET_SPENT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lifecycle is fail-closed and ACK does not equal observation', () => {
  let state = { state: 'PLANNED', history: ['PLANNED'] };
  for (const next of ['APPROVED_FOR_SIGN', 'SIGN_ATTEMPTED', 'SIGNED', 'APPROVED_FOR_SUBMIT', 'SUBMIT_ATTEMPTED', 'ACK_RECEIVED', 'RECONCILING', 'OBSERVED_PUBLIC', 'ACCEPTED_BY_MACHINE']) state = transition(state, next);
  assert.deepEqual(state.history, ['PLANNED', 'APPROVED_FOR_SIGN', 'SIGN_ATTEMPTED', 'SIGNED', 'APPROVED_FOR_SUBMIT', 'SUBMIT_ATTEMPTED', 'ACK_RECEIVED', 'RECONCILING', 'OBSERVED_PUBLIC', 'ACCEPTED_BY_MACHINE']);
  assert.throws(() => transition({ state: 'ACK_RECEIVED', history: ['ACK_RECEIVED'] }, 'OBSERVED_PUBLIC'), /LIFECYCLE_REFUSED/);
  assert.deepEqual(PHASE3B_STATES.includes('SUBMISSION_UNCERTAIN'), true);
});

test('fixture submit always emits exactly one request and classifies uncertainty', () => {
  const record = fixtureSign(operation());
  for (const response of [200, 400, 408, 425, 429, 500, 'connection-close', 'timeout']) {
    const result = fixtureSubmit(record, response);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.classification, response === 200 ? 'ACK_RECEIVED' : response === 400 ? 'REJECTED' : response === 408 || response === 425 || response === 429 || response === 500 || typeof response === 'string' ? 'SUBMISSION_UNCERTAIN' : 'ACK_RECEIVED');
  }
});

test('observation is a separate bounded reconciliation step', () => {
  const record = fixtureSign(operation());
  assert.equal(fixtureObserve(record, [{ room: record.room, nonce: record.nonce, did: record.did, text: record.text }]).classification, 'OBSERVED_PUBLIC');
  assert.equal(fixtureObserve(record, []).classification, 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW');
});

test('WRITE #1 fixture trajectory stops at ACK and uncertain submit has one attempt', () => {
  const accepted = fixtureWrite1E2E();
  assert.equal(accepted.operation.state, 'ACK_RECEIVED');
  assert.equal(accepted.submission.attempts.length, 1);
  const uncertain = fixtureWrite1E2E({ response: 'connection-close' });
  assert.equal(uncertain.operation.state, 'SUBMISSION_UNCERTAIN');
  assert.equal(uncertain.submission.attempts.length, 1);
});
