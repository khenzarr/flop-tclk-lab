// SPDX-License-Identifier: Apache-2.0
//
// SIGNATURE AIRLOCK — verification suite.
//
// Every test here is offline and keyless: the only signer is the published test vector, no room
// is contacted, and nothing is posted. The suite's job is to prove the doors stay shut, so most
// assertions are refusals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareFrame, sha256, AIRLOCK_REQUEST_SCHEMA, AIRLOCK_RESPONSE_SCHEMA } from '../airlock/prepare.mjs';
import { buildRequest, approveRequest, assertSafeEnvelope, checkByteFreeze, fingerprintRequest, requestIsIntact, AirlockLedger } from '../airlock/envelope.mjs';
import { TestVectorSigner, canonicalMessage, verifyEd25519, publicKeyFromDidKey, base58Encode } from '../airlock/signer.mjs';

import { buildResponse, verifyResponse, postEligibility } from '../airlock/verify.mjs';
import { scenarios, runAll, outgoingAcceptFrame, footprintPreview, CREATED_AT, SIGNED_AT } from '../airlock/dryrun.mjs';

const NOW = Date.parse(CREATED_AT);
const LATER = NOW + 60000;
const url = name => new URL(`../../schemas/${name}`, import.meta.url);
const requestSchema = JSON.parse(readFileSync(url('signature-airlock-request.schema.json'), 'utf8'));
const responseSchema = JSON.parse(readFileSync(url('signature-airlock-response.schema.json'), 'utf8'));

/** A deliberately small draft-2020-12 subset checker: enough to hold the envelopes honest. */
function validate(schema, value, path = '$', errors = []) {
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected const ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not in enum`);
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return errors.push(`${path}: not an object`), errors;
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: missing`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) errors.push(`${path}.${key}: additional property`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) validate(child, value[key], `${path}.${key}`, errors);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return errors.push(`${path}: not an array`), errors;
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    value.forEach((item, index) => schema.items && validate(schema.items, item, `${path}[${index}]`, errors));
  } else if (type === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: not a string`);
    else {
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    }
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path}: not an integer`);
    else {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
    }
  } else if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: not a boolean`);
  return errors;
}

const signer = new TestVectorSigner();
const open = () => {
  const prepared = prepareFrame(outgoingAcceptFrame(signer.did));
  const request = buildRequest(prepared, { createdAt: CREATED_AT });
  return { prepared, request, approval: approveRequest(request, { approvedAt: CREATED_AT }) };
};
const signOf = request => signer.signApprovedChallenge({
  requestId: request.requestId,
  canonicalPayload: request.canonicalPayload,
  canonicalHash: request.canonicalHash,
  signerDid: request.signerDid,
  room: request.intendedRoom,
});
const responseOf = request => buildResponse(signOf(request), { signedAt: SIGNED_AT });

// ── STAGE 1–2: preparation and the request envelope ──────────────────────────────────────────

test('prepared frame carries upstream canonical bytes, a hash that covers them, and no nonce', () => {
  const { prepared } = open();
  assert.equal(prepared.stage, 'PREPARED');
  assert.equal(prepared.frameType, 'accept');
  assert.equal(prepared.canonicalHash, sha256(prepared.canonicalPayload));
  assert.equal(prepared.nonceOwner, 'TRUSTED_LOCAL_SIGNER');
  assert.equal(prepared.sweepIsIdentity, true);
  assert.equal('nonce' in prepared, false, 'the airlock must not choose the room-message nonce');
  assert.match(prepared.warnings.join(' '), /PUBLIC POSTING DISABLED/);
});

test('request envelope validates against the published schema and is deterministic', () => {
  const first = open().request;
  const second = open().request;
  assert.deepEqual(validate(requestSchema, first), []);
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.requestFingerprint, fingerprintRequest(first));
  assert.equal(first.schema, AIRLOCK_REQUEST_SCHEMA);
  assert.equal(first.publicPostingEnabled, false);
});

test('a request for a different frame gets a different id', () => {
  const { request } = open();
  const other = buildRequest(prepareFrame({ ...outgoingAcceptFrame(signer.did), nonce: '2122232425262728' }), { createdAt: CREATED_AT });
  assert.notEqual(request.requestId, other.requestId);
});

test('the human reading is advisory and the bytes are separate', () => {
  const { request } = open();
  assert.ok(request.human.meaning.length > 0);
  assert.ok(request.human.fields.some(f => f.label === 'Destination room' && f.value === request.intendedRoom));
  assert.ok(!request.canonicalPayload.includes(request.human.meaning));
});

test('preparation refuses a frame upstream would not encode, and a forbidden operation', () => {
  // Upstream schema validation runs first — the airlock never gets to fingerprint a frame TCLK
  // itself would reject, so these refusals carry upstream's wording.
  assert.throws(() => prepareFrame({ type: 'accept', from: signer.did, ref: '0x1', statement: '0x2', nonce: '0102030405060708' }), /missing field on accept: contract/);
  assert.throws(() => prepareFrame({ type: 'lock', contract: '0xabc', rail: 'paper', ref: 'r' }), /missing field on lock: from/);
  assert.throws(() => prepareFrame({ type: 'nope', from: signer.did, contract: '0xabc' }), /unknown frame type/);
  assert.throws(() => prepareFrame(outgoingAcceptFrame(signer.did), { operation: 'create_room' }), /not permitted/);
});


// ── The secret sentinel ──────────────────────────────────────────────────────────────────────

test('the sentinel rejects unsafe field names anywhere in an envelope', () => {
  assert.throws(() => assertSafeEnvelope({ ok: 1, nested: { seed: 'x' } }), /unsafe field at \$\.nested\.seed/);
  assert.throws(() => assertSafeEnvelope({ list: [{ privateKey: 'x' }] }), /unsafe field at \$\.list\[0\]\.privateKey/);
  assert.throws(() => assertSafeEnvelope({ passphrase: 'x' }), /unsafe field/);
  assert.throws(() => assertSafeEnvelope({ preimage: 'x' }), /unsafe field/);
});

test('the sentinel rejects secret-shaped values hiding behind innocent keys', () => {
  assert.throws(() => assertSafeEnvelope({ note: '-----BEGIN PRIVATE KEY-----abc' }), /category PEM_PRIVATE_KEY/);
  assert.throws(() => assertSafeEnvelope({ note: 'abandon '.repeat(11) + 'about' }), /category MNEMONIC_PHRASE/);
  assert.throws(() => assertSafeEnvelope({ note: `xprv${'9'.repeat(40)}` }), /category EXTENDED_PRIVATE_KEY/);
  assert.throws(() => assertSafeEnvelope({ note: `AQAAA${'B'.repeat(48)}` }), /category DPAPI_BLOB/);
});

test('the sentinel names the path and category but never the value', () => {
  try {
    assertSafeEnvelope({ outer: { mnemonic: 'correct horse battery staple' } });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.match(error.message, /\$\.outer\.mnemonic/);
    assert.ok(!error.message.includes('correct horse'), 'a refusal must not echo the value');
  }
});

test('an unsafe field injected into a response is refused before it is trusted', () => {
  const { request, approval } = open();
  const response = { ...responseOf(request), seed: 'injected' };
  const verification = verifyResponse(request, approval, response, { nowMs: LATER });
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.some(f => f.startsWith('UNSAFE_RESPONSE_FIELD')));
});

// ── STAGE 3 and BYTE FREEZE ──────────────────────────────────────────────────────────────────

test('approval records the acknowledgement and its own copy of the bytes', () => {
  const { request, approval } = open();
  assert.equal(approval.acknowledgement, 'I APPROVE THESE EXACT CANONICAL BYTES');
  assert.equal(approval.frozenPayload, request.canonicalPayload);
  assert.equal(checkByteFreeze(request, approval).ok, true);
});

test('BYTE FREEZE: any post-approval edit to a meaning-bearing field breaks the freeze', () => {
  const { request, approval } = open();
  const edits = {
    canonicalPayload: [request.canonicalPayload.replace(/"nonce":"\w+"/, '"nonce":"9999999999999999"'), 'PAYLOAD_MUTATED_AFTER_APPROVAL'],
    signerDid: [`did:key:z6Mk${'h'.repeat(44)}`, 'SIGNER_CHANGED_AFTER_APPROVAL'],
    intendedRoom: ['tclk-elsewhere', 'DESTINATION_ROOM_CHANGED_AFTER_APPROVAL'],
    intendedOperation: ['create_room', 'OPERATION_CHANGED_AFTER_APPROVAL'],
  };
  for (const [field, [value, expected]] of Object.entries(edits)) {
    const mutated = { ...request, [field]: value };
    const freeze = checkByteFreeze(mutated, approval);
    assert.equal(freeze.ok, false, `${field} should break BYTE FREEZE`);
    assert.ok(freeze.findings.includes('BYTE_FREEZE_BROKEN'), `${field}: fingerprint drift not reported`);
    assert.ok(freeze.findings.includes(expected), `${field}: expected ${expected}, got ${freeze.findings.join(',')}`);
  }
});

test('BYTE FREEZE: a changed upstream pin invalidates the approval', () => {
  const { request, approval } = open();
  const repinned = { ...request, upstream: { ...request.upstream, sha: 'f'.repeat(40) } };
  const freeze = checkByteFreeze(repinned, approval);
  assert.equal(freeze.ok, false);
  assert.ok(freeze.findings.includes('UPSTREAM_PIN_CHANGED_AFTER_APPROVAL'));
});

test('a mutated request produces a different request id, so a new review is required', () => {
  const { request } = open();
  const mutatedPayload = request.canonicalPayload.replace(/"nonce":"\w+"/, '"nonce":"9999999999999999"');
  const mutated = { ...request, canonicalPayload: mutatedPayload, canonicalHash: sha256(mutatedPayload) };
  assert.equal(requestIsIntact(mutated), false);
  const reissued = buildRequest(prepareFrame({ ...outgoingAcceptFrame(signer.did), nonce: '9999999999999999' }), { createdAt: CREATED_AT });
  assert.notEqual(reissued.requestId, request.requestId);
  assert.throws(() => approveRequest(mutated), /fingerprint does not match/);
});

test('a tampered approval record is detected', () => {
  const { request, approval } = open();
  const forged = { ...approval, approvedBy: 'operator:someone-else' };
  assert.ok(checkByteFreeze(request, forged).findings.includes('APPROVAL_TAMPERED'));
});

// ── STAGE 4: the signer boundary ─────────────────────────────────────────────────────────────

test('the signer refuses a challenge whose hash does not cover its payload', () => {
  const { request } = open();
  assert.throws(() => signer.signApprovedChallenge({
    requestId: request.requestId, canonicalPayload: request.canonicalPayload,
    canonicalHash: 'a'.repeat(64), signerDid: signer.did, room: request.intendedRoom,
  }), /does not cover/);
});

test('the signer refuses a DID it does not hold', () => {
  const { request } = open();
  assert.throws(() => signer.signApprovedChallenge({
    requestId: request.requestId, canonicalPayload: request.canonicalPayload,
    canonicalHash: request.canonicalHash, signerDid: `did:key:z6Mk${'h'.repeat(44)}`, room: request.intendedRoom,
  }), /does not hold the requested DID/);
});

test('the signer reserves a fresh nonce per room and never returns key material', () => {
  const local = new TestVectorSigner();
  const { request } = open();
  const challenge = {
    requestId: request.requestId, canonicalPayload: request.canonicalPayload,
    canonicalHash: request.canonicalHash, signerDid: local.did, room: request.intendedRoom,
  };
  const first = local.signApprovedChallenge(challenge);
  const second = local.signApprovedChallenge(challenge);
  assert.equal(first.nonce, 1);
  assert.equal(second.nonce, 2);
  assert.notEqual(first.signature, second.signature, 'a reserved nonce must change the preimage');
  assert.deepEqual(Object.keys(first).sort(), ['canonicalHash', 'nonce', 'requestId', 'room', 'signature', 'signerDid', 'signerKind']);
  assert.ok(!JSON.stringify(first).includes('PRIVATE'));
});

test('the signed preimage is exactly room|nonce|payload', () => {
  const { request } = open();
  const signed = signOf(request);
  const preimage = canonicalMessage(request.intendedRoom, signed.nonce, request.canonicalPayload);
  assert.equal(preimage, `${request.intendedRoom}|${signed.nonce}|${request.canonicalPayload}`);
  assert.equal(verifyEd25519(signer.did, preimage, signed.signature), true);
});

// ── STAGE 5–6: the response envelope and local verification ──────────────────────────────────

test('response envelope validates against the published schema', () => {
  const { request } = open();
  assert.deepEqual(validate(responseSchema, responseOf(request)), []);
});

test('buildResponse refuses to carry fields the envelope does not accept', () => {
  const { request } = open();
  assert.throws(() => buildResponse({ ...signOf(request), privateKey: 'x' }), /does not accept/);
});

test('a clean handoff verifies and reports the exact preimage it checked', () => {
  const { request, approval } = open();
  const response = responseOf(request);
  const verification = verifyResponse(request, approval, response, { nowMs: LATER });
  assert.deepEqual(verification.findings, []);
  assert.equal(verification.verified, true);
  assert.equal(verification.stage, 'LOCALLY_VERIFIED');
  assert.equal(verification.signedPreimageHash, sha256(canonicalMessage(approval.intendedRoom, response.nonce, approval.frozenPayload)));
});

test('signature confusion: a signature for another request id is refused', () => {
  const { request, approval } = open();
  const other = buildRequest(prepareFrame({ ...outgoingAcceptFrame(signer.did), nonce: '3132333435363738' }), { createdAt: CREATED_AT });
  const response = { ...responseOf(request), requestId: other.requestId };
  const verification = verifyResponse(request, approval, response, { nowMs: LATER });
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.includes('RESPONSE_REQUEST_ID_MISMATCH'));
  assert.ok(verification.findings.includes('RESPONSE_TAMPERED'));
});

test('signature confusion: a valid signature over a different canonical hash is refused', () => {
  const { request, approval } = open();
  const response = { ...responseOf(request), canonicalHash: sha256('different bytes entirely') };
  const verification = verifyResponse(request, approval, response, { nowMs: LATER });
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.includes('RESPONSE_CANONICAL_HASH_MISMATCH'));
});

test('signature confusion: a valid signature with changed destination metadata is refused', () => {
  const { request, approval } = open();
  const elsewhere = signer.signApprovedChallenge({
    requestId: request.requestId, canonicalPayload: request.canonicalPayload,
    canonicalHash: request.canonicalHash, signerDid: signer.did, room: 'tclk-elsewhere',
  });
  const verification = verifyResponse(request, approval, buildResponse(elsewhere, { signedAt: SIGNED_AT }), { nowMs: LATER });
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.includes('RESPONSE_DESTINATION_ROOM_MISMATCH'));
  assert.ok(verification.findings.includes('SIGNATURE_DOES_NOT_VERIFY_OVER_APPROVED_BYTES'), 'the room is inside the signed preimage');
});

test('signature confusion: a malformed signature is refused without throwing', () => {
  const { request, approval } = open();
  for (const signature of ['', 'not base64url!!', 'A'.repeat(85), 'A'.repeat(86)]) {
    const verification = verifyResponse(request, approval, { ...responseOf(request), signature }, { nowMs: LATER });
    assert.equal(verification.verified, false);
    assert.equal(verification.signatureValid, false);
  }
});

test('signature confusion: a nonce the signer did not use is refused', () => {
  const { request, approval } = open();
  const response = { ...responseOf(request), nonce: 99 };
  const verification = verifyResponse(request, approval, response, { nowMs: LATER });
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.includes('SIGNATURE_DOES_NOT_VERIFY_OVER_APPROVED_BYTES'));
});

test('an envelope loaded against a different upstream pin is refused', () => {
  const { request, approval } = open();
  const repinned = { ...request, upstream: { ...request.upstream, sha: '0'.repeat(40) } };
  const verification = verifyResponse(repinned, approval, responseOf(request), { nowMs: LATER });
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.includes('UPSTREAM_PIN_CHANGED_AFTER_APPROVAL'));
});

test('an expired request is refused even with a perfect signature', () => {
  const { request, approval } = open();
  const verification = verifyResponse(request, approval, responseOf(request), { nowMs: Date.parse(request.expiresAt) + 1 });
  assert.equal(verification.signatureValid, true);
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.includes('REQUEST_EXPIRED'));
});

test('a payload the venue sweep would alter is refused as unsignable', () => {
  const { request, approval } = open();
  const dirty = `${approval.frozenPayload}\u200b`;
  const forgedApproval = { ...approval, frozenPayload: dirty, canonicalHash: sha256(dirty) };
  const verification = verifyResponse(request, forgedApproval, responseOf(request), { nowMs: LATER });
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.includes('APPROVED_PAYLOAD_ALTERED_BY_VENUE_SWEEP'));
});

test('did:key decoding fails closed on anything that is not an Ed25519 key', () => {
  // An X25519 key agreement did:key (multicodec 0xec01) is structurally a valid did:key but must
  // never be treated as a signing key.
  const x25519 = `did:key:z${base58Encode(Buffer.concat([Buffer.from([0xec, 0x01]), Buffer.alloc(32, 7)]))}`;
  assert.throws(() => publicKeyFromDidKey('did:web:example.com'), /not a did:key/);
  assert.throws(() => publicKeyFromDidKey(x25519), /not an Ed25519 did:key/);
  assert.throws(() => publicKeyFromDidKey('did:key:zTooShort'), /not an Ed25519 did:key/);
  assert.equal(verifyEd25519(x25519, 'message', 'A'.repeat(86)), false, 'verification must refuse, not throw');
  assert.equal(verifyEd25519('did:key:zBROKEN', 'message', 'A'.repeat(86)), false);
});


// ── Replay protection: the local ledger ──────────────────────────────────────────────────────

test('the local ledger refuses a duplicate response and says whether it was identical', () => {
  const { request } = open();
  const response = responseOf(request);
  const ledger = new AirlockLedger().open(request);
  ledger.complete(request.requestId, response.responseFingerprint);
  assert.throws(() => ledger.complete(request.requestId, response.responseFingerprint), /identical payload/);
  assert.throws(() => ledger.open(request), /already completed/);
  assert.equal(ledger.state(request.requestId), 'COMPLETED');
});

test('a completed request cannot silently become a second action', () => {
  const { request, approval } = open();
  const response = responseOf(request);
  const ledger = new AirlockLedger().open(request);
  assert.equal(verifyResponse(request, approval, response, { ledger, nowMs: LATER }).verified, true);
  ledger.complete(request.requestId, response.responseFingerprint);
  const second = verifyResponse(request, approval, response, { ledger, nowMs: LATER });
  assert.equal(second.verified, false);
  assert.ok(second.findings.includes('REQUEST_ALREADY_COMPLETED'));
});

test('a response for a request the ledger never opened is refused', () => {
  const { request, approval } = open();
  const verification = verifyResponse(request, approval, responseOf(request), { ledger: new AirlockLedger(), nowMs: LATER });
  assert.equal(verification.verified, false);
  assert.ok(verification.findings.includes('REQUEST_NOT_OPEN_IN_LOCAL_LEDGER'));
});

// ── STAGE 7: the post-eligibility gate ───────────────────────────────────────────────────────

test('POST_ELIGIBLE is never POSTED and posting stays disabled', () => {
  const happy = scenarios['happy-handoff']();
  assert.equal(happy.eligibility.postEligible, true);
  assert.equal(happy.eligibility.posted, false);
  assert.equal(happy.eligibility.publicPostingEnabled, false);
  assert.equal(happy.eligibility.phase, 'PHASE_3A');
  assert.match(happy.eligibility.statement, /Nothing has been sent to Technocore/);
});

test('the gate refuses a request that claims posting is enabled', () => {
  const { request, approval } = open();
  const response = responseOf(request);
  const verification = verifyResponse(request, approval, response, { nowMs: LATER });
  const eligibility = postEligibility({ ...request, publicPostingEnabled: true }, approval, response, verification);
  assert.equal(eligibility.postEligible, false);
  assert.ok(eligibility.blockers.includes('REQUEST_CLAIMS_POSTING_ENABLED'));
});

test('the gate refuses a missing operator acknowledgement', () => {
  const { request, approval } = open();
  const response = responseOf(request);
  const verification = verifyResponse(request, approval, response, { nowMs: LATER });
  const eligibility = postEligibility(request, { ...approval, acknowledgement: '' }, response, verification);
  assert.equal(eligibility.postEligible, false);
  assert.ok(eligibility.blockers.includes('OPERATOR_ACKNOWLEDGEMENT_MISSING'));
});

// ── Dry runs ─────────────────────────────────────────────────────────────────────────────────

test('every dry run reaches its expected verdict', () => {
  const expected = {
    'happy-handoff': ['YES', []],
    'mutated-payload': ['NO', ['PAYLOAD_MUTATED_AFTER_APPROVAL', 'BYTE_FREEZE_BROKEN']],
    'wrong-signer': ['NO', ['RESPONSE_SIGNER_DID_MISMATCH', 'SIGNATURE_DOES_NOT_VERIFY_OVER_APPROVED_BYTES']],
    'stale-request': ['NO', ['REQUEST_EXPIRED']],
    'replayed-response': ['NO', ['REQUEST_ALREADY_COMPLETED']],
  };
  for (const scenario of runAll()) {
    const [verdict, findings] = expected[scenario.id];
    assert.equal(scenario.expectation, verdict, scenario.id);
    assert.equal(scenario.eligibility.postEligible, verdict === 'YES', scenario.id);
    assert.equal(scenario.eligibility.posted, false, scenario.id);
    for (const finding of findings) assert.ok(scenario.verification.findings.includes(finding), `${scenario.id}: expected ${finding}`);
    assert.equal(scenario.doors.length, 5);
    assert.equal(scenario.doors.at(-1).open, verdict === 'YES');
    assert.deepEqual(validate(requestSchema, scenario.request), [], `${scenario.id}: request schema`);
    assert.deepEqual(validate(responseSchema, scenario.response), [], `${scenario.id}: response schema`);
  }
});

test('a failed door keeps every later door shut', () => {
  for (const scenario of runAll().filter(s => s.expectation === 'NO')) {
    const firstClosed = scenario.doors.findIndex(door => !door.open);
    assert.ok(firstClosed >= 0, `${scenario.id}: a refusal must close a door`);
    for (const door of scenario.doors.slice(firstClosed)) {
      assert.equal(door.open, false, `${scenario.id}: ${door.door} opened after an earlier refusal`);
    }
  }
});

test('dry runs are byte-identical across executions', () => {
  assert.equal(JSON.stringify(runAll()), JSON.stringify(runAll()));
});

test('no airlock artifact contains secret-shaped material', () => {
  for (const scenario of runAll()) {
    assertSafeEnvelope(scenario.request);
    assertSafeEnvelope(scenario.approval);
    assertSafeEnvelope({ ...scenario.response });
    assertSafeEnvelope(scenario.eligibility);
  }
  assertSafeEnvelope(footprintPreview());
});

test('the footprint preview lists public steps without signing or posting them', () => {
  const preview = footprintPreview();
  assert.equal(preview.signed, false);
  assert.equal(preview.posted, false);
  assert.equal(preview.steps.length, 2);
  assert.deepEqual(preview.steps.map(s => s.frameType), ['accept', 'lock']);
  assert.equal(preview.steps[0].room, 'tclk-offers');
  assert.notEqual(preview.steps[1].room, 'tclk-offers', 'the lock belongs in the derived deal room');
  for (const step of preview.steps) {
    assert.equal(step.public, true);
    assert.equal(step.posted, false);
    assert.match(step.canonicalHash, /^[0-9a-f]{64}$/);
  }
  assert.ok(!JSON.stringify(preview).includes('signature'));
});

test('the response schema never admits a trusted-signer artifact from this build', () => {
  assert.deepEqual(responseSchema.properties.signerKind.enum, ['TEST_VECTOR_SIGNER', 'MOCK_SIGNER', 'TRUSTED_LOCAL_SIGNER']);
  for (const scenario of runAll()) assert.equal(scenario.response.signerKind, 'TEST_VECTOR_SIGNER');
  assert.equal(AIRLOCK_RESPONSE_SCHEMA, 'tclk-airlock-response/v1');
});
