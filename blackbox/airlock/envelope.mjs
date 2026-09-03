// SPDX-License-Identifier: Apache-2.0
//
// SIGNATURE AIRLOCK — STAGE 2 (REVIEW ENVELOPE), STAGE 3 (OPERATOR REVIEW), BYTE FREEZE.
//
// Two doors, never open at once. The request envelope is the inner door: it carries only what
// an operator needs to decide and what a signer needs to sign, and a sentinel refuses to let
// secret-shaped material through it in either direction. BYTE FREEZE is the outer door: an
// approval binds a fingerprint over every field that changes the meaning of the bytes, so a
// post-approval edit cannot reuse the approval — it produces a different request id.

import { AIRLOCK_REQUEST_SCHEMA, sha256, canonicalJson, upstreamPin, deepFreeze } from './prepare.mjs';

/** Key names that must never appear anywhere in an airlock envelope. */
const UNSAFE_KEY =
  /^(secret|preimage|witness|seed|mnemonic|privatekey|private_key|signingkey|signing_key|secretkey|secret_key|passphrase|password|apikey|api_key|token|accesstoken|access_token|refreshtoken|keystore|dpapi|entropy|xprv|wif|credential|credentials)$/i;

/** Value shapes that mean custody material has leaked regardless of the key it hides behind. */
const UNSAFE_VALUE = [
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, 'PEM_PRIVATE_KEY'],
  [/^(?:[a-z]{3,8}\s){11,}[a-z]{3,8}$/, 'MNEMONIC_PHRASE'],
  [/^xprv[1-9A-HJ-NP-Za-km-z]{20,}$/, 'EXTENDED_PRIVATE_KEY'],
  [/^AQAAA[A-Za-z0-9+/=]{40,}$/, 'DPAPI_BLOB'],
];

/**
 * The secret sentinel. Walks an envelope and throws on the first finding, naming the path and
 * category only — never the value. Runs on requests before they leave and on responses before
 * they are trusted, because a compromised or buggy signer is exactly the thing that would
 * hand a seed back in a field we did not ask for.
 */
export function assertSafeEnvelope(value, path = '$') {
  if (typeof value === 'string') {
    for (const [pattern, category] of UNSAFE_VALUE) {
      if (pattern.test(value)) throw new Error(`airlock: unsafe value at ${path} (category ${category})`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEnvelope(item, `${path}[${index}]`));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEY.test(key)) throw new Error(`airlock: unsafe field at ${path}.${key}`);
      assertSafeEnvelope(child, `${path}.${key}`);
    }
  }
  return value;
}

/**
 * The exact fields a signature's meaning depends on. Anything in here is frozen at approval;
 * anything outside it (display prose, warnings) can be regenerated without invalidating an
 * approval because it cannot change what the bytes do.
 */
export const bindingCore = envelope => ({
  schema: envelope.schema,
  createdAt: envelope.createdAt,
  upstreamSha: envelope.upstream.sha,
  upstreamPackage: envelope.upstream.package,
  frameType: envelope.frameType,
  contractId: envelope.contractId,
  signerDid: envelope.signerDid,
  canonicalPayload: envelope.canonicalPayload,
  canonicalHash: envelope.canonicalHash,
  intendedRoom: envelope.intendedRoom,
  intendedOperation: envelope.intendedOperation,
});

export const fingerprintRequest = envelope =>
  sha256(`FLOPLAB::airlock::request::v1|${canonicalJson(bindingCore(envelope))}`);

/** Stage 2. Deterministic for a given frame, clock and pin — the same input yields the same id. */
export function buildRequest(prepared, { createdAt = '1970-01-01T00:00:00.000Z', ttlMs = 900000 } = {}) {
  if (prepared?.stage !== 'PREPARED') throw new Error('airlock: buildRequest needs a PREPARED frame');
  if (prepared.canonicalHash !== sha256(prepared.canonicalPayload)) {
    throw new Error('airlock: prepared canonical hash does not cover the prepared payload');
  }
  const draft = {
    schema: AIRLOCK_REQUEST_SCHEMA,
    requestId: null,
    requestFingerprint: null,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
    ttlMs,
    upstream: prepared.upstream,
    frameType: prepared.frameType,
    contractId: prepared.contractId,
    signerDid: prepared.signerDid,
    canonicalPayload: prepared.canonicalPayload,
    canonicalHash: prepared.canonicalHash,
    payloadBytes: prepared.payloadBytes,
    intendedRoom: prepared.intendedRoom,
    intendedOperation: prepared.intendedOperation,
    nonceOwner: prepared.nonceOwner,
    sweepIsIdentity: prepared.sweepIsIdentity,
    publicPostingEnabled: false,
    human: prepared.human,
    warnings: prepared.warnings,
  };
  const requestFingerprint = fingerprintRequest(draft);
  const envelope = { ...draft, requestId: `alr1-${requestFingerprint.slice(0, 32)}`, requestFingerprint };
  return deepFreeze(assertSafeEnvelope(envelope));
}

/** Recompute the fingerprint from the envelope as it stands now. Any drift is visible here. */
export function requestIsIntact(envelope) {
  const recomputed = fingerprintRequest(envelope);
  return recomputed === envelope.requestFingerprint
    && envelope.requestId === `alr1-${recomputed.slice(0, 32)}`
    && envelope.canonicalHash === sha256(envelope.canonicalPayload);
}

/**
 * Stage 3 → BYTE FREEZE. The approval is a separate artifact, not a flag on the request, so a
 * mutated request cannot carry its own approval. `frozenPayload` is the operator's copy of the
 * bytes: verification compares against this, not against whatever the request says later.
 */
export function approveRequest(envelope, { approvedAt = '1970-01-01T00:00:00.000Z', approvedBy = 'operator:local' } = {}) {
  if (!requestIsIntact(envelope)) throw new Error('airlock: refusing to approve a request whose fingerprint does not match its content');
  const approval = {
    stage: 'REVIEWED',
    requestId: envelope.requestId,
    requestFingerprint: envelope.requestFingerprint,
    canonicalHash: envelope.canonicalHash,
    frozenPayload: envelope.canonicalPayload,
    signerDid: envelope.signerDid,
    intendedRoom: envelope.intendedRoom,
    intendedOperation: envelope.intendedOperation,
    upstreamSha: envelope.upstream.sha,
    approvedAt,
    approvedBy,
    acknowledgement: 'I APPROVE THESE EXACT CANONICAL BYTES',
  };
  approval.approvalFingerprint = sha256(`FLOPLAB::airlock::approval::v1|${canonicalJson(approval)}`);
  return deepFreeze(assertSafeEnvelope(approval));
}

/**
 * BYTE FREEZE enforcement. Returns findings rather than throwing so the UI can show which door
 * refused to open and why.
 */
export function checkByteFreeze(envelope, approval) {
  const findings = [];
  if (approval.requestId !== envelope.requestId) findings.push('APPROVAL_REQUEST_ID_MISMATCH');
  if (approval.requestFingerprint !== fingerprintRequest(envelope)) findings.push('BYTE_FREEZE_BROKEN');
  if (approval.frozenPayload !== envelope.canonicalPayload) findings.push('PAYLOAD_MUTATED_AFTER_APPROVAL');
  if (approval.canonicalHash !== sha256(approval.frozenPayload)) findings.push('APPROVED_HASH_DOES_NOT_COVER_APPROVED_BYTES');
  if (approval.signerDid !== envelope.signerDid) findings.push('SIGNER_CHANGED_AFTER_APPROVAL');
  if (approval.intendedRoom !== envelope.intendedRoom) findings.push('DESTINATION_ROOM_CHANGED_AFTER_APPROVAL');
  if (approval.intendedOperation !== envelope.intendedOperation) findings.push('OPERATION_CHANGED_AFTER_APPROVAL');
  if (approval.upstreamSha !== envelope.upstream.sha) findings.push('UPSTREAM_PIN_CHANGED_AFTER_APPROVAL');
  // Recompute over the approval as issued: the fingerprint covers every field except itself.
  const { approvalFingerprint, ...issued } = approval;
  if (approvalFingerprint !== sha256(`FLOPLAB::airlock::approval::v1|${canonicalJson(issued)}`)) {
    findings.push('APPROVAL_TAMPERED');
  }
  return { ok: findings.length === 0, findings };

}

/**
 * Local operator-safety state only — this is NOT a Technocore protocol guarantee and claims no
 * network-level replay protection. It exists so a completed handoff cannot quietly become a
 * second action on the same machine.
 */
export class AirlockLedger {
  #entries = new Map();

  open(envelope) {
    const existing = this.#entries.get(envelope.requestId);
    if (existing?.state === 'COMPLETED') {
      throw new Error(`airlock: request ${envelope.requestId} already completed — prepare a new request instead of reusing a settled one`);
    }
    this.#entries.set(envelope.requestId, { state: 'OPEN', requestFingerprint: envelope.requestFingerprint, responseHash: null });
    return this;
  }

  complete(requestId, responseHash) {
    const entry = this.#entries.get(requestId);
    if (!entry) throw new Error(`airlock: request ${requestId} was never opened`);
    if (entry.state === 'COMPLETED') {
      const duplicate = entry.responseHash === responseHash ? 'identical' : 'different';
      throw new Error(`airlock: duplicate response for ${requestId} (${duplicate} payload) — a completed request does not accept a second signature`);
    }
    this.#entries.set(requestId, { ...entry, state: 'COMPLETED', responseHash });
    return this;
  }

  state(requestId) { return this.#entries.get(requestId)?.state ?? 'UNKNOWN'; }
  snapshot() { return [...this.#entries.entries()].map(([requestId, entry]) => ({ requestId, ...entry })); }
}

export { upstreamPin };
