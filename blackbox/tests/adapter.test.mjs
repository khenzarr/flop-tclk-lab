// SPDX-License-Identifier: Apache-2.0
//
// CANONICAL SIGNER ADAPTER — verification suite.
//
// The adapter's only claim is that it is a courier, so most of these tests are refusals, and the
// strongest assertion in the file is a negative one: `transport.calls === 0`. A refusal that still
// touched the signer would not be a refusal.
//
// Nothing here is real. The transport is the published deterministic test vector, no canonical
// signer process is started, no operator is prompted, and no frame is posted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareFrame, sha256 } from '../airlock/prepare.mjs';
import { buildRequest, approveRequest, assertSafeEnvelope, AirlockLedger } from '../airlock/envelope.mjs';
import { TestVectorSigner, canonicalMessage } from '../airlock/signer.mjs';
import { outgoingAcceptFrame, CREATED_AT, SIGNED_AT } from '../airlock/dryrun.mjs';
import {
  signFrozenAirlockRequest,
  validateHandoff,
  acceptSignerResponse,
  signerChallenge,
  airlockToSignerBinding,
  custodySeal,
  dryRunSupport,
  AdapterEventLog,
  MockSignerTransport,
  MODES,
  ADAPTER_SCHEMA,
  ADOPTED_UPSTREAM_PIN,
  CANONICAL_SIGNER_PUBLIC_INTERFACE,
  TRUST_MODEL,
} from '../airlock/adapter.mjs';

const NOW = Date.parse(CREATED_AT) + 60_000;
const OTHER_DID = `did:key:z6Mk${'h'.repeat(44)}`;

const signer = new TestVectorSigner();

/** Builds a request for a DID, defaulting to the test vector's own. `frame` overrides let a
 *  distinct-but-valid request be minted, which is how a "new request id" is obtained honestly. */
const open = (frame = {}, did = signer.did) => {
  const request = buildRequest(prepareFrame({ ...outgoingAcceptFrame(did), ...frame }), { createdAt: CREATED_AT });
  return { request, approval: approveRequest(request, { approvedAt: CREATED_AT }) };
};

/** A transport that counts calls, so "the signer was never contacted" is testable, and can patch
 *  its own reply, so a hostile or buggy signer can be simulated without inventing key material.
 *
 *  Each transport gets a FRESH test-vector signer. The vector reserves nonces per instance, so
 *  sharing one across runs would make the reserved nonce depend on test order — and the nonce is
 *  inside the signed preimage, so the seal would appear non-deterministic when the adapter is
 *  perfectly deterministic. A fresh signer isolates each courier run. */
class CountingTransport extends MockSignerTransport {
  constructor(patch = null) {
    super(new TestVectorSigner());
    this.calls = 0;
    this.patch = patch;
  }


  signRoom(challenge) {
    this.calls += 1;
    const signed = super.signRoom(challenge);
    return this.patch ? this.patch({ ...signed }, challenge) : signed;
  }
}

const run = (frozen, options = {}) => {
  const transport = options.transport ?? new CountingTransport();
  const result = signFrozenAirlockRequest(frozen, { nowMs: NOW, signedAt: SIGNED_AT, ...options, transport });
  return { result, transport };
};

/** Every result, refusal or not, must satisfy the phase's standing invariants. */
const assertNothingEscaped = result => {
  assert.equal(result.schema, ADAPTER_SCHEMA);
  assert.equal(result.posted, false, 'POST_ELIGIBLE is never POSTED');
  assert.equal(result.publicPostingEnabled, false);
  assert.equal(result.realCanonicalSignerAccessed, false);
  assert.equal(result.realSignaturePerformed, false);
  assertSafeEnvelope({ ...result, events: [...result.events] });
};

// ── The trust model is stated, not implied ───────────────────────────────────────────────────

test('the adapter declares itself a courier and disclaims every authority it must not hold', () => {
  assert.ok(TRUST_MODEL.is.includes('courier'));
  for (const role of ['key custody', 'signing authority', 'identity authority', 'wallet', 'settlement rail', 'Technocore writer']) {
    assert.ok(TRUST_MODEL.isNot.includes(role), `${role} must be disclaimed`);
  }
  for (const secret of ['a private key', 'a seed', 'a passphrase', 'a decrypted key']) {
    assert.ok(TRUST_MODEL.neverHolds.includes(secret));
  }
  assert.match(CANONICAL_SIGNER_PUBLIC_INTERFACE, /sign_room\(room, text\)/);
});

// ── Translation: two public arguments, nothing more ──────────────────────────────────────────

test('the challenge is exactly the public interface: room and text, taken from the approval', () => {
  const { request, approval } = open();
  const challenge = signerChallenge(approval);
  assert.equal(challenge.room, approval.intendedRoom);
  assert.equal(challenge.text, approval.frozenPayload);
  assert.equal(challenge.text, request.canonicalPayload, 'the signer signs the approved bytes, not a rebuild');
  assert.equal(sha256(challenge.text), approval.canonicalHash);
  assert.deepEqual(Object.keys(challenge).sort(), ['canonicalHash', 'interfaceShape', 'requestId', 'room', 'signerDid', 'text']);
  assert.equal('nonce' in challenge, false, 'the nonce is reserved inside custody');
  assert.equal('passphrase' in challenge, false);
});

// ── The valid handoff ────────────────────────────────────────────────────────────────────────

test('a valid frozen request reaches POST_ELIGIBLE and returns only signature-shaped output', () => {
  const { result, transport } = run(open());
  assertNothingEscaped(result);
  assert.equal(result.stage, 'POST_ELIGIBLE');
  assert.equal(result.postEligible, true);
  assert.deepEqual(result.findings, []);
  assert.equal(transport.calls, 1);
  assert.deepEqual(result.events.map(e => e.code), [
    'PREPARED', 'REVIEWED', 'HANDOFF_ALLOWED', 'SIGNER_RESPONSE_RECEIVED', 'LOCALLY_VERIFIED', 'POST_ELIGIBLE',
  ]);
  assert.deepEqual(Object.keys(result.response).sort(), [
    'canonicalHash', 'nonce', 'requestId', 'responseFingerprint', 'room', 'schema',
    'signature', 'signedAt', 'signerDid', 'signerKind',
  ]);
});

test('the returned signature verifies over the exact frozen bytes, room and reserved nonce', () => {
  const { request, approval } = open();
  const { result } = run({ request, approval });
  const preimage = canonicalMessage(approval.intendedRoom, result.response.nonce, approval.frozenPayload);
  assert.equal(result.verification.signedPreimageHash, sha256(preimage));
  assert.equal(result.response.canonicalHash, request.canonicalHash);
  assert.equal(result.response.requestId, request.requestId);
  assert.equal(result.response.signerDid, request.signerDid);
});

// ── BYTE FREEZE end to end ───────────────────────────────────────────────────────────────────

test('the binding hash ties airlock bytes, adapter input, signer input and signature together', () => {
  const { request, approval } = open();
  const { result } = run({ request, approval });
  const b = result.binding;
  assert.equal(b.sameCanonicalPayload, true);
  assert.equal(b.airlockPayloadHash, approval.canonicalHash);
  assert.equal(b.returnedCanonicalHash, approval.canonicalHash);
  assert.equal(b.signedMessageHash, result.verification.signedPreimageHash);
  assert.match(b.hash, /^[0-9a-f]{64}$/);

  // Recomputable from the artifacts alone, and it moves when any layer moves.
  const recomputed = airlockToSignerBinding({
    request, approval, challenge: signerChallenge(approval),
    response: result.response, verification: result.verification,
  });
  assert.equal(recomputed.hash, b.hash);
  const elsewhere = airlockToSignerBinding({
    request, approval: { ...approval, intendedRoom: 'tclk-elsewhere' },
    challenge: signerChallenge({ ...approval, intendedRoom: 'tclk-elsewhere' }),
    response: result.response, verification: result.verification,
  });
  assert.notEqual(elsewhere.hash, b.hash);
});

// ── Pre-handoff refusals: the signer is never contacted ──────────────────────────────────────

const preHandoffCases = {
  'invalid airlock schema': ({ request, approval }) => [{ request: { ...request, schema: 'something-else/v9' }, approval }, 'AIRLOCK_SCHEMA_UNKNOWN'],
  'approval missing': ({ request }) => [{ request, approval: undefined }, 'APPROVAL_MISSING'],
  'operator acknowledgement blank': ({ request, approval }) => [{ request, approval: { ...approval, acknowledgement: '' } }, 'OPERATOR_APPROVAL_MISSING'],
  'byte freeze mismatch': ({ request, approval }) => [{ request, approval: { ...approval, frozenPayload: `${approval.frozenPayload} ` } }, 'PAYLOAD_MUTATED_AFTER_APPROVAL'],

  'wrong canonical hash': ({ request, approval }) => [{ request: { ...request, canonicalHash: 'a'.repeat(64) }, approval }, 'CANONICAL_HASH_DOES_NOT_COVER_PAYLOAD'],
  'malformed signer DID': ({ request, approval }) => [{ request: { ...request, signerDid: 'did:web:example.com' }, approval }, 'SIGNER_DID_MALFORMED'],
  'upstream pin mismatch': ({ request, approval }) => [{ request: { ...request, upstream: { ...request.upstream, sha: 'f'.repeat(40) } }, approval }, 'UPSTREAM_PIN_NOT_ADOPTED'],
  'request claims posting enabled': ({ request, approval }) => [{ request: { ...request, publicPostingEnabled: true }, approval }, 'REQUEST_CLAIMS_POSTING_ENABLED'],
  'secret smuggled into the request': ({ request, approval }) => [{ request: { ...request, mnemonic: 'x' }, approval }, 'UNSAFE_REQUEST_FIELD'],
};

for (const [name, mutate] of Object.entries(preHandoffCases)) {
  test(`${name}: refused before the boundary, signer never contacted`, () => {
    const [frozen, expected] = mutate(open());
    const { result, transport } = run(frozen);
    assertNothingEscaped(result);
    assert.equal(result.stage, 'HANDOFF_REFUSED');
    assert.equal(result.postEligible, false);
    assert.equal(result.signerContacted, false);
    assert.equal(transport.calls, 0, 'a refusal must not reach the signer');
    assert.ok(result.findings.some(f => f.startsWith(expected)), `expected ${expected}, got ${result.findings.join(',')}`);
    assert.equal(result.custodySeal, null);
    assert.equal(result.events.at(-1).code, 'HANDOFF_REFUSED');
  });
}

test('a stale request is refused before the boundary even though it is otherwise perfect', () => {
  const frozen = open();
  const { result, transport } = run(frozen, { nowMs: Date.parse(frozen.request.expiresAt) + 1 });
  assert.equal(transport.calls, 0);
  assert.ok(result.findings.includes('REQUEST_EXPIRED'));
  assert.equal(result.postEligible, false);
});

test('a request whose fingerprint no longer covers its fields is refused', () => {
  const { request, approval } = open();
  const payload = request.canonicalPayload.replace(/"nonce":"\w+"/, '"nonce":"9999999999999999"');
  const forged = { ...request, canonicalPayload: payload, canonicalHash: sha256(payload) };
  const { result, transport } = run({ request: forged, approval });
  assert.equal(transport.calls, 0);
  assert.ok(result.findings.includes('REQUEST_FINGERPRINT_BROKEN'));
});

// ── TOCTOU: mutation between approval and handoff ────────────────────────────────────────────

test('TOCTOU: any post-approval mutation invalidates approval and blocks the signer', () => {
  const mutations = {
    canonicalPayload: ['PAYLOAD_MUTATED_AFTER_APPROVAL', r => {
      const p = r.canonicalPayload.replace(/"nonce":"\w+"/, '"nonce":"8888888888888888"');
      return { ...r, canonicalPayload: p, canonicalHash: sha256(p) };
    }],
    signerDid: ['SIGNER_CHANGED_AFTER_APPROVAL', r => ({ ...r, signerDid: OTHER_DID })],
    intendedRoom: ['DESTINATION_ROOM_CHANGED_AFTER_APPROVAL', r => ({ ...r, intendedRoom: 'tclk-elsewhere' })],
    intendedOperation: ['OPERATION_CHANGED_AFTER_APPROVAL', r => ({ ...r, intendedOperation: 'create_room' })],
    upstreamPin: ['UPSTREAM_PIN_CHANGED_AFTER_APPROVAL', r => ({ ...r, upstream: { ...r.upstream, sha: '0'.repeat(40) } })],
  };
  for (const [field, [expected, mutate]] of Object.entries(mutations)) {
    const { request, approval } = open();
    const { result, transport } = run({ request: mutate(request), approval });
    assert.equal(transport.calls, 0, `${field}: signer contacted after a TOCTOU mutation`);
    assert.equal(result.postEligible, false, field);
    assert.ok(result.findings.includes(expected), `${field}: expected ${expected}, got ${result.findings.join(',')}`);
    assert.ok(result.findings.includes('BYTE_FREEZE_BROKEN'), `${field}: freeze not reported`);
  }
});

test('TOCTOU: the mutated intent can only proceed under a new request id', () => {
  const { request } = open();
  const reissued = buildRequest(
    prepareFrame({ ...outgoingAcceptFrame(signer.did), nonce: '8888888888888888' }),
    { createdAt: CREATED_AT },
  );
  assert.notEqual(reissued.requestId, request.requestId);
  const { result } = run({ request: reissued, approval: approveRequest(reissued, { approvedAt: CREATED_AT }) });
  assert.equal(result.postEligible, true, 'a freshly approved request is the only way forward');
});

// ── Duplicate / replay guard (local operator safety only) ────────────────────────────────────

test('the same envelope cannot be couriered twice', () => {
  const frozen = open();
  const ledger = new AirlockLedger();
  const first = run(frozen, { ledger });
  assert.equal(first.result.postEligible, true);
  const second = run(frozen, { ledger });
  assert.equal(second.result.postEligible, false);
  assert.equal(second.transport.calls, 0, 'a replayed envelope must not reach the signer again');
  assert.ok(second.result.findings.includes('REQUEST_ALREADY_COMPLETED'));
  assert.equal(second.result.events.at(-1).code, 'DUPLICATE_REQUEST_REFUSED');
});

test('the same payload under a new request id is allowed, and produces a different seal', () => {
  const ledger = new AirlockLedger();
  const first = run(open(), { ledger }).result;
  const other = buildRequest(prepareFrame({ ...outgoingAcceptFrame(signer.did), nonce: '7777777777777777' }), { createdAt: CREATED_AT });
  const second = run({ request: other, approval: approveRequest(other, { approvedAt: CREATED_AT }) }, { ledger }).result;
  assert.equal(second.postEligible, true);
  assert.notEqual(second.custodySeal.digest, first.custodySeal.digest);
});

// ── Hostile signer responses ─────────────────────────────────────────────────────────────────

test('a response carrying custody-shaped material fails closed and its value is never logged', () => {
  for (const field of ['privateKey', 'seed', 'mnemonic', 'passphrase', 'secretKey', 'decryptedKey']) {
    const { result, transport } = run(open(), {
      transport: new CountingTransport(signed => ({ ...signed, [field]: 'SHOULD-NEVER-APPEAR' })),
    });
    assert.equal(transport.calls, 1);
    assert.equal(result.postEligible, false, field);
    assert.equal(result.stage, 'SIGNER_RESPONSE_REFUSED', field);
    assert.ok(result.findings.some(f => f.startsWith('CUSTODY_MATERIAL_IN_SIGNER_RESPONSE')), field);
    assert.ok(!JSON.stringify(result).includes('SHOULD-NEVER-APPEAR'), `${field}: value echoed back`);
    assert.equal(result.response, null);
  }
});

test('acceptSignerResponse refuses custody names by name, before any value is read', () => {
  const getter = { get privateKey() { throw new Error('the value must never be read'); } };
  Object.defineProperty(getter, 'requestId', { value: 'x', enumerable: true });
  const outcome = acceptSignerResponse(getter);
  assert.equal(outcome.ok, false);
  assert.match(outcome.code, /^CUSTODY_MATERIAL_IN_SIGNER_RESPONSE/);
  assert.equal(acceptSignerResponse(null).code, 'SIGNER_RESPONSE_NOT_AN_OBJECT');
  assert.equal(acceptSignerResponse([]).code, 'SIGNER_RESPONSE_NOT_AN_OBJECT');
});

test('a response with an unexpected non-secret field is refused too', () => {
  const { result } = run(open(), { transport: new CountingTransport(signed => ({ ...signed, extra: 'hello' })) });
  assert.equal(result.postEligible, false);
  assert.ok(result.findings.some(f => f.startsWith('SIGNER_RESPONSE_REJECTED')));
});

const responseAbuse = {
  'malformed signature': [signed => ({ ...signed, signature: 'not base64url!!' }), null],
  'empty signature': [signed => ({ ...signed, signature: '' }), null],
  'wrong signature': [signed => ({ ...signed, signature: `${'A'.repeat(85)}B` }), 'SIGNATURE_DOES_NOT_VERIFY_OVER_APPROVED_BYTES'],
  'nonce the signer did not use': [signed => ({ ...signed, nonce: 99 }), 'SIGNATURE_DOES_NOT_VERIFY_OVER_APPROVED_BYTES'],
  'response canonical hash mismatch': [signed => ({ ...signed, canonicalHash: sha256('other bytes') }), 'RESPONSE_CANONICAL_HASH_MISMATCH'],
  'response signer DID mismatch': [signed => ({ ...signed, signerDid: OTHER_DID }), 'RESPONSE_SIGNER_DID_MISMATCH'],
  'response destination room mismatch': [signed => ({ ...signed, room: 'tclk-elsewhere' }), 'RESPONSE_DESTINATION_ROOM_MISMATCH'],
};

for (const [name, [patch, expected]] of Object.entries(responseAbuse)) {
  test(`${name}: local verification refuses and nothing becomes post eligible`, () => {
    const { result } = run(open(), { transport: new CountingTransport(patch) });
    assertNothingEscaped(result);
    assert.equal(result.postEligible, false);
    assert.equal(result.custodySeal, null, 'no seal without local verification');
    if (expected) assert.ok(result.findings.includes(expected), `expected ${expected}, got ${result.findings.join(',')}`);
    else assert.ok(result.findings.length > 0, 'a refusal must state a reason');
    assert.ok(result.events.map(e => e.code).some(c => c === 'LOCAL_VERIFY_FAILED' || c === 'SIGNER_RESPONSE_REFUSED'));
  });
}

test('a response for another request id is refused as confusion', () => {
  const other = buildRequest(prepareFrame({ ...outgoingAcceptFrame(signer.did), nonce: '6666666666666666' }), { createdAt: CREATED_AT });
  const { result } = run(open(), { transport: new CountingTransport(signed => ({ ...signed, requestId: other.requestId })) });
  assert.equal(result.postEligible, false);
  assert.ok(result.findings.includes('RESPONSE_REQUEST_ID_MISMATCH'));
});

test('a signer that declines is reported as a refusal, not retried or worked around', () => {
  // Minted and approved for a DID this signer does not hold, so the request is internally
  // consistent and BYTE FREEZE holds. The refusal has to come from custody declining a DID it
  // does not own, which is custody's decision to make and not the adapter's to work around.
  const { result, transport } = run(open({}, OTHER_DID));

  assert.equal(transport.calls, 1);
  assert.equal(result.stage, 'SIGNER_REFUSED');
  assert.deepEqual(result.findings, ['SIGNER_DECLINED_THE_CHALLENGE']);
  assert.equal(result.events.at(-1).code, 'SIGNER_REFUSED');
});

// ── Custody seal ─────────────────────────────────────────────────────────────────────────────

test('the custody seal is deterministic and displayable', () => {
  const first = run(open()).result.custodySeal;
  const second = run(open()).result.custodySeal;
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.match(first.display, /^CS1(-[0-9A-F]{4}){6}$/);
  assert.equal(first.bindingHash, run(open()).result.binding.hash);
});

test('the seal moves when any bound artifact moves', () => {
  const { request, approval } = open();
  const { result } = run({ request, approval });
  const base = { request, approval, response: result.response, verification: result.verification, binding: result.binding };
  const variants = [
    { ...base, response: { ...base.response, responseFingerprint: 'b'.repeat(64) } },
    { ...base, approval: { ...base.approval, intendedRoom: 'tclk-elsewhere' } },
    { ...base, binding: { ...base.binding, hash: 'c'.repeat(64) } },
    { ...base, verification: { ...base.verification, signedPreimageHash: 'd'.repeat(64) } },
  ];
  for (const variant of variants) assert.notEqual(custodySeal(variant).digest, result.custodySeal.digest);
});

test('the seal states its narrow meaning and disclaims the rest', () => {
  const seal = run(open()).result.custodySeal;
  assert.match(seal.means, /bound to the same approved canonical payload/);
  for (const claim of ['a trusted human', 'economic settlement', 'FLOP eligibility', 'official FLOP verification']) {
    assert.ok(seal.doesNotMean.includes(claim), `${claim} must be disclaimed`);
  }
  assert.ok(!JSON.stringify(seal).includes(run(open()).result.response.signature), 'the seal must not republish the signature');
});

// ── Modes ────────────────────────────────────────────────────────────────────────────────────

test('REAL_INTERFACE_DRY_RUN reports NOT_SUPPORTED and does not invoke the signer', () => {
  const transport = new CountingTransport();
  const result = signFrozenAirlockRequest(open(), { mode: MODES.REAL_INTERFACE_DRY_RUN, transport, nowMs: NOW });
  assertNothingEscaped(result);
  assert.equal(result.stage, 'REAL_INTERFACE_DRY_RUN_NOT_SUPPORTED');
  assert.equal(transport.calls, 0);
  assert.equal(result.dryRun.supported, false);
  assert.equal(result.dryRun.signatureRequested, false);
  assert.equal(result.postEligible, false);
  assert.equal(dryRunSupport(transport).supported, false);
  assert.equal(dryRunSupport(null).supported, false);
});

test('a dry run that would actually sign is refused as not a dry run', () => {
  const transport = new CountingTransport();
  transport.dryRun = () => ({ accepted: true, willSign: true });
  const result = signFrozenAirlockRequest(open(), { mode: MODES.REAL_INTERFACE_DRY_RUN, transport, nowMs: NOW });
  assert.equal(result.stage, 'REAL_INTERFACE_DRY_RUN_REFUSED');
  assert.equal(transport.calls, 0);
  assert.ok(result.findings.includes('DRY_RUN_RETURNED_SIGNING_MATERIAL'));
});

test('a non-signing dry run reports compatibility without a signature', () => {
  const transport = new CountingTransport();
  transport.dryRun = challenge => ({ accepted: typeof challenge.room === 'string' && typeof challenge.text === 'string' });
  const result = signFrozenAirlockRequest(open(), { mode: MODES.REAL_INTERFACE_DRY_RUN, transport, nowMs: NOW });
  assert.equal(result.stage, 'REAL_INTERFACE_DRY_RUN_COMPATIBLE');
  assert.equal(result.dryRun.accepted, true);
  assert.equal(result.dryRun.signatureRequested, false);
  assert.equal(result.postEligible, false, 'a dry run is never post eligible');
  assert.equal(transport.calls, 0, 'compatibility must not cost a signature');
});

test('MOCK mode refuses a transport that claims to be the real canonical signer', () => {
  const transport = new CountingTransport();
  transport.real = true;
  const result = signFrozenAirlockRequest(open(), { transport, nowMs: NOW });
  assert.equal(transport.calls, 0);
  assert.ok(result.findings.includes('REAL_SIGNER_NOT_PERMITTED_IN_THIS_PHASE'));
  assert.equal(result.realCanonicalSignerAccessed, false);
});

test('an incompatible transport is refused rather than coerced', () => {
  const result = signFrozenAirlockRequest(open(), { transport: { real: false }, nowMs: NOW });
  assert.ok(result.findings.includes('TRANSPORT_INTERFACE_INCOMPATIBLE'));
  assert.equal(result.signerContacted, false);
});

test('an unknown mode is refused', () => {
  const { request, approval } = open();
  const gate = validateHandoff(request, approval, { nowMs: NOW, mode: 'YOLO' });
  assert.equal(gate.ok, false);
  assert.ok(gate.findings.includes('ADAPTER_MODE_UNKNOWN'));
});

// ── The event log ────────────────────────────────────────────────────────────────────────────

test('the event log admits only permitted codes and only reference-sized values', () => {
  const log = new AdapterEventLog();
  assert.throws(() => log.record('POSTED_TO_TECHNOCORE'), /not a permitted event code/);
  assert.throws(() => log.record('PREPARED', { passphrase: 'hunter2' }), /unsafe field/);
  assert.throws(() => log.record('PREPARED', { blob: 'x'.repeat(129) }), /too long to be a reference/);
  log.record('PREPARED', { requestId: 'alr1-' + '0'.repeat(32) });
  assert.deepEqual(log.codes(), ['PREPARED']);
  assert.equal(log.events[0].seq, 1);
});

test('no adapter event carries anything but codes, ids, hashes and counts', () => {
  const { result } = run(open());
  for (const event of result.events) {
    for (const [key, value] of Object.entries(event)) {
      if (key === 'seq' || key === 'code') continue;
      assert.ok(
        value === null || typeof value === 'boolean' || typeof value === 'number' || /^[\w:.-]{1,128}$/.test(String(value)),
        `event ${event.code} field ${key} does not look like a safe reference`,
      );
    }
  }
});

// ── Standing phase invariants ────────────────────────────────────────────────────────────────

test('POST_ELIGIBLE is not POSTED, and the statement says so', () => {
  const { result } = run(open());
  assert.equal(result.postEligible, true);
  assert.equal(result.posted, false);
  assert.equal(result.eligibility.posted, false);
  assert.equal(result.eligibility.publicPostingEnabled, false);
  assert.match(result.statement, /Nothing was sent to Technocore/);
});

test('the adapter only ever couriers the adopted pin', () => {
  assert.equal(ADOPTED_UPSTREAM_PIN, 'd48e87343200e3115e243df39e8f295f5ce2e645');
  assert.equal(run(open()).result.response.canonicalHash, open().request.canonicalHash);
  assert.equal(open().request.upstream.sha, ADOPTED_UPSTREAM_PIN);
});

test('no adapter artifact contains secret-shaped material, refusal or success', () => {
  const outcomes = [
    run(open()).result,
    run({ request: open().request, approval: undefined }).result,
    run(open(), { transport: new CountingTransport(signed => ({ ...signed, signature: 'A'.repeat(86) })) }).result,
  ];
  for (const outcome of outcomes) assertSafeEnvelope({ ...outcome, events: [...outcome.events] });
});
