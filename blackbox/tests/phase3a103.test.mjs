// PHASE 3A.10.3 — PROOF THAT THE ENABLED REAL ROUTE IS EXECUTABLE BUT NOT AUTOMATABLE.
//
// These tests drive the production control flow in ./airlock/real-route.mjs unmodified. Only two
// seams are test implementations: the interactive input providers (Blackbox side and canonical
// child side) and the custody provider (fixture key, temporary nonce). Every gate, ordering rule,
// and refusal below is the same code the real route runs.
//
// No real custody is reachable from a test runner: the runner owns no TTY, which is asserted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { gateA, MAX_REAL_SIGNATURES, RealSignatureBudget, REVIEWED_CANONICAL_COMMIT, SIGNING_MODES } from '../airlock/budget.mjs';
import { confirmFixtureOperator, fixtureOperatorConfirmation } from '../airlock/operator-approval.mjs';
import {
  CANONICAL_WORKTREE, canonicalPython, detachedRequestFrame,
  invokeFixtureDetachedBridge, invokeRealDetachedBridge,
} from '../airlock/detached-bridge.mjs';
import { prepareRealRoute, runDetachedSigningRoute } from '../airlock/real-route.mjs';

const HUMAN_TERMINAL = { stdin: { isTTY: true }, stdout: { isTTY: true } };
const approves = request => confirmFixtureOperator(request);
const answers = response => request => confirmFixtureOperator(request, () => fixtureOperatorConfirmation({ request, response }));
const refuseBridge = () => { throw new Error('custody handoff must not be reached'); };

function collector() {
  const lines = [];
  return { log: line => lines.push(String(line)), text: () => lines.join('\n') };
}

test('FULL_ENABLED_REAL_ROUTE_FIXTURE_E2E: the production flow signs, verifies locally, and stops', async () => {
  const out = collector();
  const result = await runDetachedSigningRoute({
    custody: 'fixture', streams: HUMAN_TERMINAL, approvalProvider: approves, log: out.log,
  });

  // Same control flow, fixture custody: approved bytes signed, locally verified, nothing posted.
  assert.equal(result.verified, true);
  assert.equal(result.custodyMode, 'fixture');
  assert.equal(result.canonicalCommit, REVIEWED_CANONICAL_COMMIT);
  assert.equal(result.nonce, 1); // temporary nonce store, consumed once
  assert.equal(result.postEligible, true);
  assert.equal(result.posted, false);
  assert.equal(result.submitted, false);
  assert.equal(result.transportObjects, 0);
  assert.match(out.text(), /LOCAL VERIFICATION\nPASS/);

  // RAW_SIGNATURE_CONSOLE_LEAK / RAW_SIGNED_OPERATION_CONSOLE_LEAK. Ed25519 is deterministic and
  // the fixture nonce store restarts at 1, so the same bytes yield the signature the route held.
  const { request, review } = prepareRealRoute();
  const known = await invokeFixtureDetachedBridge({ room: review.room, text: request.canonicalPayload, requestId: 'phase3a103-leak' });
  assert.equal(result.signatureLength, known.signature.length);
  assert.equal(out.text().includes(known.signature), false);
  assert.equal(JSON.stringify(result).includes(known.signature), false);
  assert.equal(JSON.stringify({ requestId: result.requestId, status: 'POST_ELIGIBLE_FIXTURE', posted: false }).includes(known.signature), false);
});

test('non-TTY, wrong, blank, and cancelled approvals all fail closed before custody', async () => {
  const cases = [
    { streams: { stdin: { isTTY: false }, stdout: { isTTY: true } }, approvalProvider: approves, expect: /INTERACTIVE_TTY_REQUIRED/ },
    { streams: HUMAN_TERMINAL, approvalProvider: answers('WRONG'), expect: /WRONG_APPROVAL_CODE/ },
    { streams: HUMAN_TERMINAL, approvalProvider: answers('blank'), expect: /WRONG_APPROVAL_CODE/ },
    { streams: HUMAN_TERMINAL, approvalProvider: answers('cancel'), expect: /OPERATOR_CANCELLED/ },
  ];
  for (const { streams, approvalProvider, expect } of cases) {
    await assert.rejects(() => runDetachedSigningRoute({
      custody: 'fixture', streams, approvalProvider, bridge: refuseBridge, log: () => {},
    }), expect);
  }
});

test('post-approval mutation of provenance voids the approval before custody', async () => {
  await assert.rejects(() => runDetachedSigningRoute({
    custody: 'fixture', streams: HUMAN_TERMINAL, approvalProvider: approves, bridge: refuseBridge, log: () => {},
    recheckMetadata: { canonicalCommit: '0'.repeat(40), tclkPin: 'd48e87343200e3115e243df39e8f295f5ce2e645' },
  }), /APPROVAL_INVALIDATED.*CANONICALCOMMIT_MUTATED_AFTER_APPROVAL/);

  await assert.rejects(() => runDetachedSigningRoute({
    custody: 'fixture', streams: HUMAN_TERMINAL, approvalProvider: approves, bridge: refuseBridge, log: () => {},
    recheckMetadata: { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: '0'.repeat(40) },
  }), /APPROVAL_INVALIDATED.*TCLKPIN_MUTATED_AFTER_APPROVAL/);

  await assert.rejects(() => runDetachedSigningRoute({
    custody: 'fixture', streams: HUMAN_TERMINAL, approvalProvider: approves, bridge: refuseBridge, log: () => {},
    recheckMetadata: { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: 'd48e87343200e3115e243df39e8f295f5ce2e645', phase3bReuse: 'YES' },
  }), /APPROVAL_INVALIDATED.*PHASE3BREUSE_MUTATED_AFTER_APPROVAL/);
});

test('real custody stays refused without human approval, and one signature is the whole budget', () => {
  const detached = { mode: SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION, realCustody: true };
  assert.equal(gateA(detached).decision, 'REFUSE');
  assert.equal(gateA(detached).findings.includes('REAL_CUSTODY_REQUIRES_HUMAN_APPROVAL'), true);
  assert.equal(gateA({ ...detached, humanApproved: true }).decision, 'ALLOW_ARCHITECTURE');
  assert.equal(gateA({ mode: SIGNING_MODES.LEGACY_COUPLED_ROOM_OPERATION }).decision, 'REFUSE');
  assert.equal(gateA({ ...detached, humanApproved: true, publicPostingEnabled: true }).decision, 'REFUSE');

  assert.equal(MAX_REAL_SIGNATURES, 1);
  const budget = new RealSignatureBudget();
  budget.consume('first');
  assert.throws(() => budget.consume('retry'), /MAX_REAL_SIGNATURES=1 already consumed/);
});

test('the test runner cannot reach real protected custody', async () => {
  await assert.rejects(() => invokeRealDetachedBridge({ room: 'never', text: 'never signed', requestId: 'phase3a103-real-denied' }), /INTERACTIVE_TTY_REQUIRED/);
});

function runCanonicalChild(args, stdinText) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(canonicalPython(CANONICAL_WORKTREE), ['-m', 'technocore_agent.signer.real_detached_sign_bridge', ...args], {
      cwd: CANONICAL_WORKTREE, env: { ...process.env, PYTHONPATH: 'src' }, windowsHide: true,
      stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', () => resolveResult(stdout));
    if (stdinText !== undefined) child.stdin.end(stdinText);
  });
}

test('direct canonical invocation refuses every unattended shape before custody', async () => {
  const state = resolve(tmpdir(), `flop-tclk-3a103-state-${randomUUID()}`);
  const terminal = ['--approval-source', 'terminal'];
  const fixtureChannel = ['--approval-source', 'fixture'];
  const cases = [
    // A pipe is not a character device on any platform, so the TTY gate itself refuses. The piped
    // text is a plausible approval phrase precisely to show that no pipe can ever supply one.
    { name: 'piped approval', frame: {}, args: ['--custody', 'fixture', ...terminal], stdin: 'SIGN DETACHED 00000000\n', expect: /INTERACTIVE_TTY_REQUIRED/ },
    // Windows reports NUL — what an ignored stdio handle attaches — as a character device, so
    // isatty() is true there while the handle is still unattended. The request-bound phrase cannot
    // be read from it, so the confirmation refuses before custody on either platform semantics.
    { name: 'unattended stdin handle', frame: {}, args: ['--custody', 'fixture', ...terminal], expect: /INTERACTIVE_TTY_REQUIRED|WRONG_CANONICAL_APPROVAL/ },
    { name: 'real custody with a test channel', frame: {}, args: ['--custody', 'real', ...fixtureChannel], expect: /operator terminal approval channel/ },
    { name: 'wrong child approval', frame: {}, args: ['--custody', 'fixture', ...fixtureChannel, '--approval-response', 'wrong'], expect: /WRONG_CANONICAL_APPROVAL/ },
    { name: 'blank child approval', frame: {}, args: ['--custody', 'fixture', ...fixtureChannel, '--approval-response', 'blank'], expect: /WRONG_CANONICAL_APPROVAL/ },
    { name: 'wrong expected commit', frame: { expectedCanonicalCommit: '0'.repeat(40) }, args: ['--custody', 'fixture', ...fixtureChannel], expect: /does not match expected commit/ },
    { name: 'wrong purpose', frame: { purpose: 'SUBMIT_ROOM_OPERATION' }, args: ['--custody', 'fixture', ...fixtureChannel], expect: /purpose or schema is invalid/ },
    { name: 'malformed request', frame: { extra: 'approved' }, args: ['--custody', 'fixture', ...fixtureChannel], expect: /schema is invalid/ },
  ];
  for (const { name, frame, args, stdin, expect } of cases) {
    const path = resolve(tmpdir(), `flop-tclk-3a103-${randomUUID()}.json`);
    const request = { ...detachedRequestFrame({ room: 'phase3a103-room', text: 'phase3a103 never signed', requestId: 'phase3a103-direct' }), ...frame };
    await writeFile(path, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 });
    try {
      const stdout = await runCanonicalChild([...args, '--request-file', path, '--state', state], stdin);
      const response = JSON.parse(stdout);
      assert.match(response.error, expect, name);
      assert.equal('signature' in response, false, name);
    } finally { await rm(path, { force: true }); }
  }
  await rm(state, { force: true, recursive: true });
});


test('the operator entrypoint accepts no CLI approval and refuses a non-interactive run', async () => {
  const runEntrypoint = args => new Promise(resolveResult => {
    const child = spawn(process.execPath, ['blackbox/airlock/real-detached-sign.mjs', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('close', code => resolveResult({ code, stderr, stdout }));
    // A piped approval phrase is offered deliberately: it must never be accepted.
    child.stdin.end('SIGN ONCE 0000\n');
  });

  for (const args of [['--approve'], ['--yes'], ['--force'], ['--approval-code', 'SIGN']]) {
    const { code, stderr } = await runEntrypoint(args);
    assert.notEqual(code, 0);
    assert.match(stderr, /unsupported option; approval cannot be supplied by CLI/);
  }
  for (const args of [[], ['--preflight-only']]) {
    const { code, stderr, stdout } = await runEntrypoint(args);
    assert.notEqual(code, 0);
    assert.match(stderr, /INTERACTIVE_TTY_REQUIRED/);
    assert.doesNotMatch(stdout, /signature/i);
  }
});
