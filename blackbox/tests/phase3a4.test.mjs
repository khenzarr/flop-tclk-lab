import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRehearsalAccept, assertNonReuse, phase3bFootprint } from '../airlock/rehearsal.mjs';
import {
  AUDITED_SIGNER_SIDE_EFFECT_CLASS,
  MAX_REAL_SIGNATURES,
  RealSignatureBudget,
  gateA,
} from '../airlock/budget.mjs';

test('synthetic accept is deterministic and non-reusable with Phase 3B', () => {
  const one = buildRehearsalAccept();
  const two = buildRehearsalAccept();
  assert.equal(one.frameType, 'accept');
  assert.deepEqual(one.frame, two.frame);
  assert.equal(one.room, two.room);
  const result = assertNonReuse({
    room: one.room,
    contractId: one.contractId,
    canonicalHash: 'not-the-preview-hash',
    requestId: 'alr1-offline-rehearsal-000000000000',
    requestFingerprint: 'offline-rehearsal-fingerprint',
  }, phase3bFootprint());
  assert.equal(result.ok, true);
});

test('Gate A refuses the audited durable nonce mutation', () => {
  const result = gateA(AUDITED_SIGNER_SIDE_EFFECT_CLASS);
  assert.equal(result.ok, false);
  assert.equal(result.safeToInvoke, false);
  assert.equal(result.sideEffectClass, 'DURABLE_NONCE_OR_PROTOCOL_STATE');
});

test('real signature budget permits exactly one and refuses a second', () => {
  const budget = new RealSignatureBudget();
  assert.equal(MAX_REAL_SIGNATURES, 1);
  budget.consume('test-only permit');
  assert.throws(() => budget.consume('forbidden retry'), /MAX_REAL_SIGNATURES=1/);
  assert.equal(budget.consumed, 1);
});

test('operator-only entrypoint has no signer or posting path', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../airlock/real-offline-sign.mjs', import.meta.url), 'utf8');
  assert.match(source, /FLOPLAB_PHASE3A4_MODE/);
  assert.match(source, /GATE A REFUSED/);
  assert.doesNotMatch(source, /fetch\(|axios|https?:\/\//i);
  assert.doesNotMatch(source, /sign_room|signRoom|Signer/);
});