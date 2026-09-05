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

/**
 * Exact reviewed canonical signer commit. Provenance is pinned to this SHA alone: never to a
 * branch name, a tag, or "whatever HEAD happens to be".
 *
 * PRE_ENABLEMENT_CANONICAL_COMMIT is the earlier reviewed checkpoint, in which the canonical
 * bridge refused real custody unconditionally. REVIEWED_CANONICAL_COMMIT is the reviewed
 * human-gated checkpoint: real custody is reachable in source only behind the canonical child's
 * own interactive operator confirmation. Both are retained so the transition stays auditable.
 */
export const PRE_ENABLEMENT_CANONICAL_COMMIT = 'a1c7d9ae31e2e5c11387dde91ff4945d25ceea10';
export const REVIEWED_CANONICAL_COMMIT = '124d621dd8c68b04bed79744ab332e8305093d02';

/**
 * Gate A is mode-aware. `gateA(string)` is retained as a fail-closed legacy compatibility call.
 *
 * The detached decision is architectural eligibility. It is not an authorization: real custody
 * additionally requires `humanApproved`, which a caller may pass only after a live interactive
 * operator confirmation in this same process. Nothing readable from argv, environment, a file, or
 * a previous run sets it, and the default is false.
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
    humanApproved = false,
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
    // PHASE 3A.10.3. Real custody became architecturally eligible, never automatic: without a live
    // human approval taken in this same process it is still refused, and refusal is the default.
    if (realCustody && !humanApproved) findings.push('REAL_CUSTODY_REQUIRES_HUMAN_APPROVAL');
    if (publicPostingEnabled) findings.push('PUBLIC_POSTING_ENABLED');
  }
  const decision = findings.length === 0 ? 'ALLOW_ARCHITECTURE' : 'REFUSE';
  return Object.freeze({
    ok: decision === 'ALLOW_ARCHITECTURE', mode, canonicalCommit, nonceEvidenceSha,
    networkCalls, localNonceConsumed, skippedNonceAllowed, nonceRollbackUsed,
    realCustody, humanApproved, publicPostingEnabled, decision,
    sideEffectClass,
    safeToInvoke: decision === 'ALLOW_ARCHITECTURE',
    findings: Object.freeze(findings),
  });
}

/**
 * PHASE 3A.10.4 — THE PHASE 3A4R4 REAL COMMAND IS RETIRED IN SOURCE.
 *
 * Historical truth, sanitized, recorded here because it is the reason for the closure:
 * `pnpm airlock:real-detached-sign` was executed by the human operator TWICE, in two separate
 * process invocations, and the process-local budget below could not see across that boundary.
 *
 *   REAL_SIGNATURE_ATTEMPTS_OBSERVED = 2
 *   LOCAL_NONCES_OBSERVED_CONSUMED   = 1, then 2
 *   LOCAL_VERIFICATION               = PASS for both operator-reported runs
 *   PUBLIC_SUBMISSIONS               = 0 (TRANSPORT_OBJECTS=0, NETWORK_SUBMISSION=NONE)
 *
 * Phase 3A4R4's cryptographic purpose is achieved, so its real path is closed permanently and
 * unconditionally at source level rather than by durable state: a source constant cannot be
 * cleared by deleting a local file. The durable one-shot primitive in ./attempt-budget.mjs is the
 * mechanism for FUTURE high-risk operations; this constant is the retirement of this one.
 *
 * Phase 3B must NOT revive this command. It gets its own separately reviewed operation path, its
 * own budget identity, and its own approval.
 */
export const PHASE3A4R4_CLOSURE = Object.freeze({
  phase: 'PHASE3A4R4',
  purpose: 'PHASE3A4R4_REAL_PROTECTED_CUSTODY_PROOF',
  state: 'CLOSED',
  finding: 'CROSS_PROCESS_REAL_SIGNATURE_BUDGET_BYPASS',
  realSignatureAttemptsObserved: 2,
  localNoncesObservedConsumed: Object.freeze([1, 2]),
  publicSubmissionsObserved: 0,
  rawSignaturesPersisted: false,
  reason: 'REAL_EXECUTION_BUDGET_EXHAUSTED',
  evidenceBasis: 'SANITIZED_OPERATOR_EXECUTION_REPORT',
  reopenable: false,
  successor: 'PHASE3B_SEPARATELY_REVIEWED_OPERATION_PATH',
});

/**
 * The single fail-closed gate for the retired Phase 3A4R4 real path.
 *
 * Called before operator approval, before the canonical child, before custody, before the nonce,
 * and before signing. There is no argument, environment variable, flag, or state file that makes
 * it pass: it throws whenever real custody is requested for this purpose.
 */
export function assertPhase3a4r4RealPathClosed({ custody = 'real', purpose = PHASE3A4R4_CLOSURE.purpose } = {}) {
  if (custody !== 'real') return Object.freeze({ closed: true, applies: false, custody });
  throw new Error(
    'PHASE3A4R4_CLOSED\nREAL_EXECUTION_BUDGET_EXHAUSTED\n'
    + `PURPOSE ${purpose}\n`
    + `FINDING ${PHASE3A4R4_CLOSURE.finding}\n`
    + `HISTORICAL_REAL_SIGNATURE_ATTEMPTS ${PHASE3A4R4_CLOSURE.realSignatureAttemptsObserved}\n`
    + `HISTORICAL_LOCAL_NONCES_OBSERVED ${PHASE3A4R4_CLOSURE.localNoncesObservedConsumed.join(',')}\n`
    + 'HISTORICAL_PUBLIC_SUBMISSIONS 0\n'
    + 'The Phase 3A4R4 real detached-signing proof is retired. Its real path is closed in source '
    + 'and cannot be reopened by a flag, an environment variable, or by deleting local state. '
    + 'Fixture validation remains available. Real Phase 3B signing requires a separately reviewed '
    + 'Phase 3B operation path, not this command.',
  );
}

export const MAX_REAL_SIGNATURES = 1;

/**
 * A PROCESS-LOCAL permit book for real canonical signer invocations.
 *
 * SCOPE, STATED PRECISELY, BECAUSE IT WAS ONCE OVERSTATED: this class counts inside ONE process.
 * It stops a loop or a retry within a single run. It does NOT and never did stop an operator from
 * running the command again, because a new process starts with `#consumed = 0`.
 *
 * Phase 3A.10.4 recorded that exact bypass as CROSS_PROCESS_REAL_SIGNATURE_BUDGET_BYPASS after two
 * separate operator invocations each acquired a fresh limit of 1. The earlier reasoning here — that
 * "a fresh process is already a fresh explicit operator decision" — is the assumption that failed:
 * relaunching a command is far too cheap to be treated as a deliberate second authorization.
 *
 * Cross-process one-shot enforcement therefore lives in ./attempt-budget.mjs, which is durable.
 * This class is retained as the in-process layer only; it is not a one-shot guarantee on its own.
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
