import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { acquireOneShotAttempt, inspectOneShotAttempt } from '../airlock/attempt-budget.mjs';
import { FINAL_ROOTS, FINAL_W1_ATTEMPT2_IDENTITY, finalW1RecoveryPreflight, runFinalW1RecoverySubmit } from '../phase3b-s2.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phase3b-final-w1-recovery-')); roots.push(root);
  const pendingRoot = resolve(root, 'pending'); const submitStateRoot = resolve(root, 'submit'); const budgetRoot = resolve(root, 'budget');
  mkdirSync(pendingRoot); mkdirSync(submitStateRoot);
  for (const name of ['phase3b-final-write-1.json']) copyFileSync(resolve(FINAL_ROOTS.pending, name), resolve(pendingRoot, name));
  for (const name of ['phase3b-final-write-1-submit.json', 'phase3b-final-write-1-observation.json']) copyFileSync(resolve(FINAL_ROOTS.submit, name), resolve(submitStateRoot, name));
  acquireOneShotAttempt({ purpose: 'PHASE3B_FINAL_SUBMIT', operationClass: 'REAL_TECHNOCORE_ROOM_POST', subject: 'phase3b-final-write-1-submit' }, { root: budgetRoot });
  return { pendingRoot, submitStateRoot, budgetRoot };
};

test('recovery preflight reuses exact signed fields and preserves spent attempt 1', () => {
  const review = finalW1RecoveryPreflight();
  assert.equal(review.existingSignatureReused, true);
  assert.equal(review.signedFieldsChanged, false);
  assert.equal(review.resignRequired, false);
  assert.equal(review.attempt1Budget, 'SPENT');
  assert.equal(review.attempt2Identity, 'phase3b-final-write-1-submit-attempt-2');
  assert.equal(review.attempt2Budget, 'AVAILABLE');
  assert.equal(review.networkCalls, 0);
});

for (const [status, classification] of [[200, 'ACK_RECEIVED'], [400, 'REJECTED'], [500, 'SUBMISSION_UNCERTAIN']]) {
  test(`attempt 2 performs one approved fixture POST and classifies HTTP ${status}`, async () => {
    const paths = fixture(); let calls = 0; const attempt1Path = resolve(paths.submitStateRoot, 'phase3b-final-write-1-submit.json');
    const attempt1Before = readFileSync(attempt1Path);
    const result = await runFinalW1RecoverySubmit({ ...paths, confirmSubmit: async () => true, transport: async () => {
      calls += 1; return { status, headers: { get: () => 'text/plain' }, text: async () => status === 200 ? 'ok' : 'bounded diagnostic' };
    } });
    assert.equal(calls, 1); assert.equal(result.postCalls, 1); assert.equal(result.automaticRetries, 0);
    assert.equal(result.classification, classification);
    assert.equal(result.submitAttemptIdentity, FINAL_W1_ATTEMPT2_IDENTITY.subject);
    assert.deepEqual(readFileSync(attempt1Path), attempt1Before);
    assert.equal(inspectOneShotAttempt(FINAL_W1_ATTEMPT2_IDENTITY, { root: paths.budgetRoot }).state, 'SPENT');
    if (status >= 400) assert.equal(result.boundedSanitizedDiagnostic, 'bounded diagnostic');
  });
}

test('cancellation stays before attempt 2 budget and transport', async () => {
  const paths = fixture(); let calls = 0;
  await assert.rejects(runFinalW1RecoverySubmit({ ...paths, confirmSubmit: async () => false, transport: async () => { calls += 1; } }), /OPERATOR_CANCELLED/);
  assert.equal(calls, 0);
  assert.equal(inspectOneShotAttempt(FINAL_W1_ATTEMPT2_IDENTITY, { root: paths.budgetRoot }).state, 'AVAILABLE');
});
