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
import { gateA, SIGNING_MODES, REVIEWED_CANONICAL_COMMIT } from './budget.mjs';
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
} = {}) {
  // 1. Nothing at all happens unless a human owns this terminal.
  requireInteractiveOperatorTerminal(streams);
  const route = prepareRealRoute(createdAt ? { createdAt } : {});
  const { request, review } = route;
  const architecture = gateA({ mode: SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION, realCustody: false });
  displayReview(route, log);
  if (!route.nonReuse.ok || !architecture.ok) throw new Error('REFUSED: preflight safety gate failed');
  if (preflightOnly) {
    log('\nPREFLIGHT-ONLY: STOP — no approval, custody, nonce, or signature.');
    return Object.freeze({ stopped: 'PREFLIGHT_ONLY', requestId: request.requestId, verified: false, posted: false });
  }

  // 2. First human checkpoint: a phrase derived from these exact frozen bytes.
  const approve = approvalProvider ?? (frozen => promptHumanOperator(frozen, streams));
  const approval = await approve(request);
  if (!approval.ok) {
    throw new Error(approval.code === 'OPERATOR_CANCELLED'
      ? 'OPERATOR_CANCELLED: no custody was attempted'
      : 'WRONG_APPROVAL_CODE: no custody was attempted');
  }

  // 3. Post-approval TOCTOU recheck: approval binds to what was reviewed, or it is void.
  const unchanged = recheckApprovalBinding(request, review, recheckMetadata ?? route.metadata);
  if (!unchanged.ok) throw new Error(`APPROVAL_INVALIDATED: ${unchanged.findings.join(',')}`);

  // 4. Authorization gate. Real custody is refused here unless a live human approved in step 2.
  const authorized = gateA({
    mode: SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION,
    realCustody: custody === 'real', humanApproved: true,
  });
  if (!authorized.ok) throw new Error(`REFUSED: ${authorized.findings.join(',')}`);
  log('\nAPPROVED — handing off to canonical protected custody.'
    + '\nThe canonical child asks for its own confirmation, and any credential prompt is typed'
    + '\ndirectly into that child. This process never sees it.');

  // 5. Protected-custody handoff. stdout of the child is captured, never echoed.
  const operation = await bridge({
    room: review.room, text: request.canonicalPayload, requestId: request.requestId, custody,
  });

  // 6. Local cryptographic verification over the approved bytes. The returned DID is the custody
  // identity, so it is verified for self-consistency and is not compared to the synthetic frame
  // author; room, text, provenance, and custody mode are all bound.
  const bound = operation.room === review.room
    && cleanText(operation.text) === cleanText(request.canonicalPayload)
    && operation.canonicalCommit === REVIEWED_CANONICAL_COMMIT
    && operation.custodyMode === custody;
  const verified = bound
    && verifyEd25519(operation.did, canonicalMessage(operation.room, operation.nonce, operation.text), operation.signature);
  if (!verified) throw new Error('REFUSED: the returned operation did not verify against the approved bytes');

  // 7. STOP. No submission surface exists on this route, so there is nothing to decline.
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
  });
}
