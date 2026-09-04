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

/** The classification vocabulary from the phase contract, in escalating order of danger. */
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

/** Gate A. Returns findings; the caller stops on any finding. */
export function gateA(sideEffectClass = AUDITED_SIGNER_SIDE_EFFECT_CLASS) {
  const findings = [];
  if (!SIDE_EFFECT_CLASSES.includes(sideEffectClass)) findings.push('SIDE_EFFECT_CLASS_UNRECOGNISED');
  else if (!PROCEEDABLE_CLASSES.includes(sideEffectClass)) findings.push(`SIGNER_SIDE_EFFECT_${sideEffectClass}`);
  return Object.freeze({
    ok: findings.length === 0,
    sideEffectClass,
    safeToInvoke: findings.length === 0,
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
