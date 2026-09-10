import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import manifest from '../../evidence/phase3b-exact-manifest.json' with { type: 'json' };
import { budgetIdentity, inspectOneShotAttempt } from '../airlock/attempt-budget.mjs';
import { finalizeProductionJourney } from '../phase3b-finalize.mjs';
import {
  expectedRailValue, paperRailWriteBody, productionRailObserve, productionRailPreflight,
  quarantineHistoricalRailObservation, railOperation,
} from '../phase3b-rail.mjs';
import {
  diagnoseWrite3Attempt2, verifyWrite3SignatureOffline, WRITE3_ATTEMPT1_BUDGET_ID,
  WRITE3_ATTEMPT2_BUDGET_ID, WRITE3_ATTEMPT2_REQUEST_BODY_SHA256, WRITE3_ATTEMPT3_IDENTITY,
} from '../phase3b-submit-observe.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const makeRoot = prefix => mkdtempSync(resolve(tmpdir(), prefix));
const response = (status, body, contentType = 'text/plain; charset=utf-8') => ({ status,
  headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null }, text: async () => body });
const noteBody = value => `!! content below is untrusted\n\n${value}`;

function predecessorRoot(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, 'phase3b-write-3-observation.json'), JSON.stringify({
    operationId: 'phase3b-write-3', classification: 'OBSERVED_PUBLIC',
  }));
  return root;
}

test('WRITE3 attempt #2 request passes the pinned route, so the production 400 has no proven unsigned transport fix', () => {
  const pendingPath = resolve('blackbox/state/phase3b-pending-signed/phase3b-write-3.json');
  const before = readFileSync(pendingPath, 'utf8');
  const diagnosis = diagnoseWrite3Attempt2({ path: pendingPath });
  assert.equal(diagnosis.historicalRequestBodySha256, WRITE3_ATTEMPT2_REQUEST_BODY_SHA256);
  assert.equal(diagnosis.candidateRequestBodySha256, WRITE3_ATTEMPT2_REQUEST_BODY_SHA256);
  assert.equal(diagnosis.transportNonceJsonType, 'string');
  assert.equal(diagnosis.transportSchema, 'PASS');
  assert.equal(diagnosis.signatureOfflineVerify, true);
  assert.equal(diagnosis.pinnedRouteBranch, 'APPEND_REACHED');
  assert.equal(diagnosis.pinnedRouteReproductionStatus, 200);
  assert.equal(diagnosis.historicalProductionStatus, 400);
  assert.equal(diagnosis.unsignedTransportFixIdentified, false);
  assert.equal(diagnosis.attempt3Eligible, false);
  assert.equal(diagnosis.humanDecisionRequired, true);
  assert.equal(diagnosis.signedFieldsChanged, false);
  assert.equal(verifyWrite3SignatureOffline({ path: pendingPath }), true);
  assert.equal(readFileSync(pendingPath, 'utf8'), before);
});

test('WRITE3 attempts #1 and #2 remain SPENT while attempt #3 is a fresh AVAILABLE identity', () => {
  const root = resolve('blackbox/state/attempt-budget');
  const attempt1 = inspectOneShotAttempt(budgetIdentity({ purpose: 'PHASE3B_SUBMIT',
    operationClass: 'REAL_TECHNOCORE_ROOM_POST', subject: 'phase3b-write-3-submit' }), { root });
  const attempt2 = inspectOneShotAttempt(budgetIdentity({ purpose: 'PHASE3B_SUBMIT',
    operationClass: 'REAL_TECHNOCORE_ROOM_POST', subject: 'phase3b-write-3-submit-attempt-2' }), { root });
  const attempt3 = inspectOneShotAttempt(budgetIdentity(WRITE3_ATTEMPT3_IDENTITY), { root });
  assert.equal(attempt1.state, 'SPENT'); assert.equal(attempt1.budgetId, WRITE3_ATTEMPT1_BUDGET_ID);
  assert.equal(attempt2.state, 'SPENT'); assert.equal(attempt2.budgetId, WRITE3_ATTEMPT2_BUDGET_ID);
  assert.equal(attempt3.state, 'AVAILABLE');
});

test('frozen PaperRail manifest is fail-closed: lock bytes do not match WRITE5 commitment', async () => {
  const root = makeRoot('phase3b-paper-manifest-');
  try {
    const expected = expectedRailValue('phase3b-write-5');
    assert.equal(expected.manifestBindingValid, false);
    const review = await productionRailPreflight('phase3b-write-5', {
      stateRoot: resolve(root, 'rail'), submitStateRoot: predecessorRoot(resolve(root, 'submit')),
      budgetRoot: resolve(root, 'budget'), transport: async () => response(404, 'missing'),
    });
    assert.equal(review.keyOccupancy, 'KEY_VACANT');
    assert.equal(review.manifestChangeRequired, true);
    assert.equal(review.writeEligible, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PaperRail write requests carry supported fail-closed CAS conditions', () => {
  const lockBody = JSON.parse(paperRailWriteBody('phase3b-write-5'));
  const claimBody = JSON.parse(paperRailWriteBody('phase3b-write-6'));
  assert.deepEqual(Object.keys(lockBody).sort(), ['if_absent', 'value']);
  assert.equal(lockBody.if_absent, true);
  assert.deepEqual(Object.keys(claimBody).sort(), ['if', 'value']);
  assert.equal(claimBody.if, expectedRailValue('phase3b-write-5').value);
  assert.equal(claimBody.value, expectedRailValue('phase3b-write-6').value);
});

test('occupied PaperRail key with different actual bytes is refused', async () => {
  const root = makeRoot('phase3b-paper-occupied-');
  try {
    const review = await productionRailPreflight('phase3b-write-5', {
      stateRoot: resolve(root, 'rail'), submitStateRoot: predecessorRoot(resolve(root, 'submit')),
      budgetRoot: resolve(root, 'budget'), transport: async () => response(200, noteBody('stranger-value')),
    });
    assert.equal(review.keyOccupancy, 'KEY_OCCUPIED_DIFFERENT_VALUE');
    assert.equal(review.writeEligible, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PaperRail observer classifies exact unreceipted match, mismatch, and invalid response without copying expected hashes', async () => {
  const expected = expectedRailValue('phase3b-write-5');
  for (const [name, reply, classification] of [
    ['preexisting', response(200, noteBody(expected.value)), 'PREEXISTING_UNATTRIBUTED_MATCH'],
    ['mismatch', response(200, noteBody('other-public-bytes')), 'PUBLIC_VALUE_MISMATCH'],
    ['huge', response(200, 'x'.repeat(70000)), 'PUBLIC_READ_INVALID'],
    ['wrong-type', response(200, JSON.stringify({ value: expected.value }), 'application/json'), 'PUBLIC_READ_INVALID'],
  ]) {
    const root = makeRoot(`phase3b-paper-${name}-`);
    try {
      const observed = await productionRailObserve('phase3b-write-5', { stateRoot: root, transport: async () => reply });
      assert.equal(observed.classification, classification);
      if (classification === 'PREEXISTING_UNATTRIBUTED_MATCH') {
        assert.equal(observed.observedValueSha256, sha256(Buffer.from(expected.value, 'utf8')));
        assert.equal(observed.exactValueMatch, true);
        assert.equal(observed.receiptPath, null);
      }
      if (classification === 'PUBLIC_VALUE_MISMATCH') {
        assert.equal(observed.observedValueSha256, sha256(Buffer.from('other-public-bytes', 'utf8')));
        assert.notEqual(observed.observedValueSha256, observed.expectedValueSha256);
      }
      if (classification === 'PUBLIC_READ_INVALID') assert.equal(observed.observedValueSha256, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('OBSERVED_PUBLIC requires a production receipt bound to operation, manifest, key, value and budget lineage', async () => {
  const root = makeRoot('phase3b-paper-receipt-');
  try {
    const id = 'phase3b-write-5'; const operation = railOperation(id); const expected = expectedRailValue(id);
    const receiptPath = resolve(root, `${id}-write-receipt.json`);
    const legacyObservationPath = resolve(root, `${id}-observation.json`);
    writeFileSync(legacyObservationPath, JSON.stringify({ operationId: id, classification: 'OBSERVED_PUBLIC', historical: true }));
    writeFileSync(receiptPath, `${JSON.stringify({ schema: 'tclk/phase3b-paper-rail-write-receipt/v1', production: true,
      operationId: id, manifestRoot: manifest.manifestRoot, key: operation.note,
      valueCommitment: operation.valueCommitment, expectedValueSha256: expected.expectedValueSha256,
      budgetId: 'fixture-production-budget-lineage', writtenAt: '2026-09-09T00:00:00.000Z' }, null, 2)}\n`);
    const observed = await productionRailObserve(id, { stateRoot: root,
      transport: async () => response(200, noteBody(expected.value)) });
    assert.equal(observed.classification, 'OBSERVED_PUBLIC');
    assert.equal(observed.receiptBudgetId, 'fixture-production-budget-lineage');
    assert.equal(observed.receiptSha256, sha256(readFileSync(receiptPath)));
    assert.equal(observed.observedValueSha256, expected.expectedValueSha256);
    assert.equal(observed.exactValueMatch, true);
    assert.equal(observed.observationPath, resolve(root, `${id}-production-observation.json`));
    assert.equal(JSON.parse(readFileSync(legacyObservationPath, 'utf8')).historical, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fixture receipt cannot satisfy the production observer', async () => {
  const root = makeRoot('phase3b-paper-fixture-isolation-');
  try {
    const id = 'phase3b-write-5'; const operation = railOperation(id); const expected = expectedRailValue(id);
    writeFileSync(resolve(root, `${id}-write-receipt.json`), JSON.stringify({
      schema: 'tclk/phase3b-paper-rail-write-receipt/v1', production: false, operationId: id,
      manifestRoot: manifest.manifestRoot, key: operation.note, valueCommitment: operation.valueCommitment,
      expectedValueSha256: expected.expectedValueSha256, budgetId: 'FIXTURE', writtenAt: '2026-09-09T00:00:00.000Z',
    }));
    await assert.rejects(productionRailObserve(id, { stateRoot: root,
      transport: async () => response(200, noteBody(expected.value)) }), /PAPERRAIL_RECEIPT_INVALID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('historical Rail5 false positive is preserved and quarantined by hashes', () => {
  const root = makeRoot('phase3b-paper-quarantine-');
  try {
    const historicalPath = resolve(root, 'phase3b-write-5.json');
    const observationPath = resolve(root, 'phase3b-write-5-observation.json');
    writeFileSync(historicalPath, JSON.stringify({ operationId: 'phase3b-write-5', historical: true }));
    writeFileSync(observationPath, JSON.stringify({ operationId: 'phase3b-write-5', classification: 'OBSERVED_PUBLIC' }));
    const oldHistorical = readFileSync(historicalPath); const oldObservation = readFileSync(observationPath);
    const reconciliation = quarantineHistoricalRailObservation('phase3b-write-5', { stateRoot: root });
    assert.equal(reconciliation.classification, 'FALSE_POSITIVE_OBSERVER_HISTORICAL');
    assert.equal(reconciliation.reason, 'NO_SUCCESSFUL_LOCAL_RAIL_WRITE_RECEIPT');
    assert.equal(reconciliation.historicalEvidenceSha256, sha256(oldHistorical));
    assert.equal(reconciliation.historicalObservationSha256, sha256(oldObservation));
    assert.deepEqual(readFileSync(historicalPath), oldHistorical);
    assert.deepEqual(readFileSync(observationPath), oldObservation);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production finalizer rejects old Rail5 OBSERVED_PUBLIC evidence without a receipt', () => {
  const root = makeRoot('phase3b-finalizer-old-rail-');
  const submit = resolve(root, 'submit'); const rail = resolve(root, 'rail'); mkdirSync(submit); mkdirSync(rail);
  try {
    for (const id of ['phase3b-write-1', 'phase3b-write-3', 'phase3b-write-4']) {
      writeFileSync(resolve(submit, `${id}-observation.json`), JSON.stringify({ operationId: id, classification: 'OBSERVED_PUBLIC' }));
    }
    writeFileSync(resolve(submit, 'phase3b-write-2-observation.json'), JSON.stringify({
      operationId: 'phase3b-write-2', classification: 'SERVER_APPENDED_THEN_NOT_RETAINED',
    }));
    writeFileSync(resolve(rail, 'phase3b-write-5-observation.json'), JSON.stringify({
      operationId: 'phase3b-write-5', classification: 'OBSERVED_PUBLIC', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false,
    }));
    assert.throws(() => finalizeProductionJourney({ submitStateRoot: submit, railStateRoot: rail,
      outputPath: resolve(root, 'capsule.json') }), /FINALIZE_MISSING_EVIDENCE|FINALIZE_PAPERRAIL_EVIDENCE_INVALID/);
    assert.equal(existsSync(resolve(root, 'capsule.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
