// PHASE 3A.10.4 — DURABLE ONE-SHOT REAL-EXECUTION BUDGET + PHASE 3A4R4 RETIREMENT.
//
// Temporary fixture state only: every durable root here lives under the OS temporary directory and
// is removed on exit. No real custody, no real nonce, no real signature, no network, no submission.
//
// Cross-process durability cannot be proven inside one process, so some proofs launch short Node
// children. Those children import ONLY the dependency-free attempt-budget module — never custody,
// never the canonical worktree, never a signer (documented subprocess exception in ../lint.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as attemptBudgetModule from '../airlock/attempt-budget.mjs';
import {
  acquireOneShotAttempt, ATTEMPT_BUDGET_SCHEMA, AttemptBudgetRefused, budgetId, BUDGET_ROOT,
  inspectOneShotAttempt, MAX_ONE_SHOT_ATTEMPTS, oneShotAttemptPath,
} from '../airlock/attempt-budget.mjs';
import { assertPhase3a4r4RealPathClosed, PHASE3A4R4_CLOSURE } from '../airlock/budget.mjs';
import { confirmFixtureOperator } from '../airlock/operator-approval.mjs';
import { invokeFixtureDetachedBridge } from '../airlock/detached-bridge.mjs';
import { prepareRealRoute, ROUTE_PURPOSE, runDetachedSigningRoute } from '../airlock/real-route.mjs';

const PURPOSE = 'PHASE3A104_FIXTURE_ONE_SHOT_PROOF';
const OPERATION_CLASS = 'FIXTURE_IRREVERSIBLE_OPERATION';
const SUBJECT = 'fixture-request-fingerprint-0001';
const IDENTITY = Object.freeze({ purpose: PURPOSE, operationClass: OPERATION_CLASS, subject: SUBJECT });

const HUMAN_TERMINAL = { stdin: { isTTY: true }, stdout: { isTTY: true } };
const approves = request => confirmFixtureOperator(request);

const ROOTS = [];
function freshRoot() {
  const root = resolve(tmpdir(), `tclk-phase3a104-${process.pid}-${randomUUID()}`);
  ROOTS.push(root);
  return root;
}
process.on('exit', () => {
  for (const root of ROOTS) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* fixture cleanup only */ }
  }
});

function collector() {
  const lines = [];
  return { log: line => lines.push(String(line)), text: () => lines.join('\n') };
}

// A separate process invocation: the scope the old process-local permit book could not see across.
const MODULE_URL = new URL('../airlock/attempt-budget.mjs', import.meta.url).href;
const CHILD = `
import { acquireOneShotAttempt, inspectOneShotAttempt } from ${JSON.stringify(MODULE_URL)};
const [root, purpose, operationClass, rawSubject, mode, startAt] = process.argv.slice(1);
const identity = { purpose, operationClass, subject: rawSubject === 'NONE' ? null : rawSubject };
const wait = Number(startAt) - Date.now();
if (Number.isFinite(wait) && wait > 0) await new Promise(done => setTimeout(done, wait));
if (mode === 'inspect') {
  const state = inspectOneShotAttempt(identity, { root });
  process.stdout.write('STATE ' + state.state + ' ' + String(state.finding) + '\\n');
} else {
  try {
    const attempt = acquireOneShotAttempt(identity, { root });
    process.stdout.write('ACQUIRED ' + attempt.budgetId + '\\n');
  } catch (error) {
    process.stdout.write('REFUSED ' + (error.code || 'UNKNOWN') + '\\n');
    process.exitCode = 3;
  }
}
if (mode === 'hold') setInterval(() => {}, 1000);
`;

function launch(root, mode, { identity = IDENTITY, startAt = 0 } = {}) {
  const args = ['--input-type=module', '-e', CHILD, root, identity.purpose, identity.operationClass,
    identity.subject ?? 'NONE', mode, String(startAt)];
  return spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function firstLine(child) {
  return new Promise((done, fail) => {
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) done(out.trim()); });
    child.on('close', () => (out.includes('\n') ? done(out.trim()) : fail(new Error(`child produced no line: ${out}`))));
  });
}

async function runChild(root, mode, options) {
  const child = launch(root, mode, options);
  const line = await firstLine(child);
  await new Promise(done => (child.exitCode === null && child.signalCode === null ? child.on('close', done) : done()));
  return line;
}

function markerRecord(root, identity = IDENTITY) {
  return JSON.parse(readFileSync(oneShotAttemptPath(identity, { root }), 'utf8'));
}

test('PROOF 1 + 2: the first acquisition succeeds and every later one in the same process refuses', () => {
  const root = freshRoot();
  assert.equal(inspectOneShotAttempt(IDENTITY, { root }).state, 'AVAILABLE');

  const attempt = acquireOneShotAttempt(IDENTITY, { root });
  assert.equal(attempt.acquired, true);
  assert.equal(attempt.of, MAX_ONE_SHOT_ATTEMPTS);
  assert.equal(MAX_ONE_SHOT_ATTEMPTS, 1);
  assert.equal(attempt.budgetId, budgetId(IDENTITY));
  assert.equal(existsSync(attempt.path), true);

  // A one-shot budget is one attempt: the second and third calls refuse identically, by throwing,
  // so a caller cannot ignore a return value into a second irreversible operation.
  for (const round of [2, 3]) {
    assert.throws(() => acquireOneShotAttempt(IDENTITY, { root }), error => {
      assert.ok(error instanceof AttemptBudgetRefused, `round ${round} must refuse with AttemptBudgetRefused`);
      assert.equal(error.code, 'ONE_SHOT_BUDGET_SPENT');
      assert.match(error.message, /REAL_EXECUTION_BUDGET_EXHAUSTED/);
      return true;
    });
  }

  const state = inspectOneShotAttempt(IDENTITY, { root });
  assert.equal(state.state, 'SPENT');
  assert.equal(state.available, false);
  assert.equal(state.finding, null);
  assert.equal(readdirSync(root).length, 1); // one budget identity, one marker, no retry residue
});

test('CROSS_PROCESS_ONE_SHOT_TEST — PROOF 3: a fresh process cannot re-acquire a spent budget', async () => {
  const root = freshRoot();

  // Process A: the historical run that legitimately spent the budget.
  const first = await runChild(root, 'acquire');
  assert.equal(first, `ACQUIRED ${budgetId(IDENTITY)}`);

  // Process B: the restart that the old process-local budget could not see. This is the defect.
  const second = await runChild(root, 'acquire');
  assert.equal(second, 'REFUSED ONE_SHOT_BUDGET_SPENT');

  // Process C, read-only, and this process too: SPENT is a property of the machine, not of a process.
  assert.equal(await runChild(root, 'inspect'), 'STATE SPENT null');
  assert.throws(() => acquireOneShotAttempt(IDENTITY, { root }), AttemptBudgetRefused);
  assert.equal(readdirSync(root).length, 1);
});

test('CONCURRENT_ONE_SHOT_TEST — PROOF 4: a simultaneous double-launch has exactly one winner', async () => {
  const root = freshRoot();
  // A shared start instant, so the six children race the exclusive create rather than queue behind
  // each other's interpreter startup.
  const startAt = Date.now() + 900;
  const lines = await Promise.all([0, 1, 2, 3, 4, 5].map(() => runChild(root, 'acquire', { startAt })));

  const acquired = lines.filter(line => line.startsWith('ACQUIRED'));
  const refused = lines.filter(line => line === 'REFUSED ONE_SHOT_BUDGET_SPENT');
  assert.equal(acquired.length, 1, `exactly one winner, got ${JSON.stringify(lines)}`);
  assert.equal(refused.length, 5, `every loser must refuse as SPENT, got ${JSON.stringify(lines)}`);
  assert.equal(acquired[0], `ACQUIRED ${budgetId(IDENTITY)}`);
  assert.equal(readdirSync(root).length, 1);
  assert.equal(inspectOneShotAttempt(IDENTITY, { root }).state, 'SPENT');
});

test('CRASH_FAIL_CLOSED_TEST — PROOF 5: a process killed after acquisition leaves the budget SPENT', async () => {
  const root = freshRoot();
  const child = launch(root, 'hold');
  assert.equal(await firstLine(child), `ACQUIRED ${budgetId(IDENTITY)}`);

  // Hard kill: no exit handler, no unwinding, nothing gets a chance to hand the budget back.
  child.kill('SIGKILL');
  await new Promise(done => child.on('close', done));

  assert.equal(inspectOneShotAttempt(IDENTITY, { root }).state, 'SPENT');
  assert.throws(() => acquireOneShotAttempt(IDENTITY, { root }), AttemptBudgetRefused);
  assert.equal(await runChild(root, 'acquire'), 'REFUSED ONE_SHOT_BUDGET_SPENT');
});

test('PROOF 6: truncated, malformed, foreign, and non-file state all fail closed', () => {
  const cases = [
    { name: 'truncated', write: path => writeFileSync(path, ''), finding: 'SPENT_STATE_TRUNCATED' },
    { name: 'not JSON', write: path => writeFileSync(path, '{not json'), finding: 'SPENT_STATE_UNREADABLE' },
    { name: 'JSON array', write: path => writeFileSync(path, '[]'), finding: 'SPENT_STATE_MALFORMED' },
    { name: 'wrong schema', write: path => writeFileSync(path, JSON.stringify({ schema: 'other/v9', state: 'SPENT', budgetId: budgetId(IDENTITY) })), finding: 'SPENT_STATE_SCHEMA_MISMATCH' },
    { name: 'foreign identity', write: path => writeFileSync(path, JSON.stringify({ schema: ATTEMPT_BUDGET_SCHEMA, state: 'SPENT', budgetId: 'f'.repeat(64) })), finding: 'SPENT_STATE_IDENTITY_MISMATCH' },
    { name: 'state not SPENT', write: path => writeFileSync(path, JSON.stringify({ schema: ATTEMPT_BUDGET_SCHEMA, state: 'AVAILABLE', budgetId: budgetId(IDENTITY) })), finding: 'SPENT_STATE_MALFORMED' },
    { name: 'directory in place of the marker', write: path => mkdirSync(path, { recursive: true }), finding: 'SPENT_STATE_NOT_A_FILE' },
  ];
  for (const { name, write, finding } of cases) {
    const root = freshRoot();
    mkdirSync(root, { recursive: true });
    write(oneShotAttemptPath(IDENTITY, { root }));

    const state = inspectOneShotAttempt(IDENTITY, { root });
    assert.equal(state.state, 'SPENT', `${name} must read as SPENT`);
    assert.equal(state.finding, finding, `${name} must be classified`);
    // Unusable state never yields an attempt: broken state is refusal, never permission.
    assert.throws(() => acquireOneShotAttempt(IDENTITY, { root }), error => {
      assert.ok(error instanceof AttemptBudgetRefused, `${name} must refuse`);
      assert.match(error.code, /^ONE_SHOT_BUDGET_(?:SPENT|STATE_UNUSABLE)$/);
      return true;
    }, `${name} must refuse`);
  }
});

test('PROOF 7: missing state is the only AVAILABLE state, and identities cannot escape the root', () => {
  // Documented initialization semantics: a missing marker, and a missing root, are AVAILABLE. The
  // root is created lazily by the acquisition itself, never by a read.
  const root = freshRoot();
  const state = inspectOneShotAttempt(IDENTITY, { root });
  assert.equal(state.state, 'AVAILABLE');
  assert.equal(state.available, true);
  assert.equal(existsSync(root), false, 'inspection must not create durable state');

  assert.equal(acquireOneShotAttempt(IDENTITY, { root }).acquired, true);
  assert.equal(existsSync(root), true);

  // A different identity in the same root is a different budget, and is still AVAILABLE.
  const other = { purpose: PURPOSE, operationClass: OPERATION_CLASS, subject: 'fixture-request-fingerprint-0002' };
  assert.equal(inspectOneShotAttempt(other, { root }).state, 'AVAILABLE');
  assert.notEqual(budgetId(other), budgetId(IDENTITY));

  // Identity tokens are validated, so no identity can traverse out of the state root.
  for (const bad of ['../escape', 'a/b', 'a\\b', '', 'x'.repeat(200), 'has space']) {
    assert.throws(() => oneShotAttemptPath({ purpose: bad, operationClass: OPERATION_CLASS }), TypeError);
    assert.throws(() => acquireOneShotAttempt({ purpose: PURPOSE, operationClass: OPERATION_CLASS, subject: bad }, { root }), TypeError);
  }
});

test('PROOF 8 + 12: the fixture signing path spends exactly one durable budget and leaks nothing', async () => {
  const root = freshRoot();
  const out = collector();
  const result = await runDetachedSigningRoute({
    custody: 'fixture', streams: HUMAN_TERMINAL, approvalProvider: approves, log: out.log, budgetRoot: root,
  });

  assert.equal(result.verified, true);
  assert.equal(result.custodyMode, 'fixture');
  assert.equal(result.nonce, 1);
  assert.equal(result.oneShotBudgetSpent, true);
  assert.match(out.text(), /REAL EXECUTION BUDGET\nSPENT/);
  assert.match(out.text(), /LOCAL VERIFICATION\nPASS/);

  const identity = {
    purpose: ROUTE_PURPOSE,
    operationClass: 'FIXTURE_DETACHED_ROOM_SIGNATURE',
    subject: prepareRealRoute().request.requestFingerprint,
  };
  assert.equal(result.budgetId, budgetId(identity));
  assert.equal(inspectOneShotAttempt(identity, { root }).state, 'SPENT');
  assert.equal(readdirSync(root).length, 1, 'one signature, one durable marker');

  // RAW_OUTPUT_LEAK. Ed25519 is deterministic and the fixture nonce store restarts at 1, so the
  // same approved bytes reproduce the signature the route held but never printed.
  const { request, review } = prepareRealRoute();
  const known = await invokeFixtureDetachedBridge({ room: review.room, text: request.canonicalPayload, requestId: 'phase3a104-leak' });
  const markerText = readFileSync(oneShotAttemptPath(identity, { root }), 'utf8');
  assert.equal(result.signatureLength, known.signature.length);
  assert.equal(out.text().includes(known.signature), false);
  assert.equal(JSON.stringify(result).includes(known.signature), false);
  assert.equal(markerText.includes(known.signature), false);

  // The durable state's fields are fixed and non-secret: no signature, key, passphrase,
  // SignedOperation, credential, or preimage can hide in a shape this narrow.
  const record = markerRecord(root, identity);
  assert.deepEqual(Object.keys(record).sort(), ['acquiredAt', 'budgetId', 'contains', 'note', 'operationClass', 'pid', 'purpose', 'schema', 'state', 'subject']);
  assert.equal(record.schema, ATTEMPT_BUDGET_SCHEMA);
  assert.equal(record.state, 'SPENT');
  assert.equal(record.purpose, ROUTE_PURPOSE);
  assert.equal(record.subject, identity.subject);
});

test('PROOF 9: a second fixture run on the same durable root cannot reach the signer at all', async () => {
  const root = freshRoot();
  let signerCalls = 0;
  const countingBridge = args => { signerCalls += 1; return invokeFixtureDetachedBridge(args); };

  const first = await runDetachedSigningRoute({
    custody: 'fixture', streams: HUMAN_TERMINAL, approvalProvider: approves, log: () => {},
    bridge: countingBridge, budgetRoot: root,
  });
  assert.equal(first.verified, true);
  assert.equal(signerCalls, 1);

  await assert.rejects(() => runDetachedSigningRoute({
    custody: 'fixture', streams: HUMAN_TERMINAL, approvalProvider: approves, log: () => {},
    bridge: countingBridge, budgetRoot: root,
  }), error => {
    assert.ok(error instanceof AttemptBudgetRefused);
    assert.equal(error.code, 'ONE_SHOT_BUDGET_SPENT');
    assert.match(error.message, /REAL_EXECUTION_BUDGET_EXHAUSTED/);
    return true;
  });

  // The budget is spent before the irreversible boundary, so the second run never signs and never
  // consumes a nonce. This is the ordering rule the historical two-run defect violated.
  assert.equal(signerCalls, 1);
  assert.equal(readdirSync(root).length, 1);
});

test('PHASE3A4R4_RETIREMENT_TEST — PROOF 10: the Phase 3A4R4 real path is permanently closed', async () => {
  // Historical truth is recorded, not rewritten: two attempts, local nonces 1 then 2, nothing posted.
  assert.equal(PHASE3A4R4_CLOSURE.state, 'CLOSED');
  assert.equal(PHASE3A4R4_CLOSURE.reopenable, false);
  assert.equal(PHASE3A4R4_CLOSURE.finding, 'CROSS_PROCESS_REAL_SIGNATURE_BUDGET_BYPASS');
  assert.equal(PHASE3A4R4_CLOSURE.realSignatureAttemptsObserved, 2);
  assert.deepEqual([...PHASE3A4R4_CLOSURE.localNoncesObservedConsumed], [1, 2]);
  assert.equal(PHASE3A4R4_CLOSURE.publicSubmissionsObserved, 0);
  assert.equal(PHASE3A4R4_CLOSURE.rawSignaturesPersisted, false);

  // No argument shape reopens it. Fixture custody is untouched, so validation survives retirement.
  for (const options of [undefined, {}, { custody: 'real' }, { custody: 'real', purpose: 'ANYTHING_ELSE' }]) {
    assert.throws(() => assertPhase3a4r4RealPathClosed(options), error => {
      assert.match(error.message, /PHASE3A4R4_CLOSED/);
      assert.match(error.message, /REAL_EXECUTION_BUDGET_EXHAUSTED/);
      assert.match(error.message, /HISTORICAL_REAL_SIGNATURE_ATTEMPTS 2/);
      assert.match(error.message, /HISTORICAL_LOCAL_NONCES_OBSERVED 1,2/);
      return true;
    });
  }
  assert.equal(assertPhase3a4r4RealPathClosed({ custody: 'fixture' }).applies, false);

  // The production command refuses before the review, the approval, custody, the nonce, and signing.
  const out = collector();
  let approvals = 0;
  let signerCalls = 0;
  await assert.rejects(() => runDetachedSigningRoute({
    custody: 'real', streams: HUMAN_TERMINAL, log: out.log,
    approvalProvider: () => { approvals += 1; throw new Error('approval must not be reached'); },
    bridge: () => { signerCalls += 1; throw new Error('custody must not be reached'); },
  }), /PHASE3A4R4_CLOSED/);
  assert.equal(approvals, 0);
  assert.equal(signerCalls, 0);
  assert.equal(out.text(), '', 'closure precedes even the review display');

  // The retirement is source-level, so it does not depend on durable state: the real budget was
  // never initialized by this phase, and initializing it is not what closes the command.
  const realMarker = oneShotAttemptPath({
    purpose: ROUTE_PURPOSE, operationClass: 'REAL_DETACHED_ROOM_SIGNATURE',
    subject: prepareRealRoute().request.requestFingerprint,
  });
  assert.equal(existsSync(realMarker), false, 'no real budget state may be created by tests');
  assert.equal(realMarker.startsWith(BUDGET_ROOT), true);
});

test('PROOF 11: no test can reach real custody, and the primitive has no un-spend surface', async () => {
  // A test runner owns no interactive terminal, and the route refuses before anything else without
  // one. Real custody is therefore unreachable from CI even ignoring the source-level closure.
  assert.notEqual(process.stdin.isTTY, true);
  await assert.rejects(() => runDetachedSigningRoute({
    custody: 'real', streams: { stdin: {}, stdout: {} },
    approvalProvider: () => { throw new Error('approval must not be reached'); },
    bridge: () => { throw new Error('custody must not be reached'); },
    log: () => {},
  }));

  // The durable root is beside the code, never inside the DPAPI custody root.
  assert.equal(BUDGET_ROOT.includes('TechnocoreAgent'), false);
  assert.match(BUDGET_ROOT, /blackbox[\\/]state[\\/]attempt-budget$/);

  // AVAILABLE -> SPENT is the only transition. An un-spend API would be the bypass this closes.
  const forbidden = /release|reset|rollback|unspend|revoke|clear|delete|remove|refund/i;
  for (const name of Object.keys(attemptBudgetModule)) {
    assert.equal(forbidden.test(name), false, `attempt-budget must not export ${name}`);
  }
});

test('PROOF 13 + 14: the changed modules have no network path and no submission path', async () => {
  const sources = ['attempt-budget.mjs', 'real-route.mjs', 'budget.mjs'].map(file => ({
    file, text: readFileSync(new URL(`../airlock/${file}`, import.meta.url), 'utf8'),
  }));
  // Assembled from fragments so this test file does not itself contain the banned literals.
  const network = ['node:htt' + 'p', 'node:htt' + 'ps', 'fet' + 'ch(', 'XMLHttpRequest', 'WebSocket',
    'node:net', 'node:tls', 'node:dgram', 'undici', 'axios', 'https://'];
  const submission = ['sub' + 'mit(', 'post(', 'publish(', 'broadcast(', 'send(', 'upload('];
  for (const { file, text } of sources) {
    for (const token of network) assert.equal(text.includes(token), false, `${file} must contain no network path (${token})`);
    for (const token of submission) assert.equal(text.includes(token), false, `${file} must contain no submission path (${token})`);
  }

  // And observably: the fixture run produces no transport object and posts nothing.
  const result = await runDetachedSigningRoute({
    custody: 'fixture', streams: HUMAN_TERMINAL, approvalProvider: approves, log: () => {},
    budgetRoot: freshRoot(),
  });
  assert.equal(result.posted, false);
  assert.equal(result.submitted, false);
  assert.equal(result.transportObjects, 0);
});
