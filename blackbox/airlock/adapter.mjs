// SPDX-License-Identifier: Apache-2.0
//
// CANONICAL SIGNER ADAPTER — Phase 3A.3.
//
// A courier, not a signer. This module is the only thing in the lab that is allowed to speak to
// a local signer transport, and it is deliberately incapable of being one: it holds no key, no
// passphrase and no nonce, it derives nothing secret, and every field it hands over is already
// public by the time it arrives.
//
// The canonical Windows-local Technocore agent owns custody. Its public surface is
//
//     Signer.sign_room(room, text) -> SignedOperation(did, room, nonce, signature, text)
//
// so the adapter's whole job is: translate an already-approved, BYTE-FROZEN airlock request into
// exactly those two public arguments, take back a signature-only result, bind it to the request
// the operator approved, verify it locally, and stop at POST_ELIGIBLE.
//
// Three rules shape the code below.
//
//   1. Nothing reaches the transport until every pre-handoff check passes. A refusal is not a
//      degraded handoff; it is no handoff at all.
//   2. The response is treated as hostile until proven otherwise. A signer that returns a field
//      shaped like custody material fails the whole run closed, and its value is never logged.
//   3. POST_ELIGIBLE is a statement about local artifacts. It is never POSTED.

import { AIRLOCK_REQUEST_SCHEMA, sha256, canonicalJson, deepFreeze } from './prepare.mjs';
import { assertSafeEnvelope, checkByteFreeze, requestIsIntact, AirlockLedger } from './envelope.mjs';
import { cleanText, publicKeyFromDidKey, TestVectorSigner } from './signer.mjs';
import { buildResponse, verifyResponse, postEligibility } from './verify.mjs';

export const ADAPTER_SCHEMA = 'tclk-airlock-adapter/v1';
export const CUSTODY_SEAL_SCHEMA = 'tclk-custody-seal/v1';
export const BINDING_SCHEMA = 'tclk-airlock-signer-binding/v1';

/** The adopted, frozen candidate pin. The adapter refuses to courier anything else. */
export const ADOPTED_UPSTREAM_PIN = 'd48e87343200e3115e243df39e8f295f5ce2e645';

/** The public interface this adapter targets. Audited read-only; never invoked in this phase. */
export const CANONICAL_SIGNER_PUBLIC_INTERFACE =
  'Signer.sign_room(room, text) -> SignedOperation(did, room, nonce, signature, text)';

export const MODES = Object.freeze({ MOCK: 'MOCK', REAL_INTERFACE_DRY_RUN: 'REAL_INTERFACE_DRY_RUN' });

export const OPERATOR_ACKNOWLEDGEMENT = 'I APPROVE THESE EXACT CANONICAL BYTES';

/**
 * Field names that mean custody material came back across the boundary. Checked by NAME before
 * anything is read, so a value never has to be touched to be refused.
 */
const CUSTODY_SHAPED_FIELD =
  /^(privatekey|private_key|seed|mnemonic|passphrase|password|secretkey|secret_key|decryptedkey|decrypted_key|keyhandle|key_handle|keystore|keymaterial|key_material|dpapi|dpapiblob|dpapi_blob|entropy|xprv|wif|sessioncredential|credential|credentials)$/i;

/** Signer kinds this phase may accept. TRUSTED_LOCAL_SIGNER stays unreachable from this build. */
const PERMITTED_SIGNER_KINDS = new Set(['TEST_VECTOR_SIGNER', 'MOCK_SIGNER']);

/** What the adapter is, stated so it cannot quietly grow into something else. */
export const TRUST_MODEL = deepFreeze({
  is: ['courier', 'protocol translator', 'local verifier'],
  isNot: ['key custody', 'signing authority', 'identity authority', 'wallet', 'settlement rail', 'Technocore writer'],
  holds: ['public DIDs', 'canonical bytes already approved by an operator', 'hashes and fingerprints'],
  neverHolds: ['a private key', 'a seed', 'a passphrase', 'a decrypted key', 'a DPAPI blob', 'an operator session'],
});

// ── Event log ────────────────────────────────────────────────────────────────────────────────

export const ADAPTER_EVENTS = Object.freeze([
  'PREPARED', 'REVIEWED', 'HANDOFF_ALLOWED', 'SIGNER_RESPONSE_RECEIVED', 'LOCALLY_VERIFIED', 'POST_ELIGIBLE',
]);

export const ADAPTER_FAILURE_EVENTS = Object.freeze([
  'HANDOFF_REFUSED', 'SIGNER_REFUSED', 'SIGNER_RESPONSE_REFUSED', 'LOCAL_VERIFY_FAILED',
  'POST_ELIGIBILITY_REFUSED', 'REAL_INTERFACE_DRY_RUN_NOT_SUPPORTED', 'DUPLICATE_REQUEST_REFUSED',
]);

/**
 * A safe local event log. Only codes, ids, hashes and booleans go in — the sentinel runs over
 * every reference before it is appended, so a caller cannot log its way around the boundary.
 */
export class AdapterEventLog {
  #events = [];

  record(code, refs = {}) {
    if (![...ADAPTER_EVENTS, ...ADAPTER_FAILURE_EVENTS].includes(code)) {
      throw new Error(`adapter: '${code}' is not a permitted event code`);
    }
    for (const [key, value] of Object.entries(refs)) {
      if (typeof value === 'string' && value.length > 128) {
        throw new Error(`adapter: event reference ${key} is too long to be a reference`);
      }
    }
    this.#events.push(Object.freeze({ seq: this.#events.length + 1, code, ...assertSafeEnvelope({ ...refs }) }));
    return this;
  }

  get events() { return Object.freeze([...this.#events]); }
  codes() { return this.#events.map(event => event.code); }
}

// ── Transports ───────────────────────────────────────────────────────────────────────────────

/**
 * The MOCK transport. Wraps the published deterministic test-vector signer in the canonical
 * two-argument shape so the adapter exercises the same call site a real transport would.
 *
 * `real` is false and there is no dry-run surface: this stand-in is not the canonical signer and
 * does not pretend to speak for it.
 */
export class MockSignerTransport {
  #signer;

  constructor(signer = new TestVectorSigner()) {
    this.#signer = signer;
    this.did = signer.did;
    this.real = false;
    this.mode = MODES.MOCK;
    this.interfaceShape = CANONICAL_SIGNER_PUBLIC_INTERFACE;
  }

  describe() {
    return Object.freeze({
      interfaceShape: this.interfaceShape,
      real: false,
      dryRunSupported: false,
      signerKind: this.#signer.kind,
    });
  }

  /** `sign_room(room, text)` — the two public arguments, plus binding references it echoes back. */
  signRoom({ room, text, requestId, signerDid, canonicalHash }) {
    return this.#signer.signApprovedChallenge({
      requestId, canonicalPayload: text, canonicalHash, signerDid, room,
    });
  }
}

/**
 * Does this transport expose a NON-SIGNING dry run? Absent an explicit `dryRun` function the
 * answer is no, and REAL_INTERFACE_DRY_RUN reports NOT_SUPPORTED rather than falling back to a
 * real signature. There is no fallback path in this module by design.
 */
export function dryRunSupport(transport) {
  if (!transport || typeof transport.dryRun !== 'function') {
    return Object.freeze({
      supported: false,
      reason: 'NO_NON_SIGNING_DRY_RUN_SURFACE',
      detail: 'the canonical signer exposes no validate/prepare surface that stops short of signing',
    });
  }
  return Object.freeze({ supported: true, reason: 'TRANSPORT_DECLARES_NON_SIGNING_DRY_RUN', detail: null });
}

// ── Translation ──────────────────────────────────────────────────────────────────────────────

/**
 * The exact public input the canonical signer expects, derived from the OPERATOR'S copy of the
 * bytes rather than from the request as it stands now. `room` and `text` are the two arguments;
 * the rest are binding references a transport echoes so a reply can be tied to a request.
 */
export function signerChallenge(approval) {
  const challenge = {
    interfaceShape: 'sign_room(room, text)',
    room: approval.intendedRoom,
    text: approval.frozenPayload,
    requestId: approval.requestId,
    signerDid: approval.signerDid,
    canonicalHash: approval.canonicalHash,
  };
  return deepFreeze(assertSafeEnvelope(challenge));
}

const signerInputHash = challenge =>
  sha256(`FLOPLAB::airlock::signer-input::v1|${challenge.room}|${sha256(challenge.text)}`);

/**
 * AIRLOCK_TO_SIGNER_BINDING_HASH. Proves the four representations refer to one payload:
 * the airlock's frozen bytes, the adapter's input, the signer's input, and the message the
 * returned signature was verified over. Hashes only — no secret material, no raw signature.
 */
export function airlockToSignerBinding({ request, approval, challenge, response, verification }) {
  const layers = {
    schema: BINDING_SCHEMA,
    airlockPayloadHash: sha256(approval.frozenPayload),
    adapterInputHash: sha256(canonicalJson({
      requestId: request.requestId,
      requestFingerprint: request.requestFingerprint,
      canonicalHash: approval.canonicalHash,
      signerDid: approval.signerDid,
      room: approval.intendedRoom,
      operation: approval.intendedOperation,
      upstreamSha: approval.upstreamSha,
    })),
    signerInputHash: signerInputHash(challenge),
    returnedCanonicalHash: response?.canonicalHash ?? null,
    signedMessageHash: verification?.signedPreimageHash ?? null,
  };
  return deepFreeze({
    ...layers,
    sameCanonicalPayload: layers.airlockPayloadHash === approval.canonicalHash
      && layers.returnedCanonicalHash === approval.canonicalHash,
    hash: sha256(`FLOPLAB::airlock::binding::v1|${canonicalJson(layers)}`),
  });
}

/**
 * CUSTODY SEAL. A deterministic, visible fingerprint over the airlock request, the byte freeze,
 * the signer response and the local verification.
 *
 * It means exactly one thing: these local artifacts were cryptographically bound to the same
 * approved canonical payload. It is not a statement about a human, a settlement, FLOP
 * eligibility, or any official verification — see `doesNotMean`.
 */
export function custodySeal({ request, approval, response, verification, binding }) {
  const core = {
    schema: CUSTODY_SEAL_SCHEMA,
    requestId: request.requestId,
    requestFingerprint: request.requestFingerprint,
    approvalFingerprint: approval.approvalFingerprint,
    canonicalHash: approval.canonicalHash,
    signerDid: approval.signerDid,
    room: approval.intendedRoom,
    operation: approval.intendedOperation,
    upstreamSha: approval.upstreamSha,
    responseFingerprint: response.responseFingerprint,
    signatureDigest: sha256(response.signature),
    signedMessageHash: verification.signedPreimageHash,
    bindingHash: binding.hash,
    locallyVerified: verification.verified,
  };
  const digest = sha256(`FLOPLAB::airlock::custody-seal::v1|${canonicalJson(core)}`);
  const groups = digest.slice(0, 24).toUpperCase().match(/.{4}/g) ?? [];
  return deepFreeze({
    schema: CUSTODY_SEAL_SCHEMA,
    digest,
    display: `CS1-${groups.join('-')}`,
    bindingHash: binding.hash,
    means: 'These local artifacts were cryptographically bound to the same approved canonical payload.',
    doesNotMean: Object.freeze([
      'a trusted human',
      'economic settlement',
      'FLOP eligibility',
      'official FLOP verification',
      'anything posted to Technocore',
    ]),
  });
}

// ── Pre-handoff validation ───────────────────────────────────────────────────────────────────

/**
 * Every check that must hold BEFORE the transport is contacted. Returns findings instead of
 * throwing so the surface can show which gate refused; `ok === false` means no handoff happens.
 */
export function validateHandoff(request, approval, { nowMs = null, ledger = null, mode = MODES.MOCK } = {}) {
  const findings = [];
  const push = code => { if (!findings.includes(code)) findings.push(code); };

  if (!Object.values(MODES).includes(mode)) push('ADAPTER_MODE_UNKNOWN');

  // Secret sentinel, both artifacts, before anything else is trusted enough to read closely.
  for (const [label, artifact] of [['REQUEST', request], ['APPROVAL', approval]]) {
    try { assertSafeEnvelope(artifact); } catch (error) {
      push(`UNSAFE_${label}_FIELD:${error.message.replace(/^airlock: /, '')}`);
    }
  }

  if (request?.schema !== AIRLOCK_REQUEST_SCHEMA) push('AIRLOCK_SCHEMA_UNKNOWN');
  if (typeof request?.requestId !== 'string' || !/^alr1-[0-9a-f]{32}$/.test(request.requestId)) push('REQUEST_ID_MALFORMED');
  if (typeof request?.canonicalPayload !== 'string' || request.canonicalPayload.length === 0) push('CANONICAL_PAYLOAD_MISSING');
  else if (request.canonicalHash !== sha256(request.canonicalPayload)) push('CANONICAL_HASH_DOES_NOT_COVER_PAYLOAD');
  if (request && !requestIsIntact(request)) push('REQUEST_FINGERPRINT_BROKEN');

  if (!approval || approval.stage !== 'REVIEWED') push('APPROVAL_MISSING');
  else if (approval.acknowledgement !== OPERATOR_ACKNOWLEDGEMENT) push('OPERATOR_APPROVAL_MISSING');

  // BYTE FREEZE. The approval keeps its own copy of the bytes; a post-approval edit lands here.
  if (request && approval) {
    for (const finding of checkByteFreeze(request, approval).findings) push(finding);
  }

  try { publicKeyFromDidKey(request?.signerDid); } catch { push('SIGNER_DID_MALFORMED'); }

  if (request?.upstream?.sha !== ADOPTED_UPSTREAM_PIN) push('UPSTREAM_PIN_NOT_ADOPTED');
  if (approval && approval.upstreamSha !== ADOPTED_UPSTREAM_PIN) push('APPROVED_UPSTREAM_PIN_NOT_ADOPTED');

  if (nowMs !== null) {
    if (request?.expiresAt && Date.parse(request.expiresAt) < nowMs) push('REQUEST_EXPIRED');
    if (request?.createdAt && Date.parse(request.createdAt) > nowMs) push('REQUEST_NOT_YET_VALID');
  }

  if (request?.publicPostingEnabled !== false) push('REQUEST_CLAIMS_POSTING_ENABLED');
  if (request?.intendedOperation !== 'post_frame') push('OPERATION_NOT_PERMITTED');

  if (approval?.frozenPayload !== undefined) {
    try {
      if (cleanText(approval.frozenPayload) !== approval.frozenPayload) push('APPROVED_PAYLOAD_ALTERED_BY_VENUE_SWEEP');
    } catch { push('APPROVED_PAYLOAD_NOT_SIGNABLE'); }
  }

  if (ledger !== null && ledger.state(request?.requestId) === 'COMPLETED') push('REQUEST_ALREADY_COMPLETED');

  return Object.freeze({
    stage: findings.length === 0 ? 'HANDOFF_ALLOWED' : 'HANDOFF_REFUSED',
    ok: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

/**
 * Minimum-safe response acceptance. Custody-shaped names are refused by name, then the airlock's
 * own allow-list refuses anything else the response envelope does not carry. No value from a
 * refused field is read, echoed or logged.
 */
export function acceptSignerResponse(raw, { signedAt } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'SIGNER_RESPONSE_NOT_AN_OBJECT', response: null };
  }
  const custodyShaped = Object.keys(raw).filter(key => CUSTODY_SHAPED_FIELD.test(key));
  if (custodyShaped.length > 0) {
    return { ok: false, code: `CUSTODY_MATERIAL_IN_SIGNER_RESPONSE:${custodyShaped.sort().join(',')}`, response: null };
  }
  try {
    return { ok: true, code: null, response: buildResponse(raw, { signedAt }) };
  } catch (error) {
    return { ok: false, code: `SIGNER_RESPONSE_REJECTED:${error.message.replace(/^airlock: /, '')}`, response: null };
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

const refusal = (mode, stage, findings, log, extra = {}) => deepFreeze(assertSafeEnvelope({
  schema: ADAPTER_SCHEMA,
  mode,
  stage,
  signerInterface: CANONICAL_SIGNER_PUBLIC_INTERFACE,
  signerContacted: false,
  realCanonicalSignerAccessed: false,
  realSignaturePerformed: false,
  postEligible: false,
  posted: false,
  publicPostingEnabled: false,
  custodySeal: null,
  binding: null,
  response: null,
  verification: null,
  eligibility: null,
  findings: Object.freeze([...findings]),
  events: log.events,
  statement: 'The adapter refused before the custody boundary was crossed. Nothing was signed and nothing was posted.',
  ...extra,
}));

/**
 * signFrozenAirlockRequest — the whole contract, in order.
 *
 * @param {{request: object, approval: object}} frozen an intact request and its approval record
 * @param {object} [options]
 * @param {'MOCK'|'REAL_INTERFACE_DRY_RUN'} [options.mode]
 * @param {object} [options.transport] signer transport; MOCK defaults to the test-vector stand-in
 * @param {AirlockLedger} [options.ledger] local duplicate/replay state
 * @param {number|null} [options.nowMs] freshness clock
 * @param {string} [options.signedAt] deterministic response timestamp
 */
export function signFrozenAirlockRequest(frozen, options = {}) {
  const {
    mode = MODES.MOCK,
    transport = mode === MODES.MOCK ? new MockSignerTransport() : null,
    ledger = new AirlockLedger(),
    nowMs = null,
    signedAt = '1970-01-01T00:00:00.000Z',
  } = options;
  const { request, approval } = frozen ?? {};
  const log = new AdapterEventLog();

  log.record('PREPARED', { requestId: request?.requestId ?? null, canonicalHash: request?.canonicalHash ?? null });
  log.record('REVIEWED', { requestId: request?.requestId ?? null, approvalFingerprint: approval?.approvalFingerprint ?? null });

  // 1. Validate. No transport contact until this is clean.
  const gate = validateHandoff(request, approval, { nowMs, ledger, mode });
  if (!gate.ok) {
    const duplicate = gate.findings.includes('REQUEST_ALREADY_COMPLETED');
    log.record(duplicate ? 'DUPLICATE_REQUEST_REFUSED' : 'HANDOFF_REFUSED', { findingCount: gate.findings.length });
    return refusal(mode, gate.stage, gate.findings, log);
  }

  const challenge = signerChallenge(approval);

  // 2. REAL_INTERFACE_DRY_RUN: compatibility only. Never reaches signRoom.
  if (mode === MODES.REAL_INTERFACE_DRY_RUN) {
    const support = dryRunSupport(transport);
    if (!support.supported) {
      log.record('REAL_INTERFACE_DRY_RUN_NOT_SUPPORTED', { reason: support.reason });
      return refusal(mode, 'REAL_INTERFACE_DRY_RUN_NOT_SUPPORTED', [`REAL_INTERFACE_DRY_RUN_NOT_SUPPORTED:${support.reason}`], log, {
        dryRun: Object.freeze({ supported: false, reason: support.reason, detail: support.detail, signatureRequested: false }),
        statement: 'The canonical signer exposes no non-signing dry run, so the real signer was not invoked. This is an accepted outcome for this phase.',
      });
    }
    let probe;
    try { probe = transport.dryRun(challenge); } catch (error) {
      log.record('SIGNER_REFUSED', { reason: 'DRY_RUN_THREW' });
      return refusal(mode, 'REAL_INTERFACE_DRY_RUN_REFUSED', [`DRY_RUN_REFUSED:${String(error.message).slice(0, 80)}`], log);
    }
    const leaked = Object.keys(probe ?? {}).filter(key => key === 'signature' || CUSTODY_SHAPED_FIELD.test(key));
    if (leaked.length > 0 || probe?.willSign === true) {
      log.record('SIGNER_RESPONSE_REFUSED', { reason: 'DRY_RUN_WAS_NOT_NON_SIGNING' });
      return refusal(mode, 'REAL_INTERFACE_DRY_RUN_REFUSED', ['DRY_RUN_RETURNED_SIGNING_MATERIAL'], log);
    }
    log.record('HANDOFF_ALLOWED', { requestId: request.requestId, dryRun: true });
    return refusal(mode, 'REAL_INTERFACE_DRY_RUN_COMPATIBLE', [], log, {
      dryRun: Object.freeze({
        supported: true,
        reason: support.reason,
        accepted: probe?.accepted === true,
        signatureRequested: false,
      }),
      statement: 'Public-interface compatibility was exercised without requesting a signature. Nothing was signed and nothing was posted.',
    });
  }

  // 3. MOCK only. A transport that claims to be the real signer is refused here, not later.
  if (transport?.real === true) {
    log.record('HANDOFF_REFUSED', { reason: 'REAL_TRANSPORT_IN_MOCK_MODE' });
    return refusal(mode, 'HANDOFF_REFUSED', ['REAL_SIGNER_NOT_PERMITTED_IN_THIS_PHASE'], log);
  }
  if (typeof transport?.signRoom !== 'function') {
    log.record('HANDOFF_REFUSED', { reason: 'TRANSPORT_HAS_NO_SIGN_ROOM' });
    return refusal(mode, 'HANDOFF_REFUSED', ['TRANSPORT_INTERFACE_INCOMPATIBLE'], log);
  }

  try { ledger.open(request); } catch {
    log.record('DUPLICATE_REQUEST_REFUSED', { requestId: request.requestId });
    return refusal(mode, 'HANDOFF_REFUSED', ['REQUEST_ALREADY_COMPLETED'], log);
  }

  log.record('HANDOFF_ALLOWED', {
    requestId: request.requestId,
    signerInputHash: signerInputHash(challenge),
  });

  // 4. Cross the boundary. Two public arguments out, signature-only in.
  let raw;
  try { raw = transport.signRoom(challenge); } catch (error) {
    log.record('SIGNER_REFUSED', { reason: String(error.message).slice(0, 60) });
    return refusal(mode, 'SIGNER_REFUSED', ['SIGNER_DECLINED_THE_CHALLENGE'], log);
  }

  const accepted = acceptSignerResponse(raw, { signedAt });
  if (!accepted.ok) {
    log.record('SIGNER_RESPONSE_REFUSED', { reason: accepted.code.split(':')[0] });
    return refusal(mode, 'SIGNER_RESPONSE_REFUSED', [accepted.code], log);
  }
  const response = accepted.response;
  log.record('SIGNER_RESPONSE_RECEIVED', {
    requestId: response.requestId,
    responseFingerprint: response.responseFingerprint,
    signerKind: response.signerKind,
  });

  // 5. Bind the signature back to the request the operator approved, then verify locally.
  const verification = verifyResponse(request, approval, response, { ledger, nowMs });
  const findings = [...verification.findings];
  if (!PERMITTED_SIGNER_KINDS.has(response.signerKind)) findings.push('SIGNER_KIND_NOT_PERMITTED_IN_THIS_PHASE');
  if (request.upstream.sha !== ADOPTED_UPSTREAM_PIN) findings.push('UPSTREAM_PIN_NOT_ADOPTED');

  const binding = airlockToSignerBinding({ request, approval, challenge, response, verification });
  if (!binding.sameCanonicalPayload) findings.push('BINDING_CHAIN_BROKEN');

  const verified = verification.verified && findings.length === 0;
  if (verified) log.record('LOCALLY_VERIFIED', { requestId: request.requestId, bindingHash: binding.hash });
  else log.record('LOCAL_VERIFY_FAILED', { findingCount: findings.length });

  const eligibility = postEligibility(request, approval, response, verification, { publicPostingEnabled: false });
  const postEligible = verified && eligibility.postEligible;

  if (verified) {
    try { ledger.complete(request.requestId, response.responseFingerprint); } catch {
      findings.push('LEDGER_REFUSED_COMPLETION');
    }
  }

  const seal = verified && postEligible
    ? custodySeal({ request, approval, response, verification, binding })
    : null;

  if (postEligible) log.record('POST_ELIGIBLE', { requestId: request.requestId, custodySeal: seal.digest });
  else log.record('POST_ELIGIBILITY_REFUSED', { blockerCount: eligibility.blockers.length });

  return deepFreeze(assertSafeEnvelope({
    schema: ADAPTER_SCHEMA,
    mode,
    stage: postEligible ? 'POST_ELIGIBLE' : 'REFUSED',
    signerInterface: CANONICAL_SIGNER_PUBLIC_INTERFACE,
    signerContacted: true,
    realCanonicalSignerAccessed: false,
    realSignaturePerformed: false,
    postEligible,
    posted: false,
    publicPostingEnabled: false,
    requestId: request.requestId,
    signerDid: response.signerDid,
    canonicalHash: response.canonicalHash,
    custodySeal: seal,
    binding,
    response,
    verification,
    eligibility,
    findings: Object.freeze(findings.length > 0 ? findings : eligibility.blockers.slice()),
    events: log.events,
    statement: postEligible
      ? 'POST_ELIGIBLE describes local readiness only. Nothing was sent to Technocore, no room was written, and no value moved.'
      : 'The adapter refused. Nothing was posted.',
  }));
}
