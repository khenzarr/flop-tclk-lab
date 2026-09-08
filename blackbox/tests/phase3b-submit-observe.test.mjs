import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createOperation, fixtureSign, namedProfile, writePendingSignedOperation } from '../phase3b2.mjs';
import { acquireOneShotAttempt } from '../airlock/attempt-budget.mjs';
import {
  inspectSubmitResult, observeMatch, requestFor, runRealObserve, runRealSubmit,
  submitBudgetIdentity, submitBudgetStatus, SUBMIT_ATTEMPT_IDENTITY, SUBMIT_ENDPOINT,
  validatePendingOperation, WRITE1_OPERATION,
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
    const result = await runRealSubmit({ ...options, confirm: async () => true, transport: async () => { calls += 1; return { status: 400 }; } });
    assert.equal(result.classification, 'REJECTED'); assert.equal(calls, 1);
  });
});

test('H-M: all pending mutations refuse before budget and transport', async () => {
  const mutations = [
    record => ({ ...record, integrity: `0${record.integrity.slice(1)}` }),
    record => ({ ...record, signature: `${record.signature.slice(0, -1)}A` }),
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