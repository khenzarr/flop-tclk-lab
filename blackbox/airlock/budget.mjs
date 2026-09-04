// SPDX-License-Identifier: Apache-2.0
//
// PHASE 3A.4 — GATE A CLASSIFICATION AND THE REAL-SIGNATURE BUDGET.
//
// Two independent refusals live here, and both are libraries rather than script prose so tests can
// prove them without a signer anywhere nearby.
//
//   1. GATE A. The recorded, human-audited side-effect classification of the canonical signer's
//      `sign_room` path. Only SIDE_EFFECT_FREE and SAFE_LOCAL_AUDIT_ONLY may proceed to a real
//      signature. The audited value is a constant, not a probe: a runtime probe of a signer is
//      itself an invocation, which is the thing being gated.
//
//   2. THE BUDGET. MAX_REAL_SIGNATURES = 1, enforced process-locally. The permit is consumed
//      BEFORE the signer is contacted, because a signature that fails afterwards has still been
//      produced — decrementing on success would license unlimited retries.

/** Explicit operation modes. Durable local nonce mutation is not equivalent to network I/O. */
export const SIGNING_MODES = Object.freeze({
  LEGACY_COUPLED_ROOM_OPERATION: 'LEGACY_COUPLED_ROOM_OPERATION',
  DETACHED_NETWORK_FREE_ROOM_OPERATION: 'DETACHED_NETWORK_FREE_ROOM_OPERATION',
});

/** The historical classification vocabulary remains available for old evidence and callers. */
export const SIDE_EFFECT_CLASSES = Object.freeze([
  'SIDE_EFFECT_FREE',
  'SAFE_LOCAL_AUDIT_ONLY',
  'DURABLE_NONCE_OR_PROTOCOL_STATE',
  'NETWORK_SIDE_EFFECT',
  'UNKNOWN',
]);

/** The only two classes that permit a real offline signature. */
export const PROCEEDABLE_CLASSES = Object.freeze(['SIDE_EFFECT_FREE', 'SAFE_LOCAL_AUDIT_ONLY']);

/**
 * The Gate A verdict for the canonical local agent at the audited revision.
 *
 * `sign_room` reserves and persists a durable room nonce inside custody before signing, so an
 * offline rehearsal signature would consume protocol state that a future real Technocore
 * operation depends on. See docs/PHASE3A4_SIGNER_SIDE_EFFECT_AUDIT.md for the traced call graph.
 * This constant is the machine-readable form of that document; changing it is a deliberate,
 * reviewable act, not a side effect of a code change elsewhere.
 */
export const AUDITED_SIGNER_SIDE_EFFECT_CLASS = 'DURABLE_NONCE_OR_PROTOCOL_STATE';

export const AUDITED_NONCE_EVIDENCE_SHA = '82d942936050f1ab0fb9f34db17893b89f3e064b';
export const REVIEWED_CANONICAL_COMMIT = '8a2cd163954dd36053fef79e964f5909dc741fa7';

/**
 * Gate A is mode-aware. `gateA(string)` is retained as a fail-closed legacy compatibility call.
 * The detached decision is architectural eligibility only; it never authorizes real custody.
 */
export function gateA(input = {}) {
  if (typeof input === 'string') input = {
    mode: SIGNING_MODES.LEGACY_COUPLED_ROOM_OPERATION,
    sideEffectClass: input,
  };
  const {
    mode = SIGNING_MODES.LEGACY_COUPLED_ROOM_OPERATION,
    canonicalCommit = REVIEWED_CANONICAL_COMMIT,
    nonceEvidenceSha = AUDITED_NONCE_EVIDENCE_SHA,
    networkCalls = mode === SIGNING_MODES.LEGACY_COUPLED_ROOM_OPERATION ? 1 : 0,
    localNonceConsumed = mode === SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION,
    skippedNonceAllowed = true,
    nonceRollbackUsed = false,
    realCustody = false,
    publicPostingEnabled = false,
    detachedMethodExists = mode === SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION,
    transportReference = mode === SIGNING_MODES.LEGACY_COUPLED_ROOM_OPERATION,
    sideEffectClass = mode === SIGNING_MODES.LEGACY_COUPLED_ROOM_OPERATION
      ? (input.sideEffectClass ?? 'NETWORK_SIDE_EFFECT') : 'DURABLE_NONCE_OR_PROTOCOL_STATE',
  } = input;
  const findings = [];
  if (!Object.values(SIGNING_MODES).includes(mode)) findings.push('MODE_UNRECOGNISED');
  if (mode === SIGNING_MODES.LEGACY_COUPLED_ROOM_OPERATION) {
    if (!networkCalls || !transportReference) findings.push('LEGACY_TRANSPORT_CAPABILITY_NOT_BLOCKED');
    findings.push('LEGACY_NETWORK_SUBMISSION_PATH_BLOCKED');
  } else if (mode === SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION) {
    if (canonicalCommit !== REVIEWED_CANONICAL_COMMIT) findings.push('CANONICAL_COMMIT_NOT_REVIEWED');
    if (!detachedMethodExists) findings.push('DETACHED_METHOD_NOT_FOUND');
    if (networkCalls !== 0 || transportReference) findings.push('DETACHED_TRANSPORT_CAPABILITY_PRESENT');
    if (nonceEvidenceSha !== AUDITED_NONCE_EVIDENCE_SHA) findings.push('NONCE_EVIDENCE_NOT_PINNED');
    if (!skippedNonceAllowed) findings.push('SKIPPED_NONCE_NOT_AUTHORIZED');
    if (!localNonceConsumed) findings.push('LOCAL_NONCE_CONSUMPTION_NOT_ACKNOWLEDGED');
    if (nonceRollbackUsed) findings.push('NONCE_ROLLBACK_FORBIDDEN');
    if (realCustody) findings.push('REAL_CUSTODY_FORBIDDEN_IN_PHASE');
    if (publicPostingEnabled) findings.push('PUBLIC_POSTING_ENABLED');
  }
  const decision = findings.length === 0 ? 'ALLOW_ARCHITECTURE' : 'REFUSE';
  return Object.freeze({
    ok: decision === 'ALLOW_ARCHITECTURE', mode, canonicalCommit, nonceEvidenceSha,
    networkCalls, localNonceConsumed, skippedNonceAllowed, nonceRollbackUsed,
    realCustody, publicPostingEnabled, decision,
    sideEffectClass,
    safeToInvoke: decision === 'ALLOW_ARCHITECTURE',
    findings: Object.freeze(findings),
  });
}

export const MAX_REAL_SIGNATURES = 1;

/**
 * A process-local permit book for real canonical signer invocations.
 *
 * Deliberately not persisted: a durable counter would be a durable-state mutation of exactly the
 * kind this phase is auditing, and a fresh process is already a fresh explicit operator decision.
 * The guard's job is to stop a loop or a retry inside one run, and to make a second attempt an
 * error rather than an accident.
 */
export class RealSignatureBudget {
  #limit;
  #consumed = 0;
  #reasons = [];

  constructor(limit = MAX_REAL_SIGNATURES) {
    if (!Number.isInteger(limit) || limit < 0) throw new TypeError('budget: limit must be a non-negative integer');
    this.#limit = limit;
  }

  get limit() { return this.#limit; }
  get consumed() { return this.#consumed; }
  get remaining() { return this.#limit - this.#consumed; }
  get exhausted() { return this.remaining <= 0; }

  /**
   * Take the permit. Call this immediately before contacting the signer, never after.
   *
   * Throws on exhaustion rather than returning false: a caller that ignores a boolean would sign
   * twice, and this is the one guard that must not be ignorable.
   */
  consume(reason = 'real-canonical-signature') {
    if (this.exhausted) {
      throw new Error(
        `budget: refusing real signer invocation — MAX_REAL_SIGNATURES=${this.#limit} already consumed `
        + `(${this.#reasons.join(', ')}). A retry requires a new explicit operator decision in a future phase.`,
      );
    }
    this.#consumed += 1;
    this.#reasons.push(reason);
    return Object.freeze({ permit: this.#consumed, of: this.#limit, reason });
  }

  snapshot() {
    return Object.freeze({
      limit: this.#limit,
      consumed: this.#consumed,
      remaining: this.remaining,
      reasons: Object.freeze([...this.#reasons]),
    });
  }
}
