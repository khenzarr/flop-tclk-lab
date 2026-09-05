// PHASE 3A.10.3 — THE ONE PRODUCTION CONTROL FLOW FOR THE HUMAN DETACHED-SIGNING ROUTE.
//
// The operator entrypoint and the fixture end-to-end validation both run THIS function. Exactly
// two seams may be substituted, and nothing else:
//
//   * the interactive input provider (the human channel, plus the streams its TTY check reads);
//   * the custody handoff, selected by `custody: 'fixture' | 'real'`.
//
// Every gate, every ordering rule, and every refusal below is therefore shared by the real route
// and by its automated proof. Approval is never accepted from argv, environment, a file, or a
// previous run: the phrase is derived from the frozen request and typed into a terminal this
// process owns. A second, independent human confirmation happens inside the canonical child.
// PHASE 3A.10.4 additions:
//   * the Phase 3A4R4 REAL path is CLOSED in source. Real custody now refuses here, before the
//     approval prompt, the canonical child, custody, the nonce, and signing;
//   * the surviving fixture path spends a DURABLE one-shot attempt budget immediately before the
//     signer boundary, so "one attempt" now means one attempt per machine, not one per process.
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertPhase3a4r4RealPathClosed, gateA, SIGNING_MODES, REVIEWED_CANONICAL_COMMIT } from './budget.mjs';
import { acquireOneShotAttempt, BUDGET_ROOT } from './attempt-budget.mjs';
import { prepareFrame } from './prepare.mjs';
import { buildRequest } from './envelope.mjs';
import { assertNonReuse, buildRehearsalAccept, phase3bFootprint } from './rehearsal.mjs';
import {
  approvalCode, promptHumanOperator, recheckApprovalBinding,
  requireInteractiveOperatorTerminal, reviewSnapshot,
} from './operator-approval.mjs';
import { invokeDetachedBridge } from './detached-bridge.mjs';
import { canonicalMessage, cleanText, verifyEd25519 } from './signer.mjs';

export const TCLK_PIN = 'd48e87343200e3115e243df39e8f295f5ce2e645';
export const ROUTE_PURPOSE = 'PHASE3A4R4_REAL_PROTECTED_CUSTODY_PROOF';

/** Deterministic: one frame, one clock, one pin set always freeze to the same request id. */
export function prepareRealRoute({ createdAt = '2023-11-14T22:13:20.000Z' } = {}) {
  const rehearsal = buildRehearsalAccept();
  const prepared = prepareFrame(rehearsal.frame, { offlineRehearsalRoom: rehearsal.room });
  const request = buildRequest(prepared, { createdAt });
  const nonReuse = assertNonReuse({
    room: rehearsal.room, contractId: rehearsal.contractId, canonicalHash: prepared.canonicalHash,
    requestId: request.requestId, requestFingerprint: request.requestFingerprint,
  }, phase3bFootprint());
  const metadata = Object.freeze({ canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: TCLK_PIN });
  return Object.freeze({ rehearsal, prepared, request, nonReuse, metadata, review: reviewSnapshot(request, metadata) });
}

/** Public binding values only. No payload secret, no credential, and never a signature. */
function displayReview({ request, review }, log) {
  log('------------------------------------------------');
  log('TCLK BLACKBOX — REAL DETACHED SIGNATURE');
  log('------------------------------------------------');
  log(`PURPOSE\n${ROUTE_PURPOSE}`);
  log(`\nFRAME TYPE\n${request.frameType}`);
  log(`\nSYNTHETIC ROOM\n${review.room}`);
  log(`\nTCLK PIN\n${review.tclkPin}`);
  log(`\nCANONICAL SIGNER COMMIT\n${review.canonicalCommit}`);
  log(`\nCANONICAL FRAME HASH\n${review.canonicalHash}`);
  log(`\nREQUEST FINGERPRINT\n${review.requestFingerprint}`);
  log(`\nAPPROVAL CODE\n${approvalCode(request)}`);
  log('\nBYTE FREEZE\nPASS\nPHASE 3B REUSE\nNO\nNETWORK SUBMISSION\nDISABLED'
    + '\nLOCAL NONCE\nONE WILL BE CONSUMED\nMAX REAL SIGNATURES\n1\nRETRY\nDISABLED'
    + '\nREAL EXECUTION BUDGET\nDURABLE — ONE ATTEMPT PER MACHINE, NOT PER PROCESS'
    + '\nHUMAN CHECKPOINTS\n2 — THIS TERMINAL, THEN THE CANONICAL CHILD');
}

/**
 * Run the route once: review, human approval, TOCTOU recheck, custody handoff, local verify, STOP.
 *
 * There is no retry anywhere in this function. A refusal is terminal for the process, because a
 * second attempt is a new explicit operator decision and must look like one.
 */
export async function runDetachedSigningRoute({
  custody = 'real',
  streams = { stdin: process.stdin, stdout: process.stdout },
  approvalProvider = null,
  bridge = invokeDetachedBridge,
  log = console.log,
  preflightOnly = false,
  createdAt = undefined,
  recheckMetadata = null,
  budgetRoot = null,
} = {}) {
  // 1. Nothing at all happens unless a human owns this terminal.
  requireInteractiveOperatorTerminal(streams);

  // 2. PHASE 3A.10.4 RETIREMENT. The real Phase 3A4R4 path is closed in source and refuses here —
  // before the approval prompt, the canonical child, custody, the nonce, and signing. Fixture
  // custody continues, so end-to-end validation of this exact control flow is preserved.
  assertPhase3a4r4RealPathClosed({ custody, purpose: ROUTE_PURPOSE });

  const route = prepareRealRoute(createdAt ? { createdAt } : {});
  const { request, review } = route;
  const architecture = gateA({ mode: SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION, realCustody: false });
  displayReview(route, log);
  if (!route.nonReuse.ok || !architecture.ok) throw new Error('REFUSED: preflight safety gate failed');
  if (preflightOnly) {
    log('\nPREFLIGHT-ONLY: STOP — no approval, custody, nonce, or signature.');
    return Object.freeze({ stopped: 'PREFLIGHT_ONLY', requestId: request.requestId, verified: false, posted: false });
  }

  // 3. First human checkpoint: a phrase derived from these exact frozen bytes.
  const approve = approvalProvider ?? (frozen => promptHumanOperator(frozen, streams));
  const approval = await approve(request);
  if (!approval.ok) {
    throw new Error(approval.code === 'OPERATOR_CANCELLED'
      ? 'OPERATOR_CANCELLED: no custody was attempted'
      : 'WRONG_APPROVAL_CODE: no custody was attempted');
  }

  // 4. Post-approval TOCTOU recheck: approval binds to what was reviewed, or it is void.
  const unchanged = recheckApprovalBinding(request, review, recheckMetadata ?? route.metadata);
  if (!unchanged.ok) throw new Error(`APPROVAL_INVALIDATED: ${unchanged.findings.join(',')}`);

  // 5. Authorization gate. Real custody is refused here unless a live human approved in step 3.
  const authorized = gateA({
    mode: SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION,
    realCustody: custody === 'real', humanApproved: true,
  });
  if (!authorized.ok) throw new Error(`REFUSED: ${authorized.findings.join(',')}`);
  log('\nAPPROVED — handing off to canonical protected custody.'
    + '\nThe canonical child asks for its own confirmation, and any credential prompt is typed'
    + '\ndirectly into that child. This process never sees it.');

  // 6. DURABLE ONE-SHOT BUDGET, spent immediately before the irreversible signer boundary and
  // never rolled back afterwards. This is the cross-process fix: a second invocation cannot
  // acquire the same budget, where the old process-local permit book handed every fresh process a
  // fresh permit. Refusal throws, so it cannot be ignored into a second signature.
  //
  // Real custody would use the machine-wide durable root, but real custody can no longer reach
  // this line at all. Fixture custody must stay repeatable for CI, so its default root is a
  // throwaway per-process directory; tests pass an explicit root to prove the durable semantics.
  const attemptRoot = budgetRoot ?? (custody === 'real'
    ? BUDGET_ROOT
    : resolve(tmpdir(), `tclk-fixture-attempt-budget-${process.pid}-${randomUUID()}`));
  const attempt = acquireOneShotAttempt({
    purpose: ROUTE_PURPOSE,
    operationClass: custody === 'real' ? 'REAL_DETACHED_ROOM_SIGNATURE' : 'FIXTURE_DETACHED_ROOM_SIGNATURE',
    subject: request.requestFingerprint,
  }, { root: attemptRoot });
  log(`\nREAL EXECUTION BUDGET\nSPENT — ${attempt.budgetId.slice(0, 16)} (durable, never rolled back)`);

  // 7. Protected-custody handoff. stdout of the child is captured, never echoed.
  const operation = await bridge({
    room: review.room, text: request.canonicalPayload, requestId: request.requestId, custody,
  });

  // 8. Local cryptographic verification over the approved bytes. The returned DID is the custody
  // identity, so it is verified for self-consistency and is not compared to the synthetic frame
  // author; room, text, provenance, and custody mode are all bound.
  const bound = operation.room === review.room
    && cleanText(operation.text) === cleanText(request.canonicalPayload)
    && operation.canonicalCommit === REVIEWED_CANONICAL_COMMIT
    && operation.custodyMode === custody;
  const verified = bound
    && verifyEd25519(operation.did, canonicalMessage(operation.room, operation.nonce, operation.text), operation.signature);
  if (!verified) throw new Error('REFUSED: the returned operation did not verify against the approved bytes');

  // 9. STOP. No submission surface exists on this route, so there is nothing to decline.
  log('\nLOCAL VERIFICATION\nPASS'
    + `\n\nSIGNER DID\n${operation.did}`
    + `\n\nROOM\n${operation.room}`
    + `\n\nLOCAL NONCE CONSUMED\n${operation.nonce}`
    + `\n\nCUSTODY MODE\n${operation.custodyMode}`
    + '\n\nRAW SIGNATURE\nWITHHELD — CAPTURED, NEVER PRINTED'
    + '\n\nTRANSPORT OBJECTS\n0\nNETWORK SUBMISSION\nNONE\nPOSTED\nfalse'
    + '\n\nSTOP — one signature was produced and the budget is spent.');
  return Object.freeze({
    requestId: request.requestId, room: operation.room, did: operation.did, nonce: operation.nonce,
    custodyMode: operation.custodyMode, canonicalCommit: operation.canonicalCommit,
    approvalCode: approvalCode(request), signatureLength: operation.signature.length,
    verified: true, postEligible: true, posted: false, submitted: false, transportObjects: 0,
    oneShotBudgetSpent: true, budgetId: attempt.budgetId,
  });
}
