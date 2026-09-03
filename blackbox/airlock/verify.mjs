// SPDX-License-Identifier: Apache-2.0
//
// SIGNATURE AIRLOCK — STAGE 5 (RETURN ENVELOPE), STAGE 6 (LOCAL VERIFICATION),
// STAGE 7 (POST ELIGIBILITY).
//
// The outer door only opens if every binding holds at once: the response names the approved
// request, the approved DID, the approved hash; the signature verifies over the EXACT approved
// bytes under the nonce the signer reserved; the destination is still the approved room; the
// upstream pin is still the pin the operator reviewed; the request has not expired; the local
// ledger has not already settled it; and nothing secret-shaped came back.
//
// Every finding is a fail-closed reason. There is no "mostly verified".

import { AIRLOCK_RESPONSE_SCHEMA, sha256, canonicalJson } from './prepare.mjs';
import { assertSafeEnvelope, checkByteFreeze, requestIsIntact } from './envelope.mjs';
import { canonicalMessage, cleanText, verifyEd25519 } from './signer.mjs';

/** Stage 5. Normalise whatever the signer returned into the response envelope, or refuse. */
export function buildResponse(signed, { signedAt = '1970-01-01T00:00:00.000Z' } = {}) {
  const allowed = new Set(['requestId', 'signerDid', 'signature', 'canonicalHash', 'room', 'nonce', 'signerKind']);
  const extra = Object.keys(signed ?? {}).filter(key => !allowed.has(key));
  if (extra.length > 0) throw new Error(`airlock: signer returned fields the response envelope does not accept: ${extra.join(', ')}`);
  const envelope = {
    schema: AIRLOCK_RESPONSE_SCHEMA,
    requestId: signed.requestId,
    signerDid: signed.signerDid,
    signature: signed.signature,
    canonicalHash: signed.canonicalHash,
    room: signed.room,
    nonce: signed.nonce,
    signerKind: signed.signerKind,
    signedAt,
  };
  envelope.responseFingerprint = sha256(`FLOPLAB::airlock::response::v1|${canonicalJson(envelope)}`);
  return Object.freeze(assertSafeEnvelope(envelope));
}

/**
 * Stage 6. Returns findings, never throws on a mismatch: the UI has to be able to show which
 * door stayed shut. A thrown error here would mean the airlock itself is broken.
 */
export function verifyResponse(request, approval, response, { ledger = null, nowMs = null } = {}) {
  const findings = [];
  const push = code => { if (!findings.includes(code)) findings.push(code); };

  try { assertSafeEnvelope(response); } catch (error) { push(`UNSAFE_RESPONSE_FIELD:${error.message.replace(/^airlock: /, '')}`); }
  if (response?.schema !== AIRLOCK_RESPONSE_SCHEMA) push('RESPONSE_SCHEMA_UNKNOWN');
  if (!requestIsIntact(request)) push('REQUEST_FINGERPRINT_BROKEN');

  const freeze = checkByteFreeze(request, approval);
  for (const finding of freeze.findings) push(finding);

  // Bindings. Each one is a distinct confusion attack when it fails.
  if (response?.requestId !== approval?.requestId) push('RESPONSE_REQUEST_ID_MISMATCH');
  if (response?.signerDid !== approval?.signerDid) push('RESPONSE_SIGNER_DID_MISMATCH');
  if (response?.canonicalHash !== approval?.canonicalHash) push('RESPONSE_CANONICAL_HASH_MISMATCH');
  if (response?.room !== approval?.intendedRoom) push('RESPONSE_DESTINATION_ROOM_MISMATCH');
  if (!Number.isInteger(response?.nonce) || response.nonce < 1) push('RESPONSE_NONCE_INVALID');
  if (typeof response?.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(response.signature)) push('RESPONSE_SIGNATURE_MALFORMED');

  const { approvalFingerprint, ...issuedApproval } = approval ?? {};
  if (approvalFingerprint !== sha256(`FLOPLAB::airlock::approval::v1|${canonicalJson(issuedApproval)}`)) push('APPROVAL_TAMPERED');
  if (response?.responseFingerprint !== undefined) {
    const { responseFingerprint, ...issuedResponse } = response;
    if (responseFingerprint !== sha256(`FLOPLAB::airlock::response::v1|${canonicalJson(issuedResponse)}`)) push('RESPONSE_TAMPERED');
  }

  // The frozen bytes must survive the venue's own sweep, or the signature covers something else.
  let sweepIsIdentity = false;
  try { sweepIsIdentity = cleanText(approval.frozenPayload) === approval.frozenPayload; } catch { push('APPROVED_PAYLOAD_NOT_SIGNABLE'); }
  if (!sweepIsIdentity) push('APPROVED_PAYLOAD_ALTERED_BY_VENUE_SWEEP');

  // The signature is checked against the APPROVED bytes, never against the request as it stands.
  let signatureValid = false;
  let signedPreimageHash = null;
  if (findings.length === 0 || !findings.some(f => f.startsWith('RESPONSE_SIGNATURE') || f === 'RESPONSE_NONCE_INVALID')) {
    try {
      const preimage = canonicalMessage(approval.intendedRoom, response.nonce, approval.frozenPayload);
      signedPreimageHash = sha256(preimage);
      signatureValid = verifyEd25519(approval.signerDid, preimage, response.signature);
    } catch {
      signatureValid = false;
    }
  }
  if (!signatureValid) push('SIGNATURE_DOES_NOT_VERIFY_OVER_APPROVED_BYTES');

  if (nowMs !== null && request?.expiresAt && Date.parse(request.expiresAt) < nowMs) push('REQUEST_EXPIRED');
  if (ledger !== null) {
    const state = ledger.state(request?.requestId);
    if (state === 'COMPLETED') push('REQUEST_ALREADY_COMPLETED');
    else if (state === 'UNKNOWN') push('REQUEST_NOT_OPEN_IN_LOCAL_LEDGER');
  }

  return Object.freeze({
    stage: findings.length === 0 ? 'LOCALLY_VERIFIED' : 'REFUSED',
    verified: findings.length === 0,
    signatureValid,
    byteFreezeIntact: freeze.ok,
    signedPreimageHash,
    findings: Object.freeze(findings),
  });
}

/**
 * Stage 7. POST_ELIGIBLE is not POSTED: it is the statement "if public posting were enabled,
 * this exact signed frame would be the thing that goes out". Phase 3A never enables it.
 */
export function postEligibility(request, approval, response, verification, { publicPostingEnabled = false } = {}) {
  const blockers = [...verification.findings];
  if (request?.publicPostingEnabled !== false) blockers.push('REQUEST_CLAIMS_POSTING_ENABLED');
  if (approval?.acknowledgement !== 'I APPROVE THESE EXACT CANONICAL BYTES') blockers.push('OPERATOR_ACKNOWLEDGEMENT_MISSING');
  if (request?.intendedOperation !== 'post_frame') blockers.push('OPERATION_NOT_PERMITTED');
  return Object.freeze({
    stage: 'POST_ELIGIBILITY',
    postEligible: verification.verified && blockers.length === 0,
    posted: false,
    publicPostingEnabled,
    phase: 'PHASE_3A',
    statement: 'POST_ELIGIBLE describes local readiness only. Nothing has been sent to Technocore, no room has been written, and no value has moved.',
    blockers: Object.freeze(blockers),
  });
}
