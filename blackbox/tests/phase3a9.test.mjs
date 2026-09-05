import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { buildRehearsalAccept, assertNonReuse, phase3bFootprint } from '../airlock/rehearsal.mjs';
import { prepareFrame } from '../airlock/prepare.mjs';
import { buildRequest, approveRequest } from '../airlock/envelope.mjs';
import { signFrozenAirlockRequest } from '../airlock/adapter.mjs';
import { TestVectorSigner } from '../airlock/signer.mjs';
import {
  approvalCode, confirmFixtureOperator, expectedApprovalPhrase, fixtureOperatorConfirmation,
  recheckApprovalBinding, requireInteractiveOperatorTerminal, reviewSnapshot,
} from '../airlock/operator-approval.mjs';

function fixtureRequest() {
  const rehearsal = buildRehearsalAccept();
  // The rehearsal actors are intentionally synthetic and do not name a held key. The fixture
  // signer supplies the only DID used for the fixture custody E2E; no canonical custody is involved.
  const signer = new TestVectorSigner();
  const prepared = prepareFrame({ ...rehearsal.frame, from: signer.did }, { offlineRehearsalRoom: rehearsal.room });
  return { rehearsal, prepared, request: buildRequest(prepared, { createdAt: '2023-11-14T22:13:20.000Z' }) };
}

test('fixture operator approval binds to the exact request and reaches fixture POST_ELIGIBLE only', () => {
  const { rehearsal, prepared, request } = fixtureRequest();
  const approval = approveRequest(request);
  const result = signFrozenAirlockRequest({ request, approval }, {
    nowMs: Date.parse(request.createdAt) + 60_000,
    signedAt: request.createdAt,
  });
  assert.equal(result.postEligible, true);
  assert.equal(result.posted, false);
  assert.equal(result.realCanonicalSignerAccessed, false);
  assert.equal(result.realSignaturePerformed, false);
  assert.equal(confirmFixtureOperator(request).ok, true);
  assert.equal(assertNonReuse({ room: rehearsal.room, contractId: rehearsal.contractId, canonicalHash: prepared.canonicalHash, requestId: request.requestId, requestFingerprint: request.requestFingerprint }, phase3bFootprint()).ok, true);
});

test('wrong, blank, and cancelled fixture confirmations fail closed', () => {
  const { request } = fixtureRequest();
  assert.equal(confirmFixtureOperator(request, () => fixtureOperatorConfirmation({ request, response: 'WRONG' })).code, 'WRONG_APPROVAL_CODE');
  assert.equal(confirmFixtureOperator(request, () => fixtureOperatorConfirmation({ request, response: 'blank' })).code, 'WRONG_APPROVAL_CODE');
  assert.equal(confirmFixtureOperator(request, () => fixtureOperatorConfirmation({ request, response: 'cancel' })).code, 'OPERATOR_CANCELLED');
  assert.match(expectedApprovalPhrase(request), new RegExp(`^SIGN ONCE ${approvalCode(request)}$`));
});

test('TTY gate refuses redirected input and approval is not accepted from argv or environment', () => {
  assert.throws(() => requireInteractiveOperatorTerminal({ stdin: { isTTY: false }, stdout: { isTTY: true } }), /INTERACTIVE_TTY_REQUIRED/);
  assert.throws(() => requireInteractiveOperatorTerminal({ stdin: { isTTY: true }, stdout: { isTTY: false } }), /INTERACTIVE_TTY_REQUIRED/);
});

test('approval TOCTOU check catches payload, room, canonical commit, and TCLK mutations', () => {
  const { request } = fixtureRequest();
  const metadata = { canonicalCommit: '8a2cd163954dd36053fef79e964f5909dc741fa7', tclkPin: 'd48e87343200e3115e243df39e8f295f5ce2e645' };
  const snapshot = reviewSnapshot(request, metadata);
  const mutated = { ...request, canonicalPayload: `${request.canonicalPayload} ` };
  assert.equal(recheckApprovalBinding(mutated, snapshot).ok, false);
  assert.equal(recheckApprovalBinding(request, snapshot, { ...metadata, canonicalCommit: '0'.repeat(40) }).ok, false);
  assert.equal(recheckApprovalBinding(request, snapshot, { ...metadata, tclkPin: '0'.repeat(40) }).ok, false);
  assert.equal(recheckApprovalBinding(request, snapshot, { ...metadata, phase3bReuse: 'YES' }).ok, false);
});

test('real operator entrypoint refuses a non-TTY test-runner invocation before custody', async () => {
  // Phase 3A.10.3: `--approve` is now refused as an unsupported option before the TTY gate is even
  // reached, so both refusals are asserted. A test runner cannot get past either one.
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, ['blackbox/airlock/real-detached-sign.mjs', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => resolve({ code, output }));
  });

  const cliApproval = await run(['--approve']);
  assert.notEqual(cliApproval.code, 0);
  assert.match(cliApproval.output, /approval cannot be supplied by CLI/);

  const nonTty = await run([]);
  assert.notEqual(nonTty.code, 0);
  assert.match(nonTty.output, /INTERACTIVE_TTY_REQUIRED/);
  assert.doesNotMatch(nonTty.output, /signature\s*:/i);
});
