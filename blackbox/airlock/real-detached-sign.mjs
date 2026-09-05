// Phase 3A.9 HUMAN-ONLY OPERATOR ENTRYPOINT. It intentionally stops before custody in this phase.
import { gateA, SIGNING_MODES, REVIEWED_CANONICAL_COMMIT } from './budget.mjs';
import { prepareFrame } from './prepare.mjs';
import { buildRequest } from './envelope.mjs';
import { buildRehearsalAccept, assertNonReuse, phase3bFootprint } from './rehearsal.mjs';
import { promptHumanOperator, requireInteractiveOperatorTerminal, approvalCode, reviewSnapshot, recheckApprovalBinding } from './operator-approval.mjs';

try {
  requireInteractiveOperatorTerminal();
  const preflightOnly = process.argv.slice(2).every(arg => arg === '--preflight-only');
  if (process.argv.slice(2).length && !preflightOnly) throw new Error('REFUSED: unsupported option; approval cannot be supplied by CLI');
  const rehearsal = buildRehearsalAccept();
  const prepared = prepareFrame(rehearsal.frame, { offlineRehearsalRoom: rehearsal.room });
  const request = buildRequest(prepared, { createdAt: '2023-11-14T22:13:20.000Z' });
  const nonReuse = assertNonReuse({ room: rehearsal.room, contractId: rehearsal.contractId, canonicalHash: prepared.canonicalHash, requestId: request.requestId, requestFingerprint: request.requestFingerprint }, phase3bFootprint());
  const gate = gateA({ mode: SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION, realCustody: false });
  const review = reviewSnapshot(request, { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: 'd48e87343200e3115e243df39e8f295f5ce2e645' });
  console.log('------------------------------------------------');
  console.log('TCLK BLACKBOX — REAL DETACHED SIGNATURE');
  console.log('------------------------------------------------');
  console.log('PURPOSE\nPHASE3A4R4_REAL_PROTECTED_CUSTODY_PROOF');
  console.log(`\nFRAME TYPE\n${request.frameType}`);
  console.log(`\nSYNTHETIC ROOM\n${review.room}`);
  console.log(`\nTCLK PIN\n${review.tclkPin}`);
  console.log(`\nCANONICAL SIGNER COMMIT\n${review.canonicalCommit}`);
  console.log(`\nCANONICAL FRAME HASH\n${review.canonicalHash}`);
  console.log(`\nREQUEST FINGERPRINT\n${review.requestFingerprint}`);
  console.log(`\nAPPROVAL CODE\n${approvalCode(request)}`);
  console.log('\nBYTE FREEZE\nPASS\nPHASE 3B REUSE\nNO\nNETWORK SUBMISSION\nDISABLED\nLOCAL NONCE\nONE WILL BE CONSUMED\nMAX REAL SIGNATURES\n1\nRETRY\nDISABLED');
  if (!nonReuse.ok || !gate.ok) throw new Error('REFUSED: preflight safety gate failed');
  if (preflightOnly) {
    console.log('\nPREFLIGHT-ONLY: STOP — no approval, custody, nonce, or signature.');
  } else {
    const approval = await promptHumanOperator(request);
    if (!approval.ok) throw new Error(approval.code === 'OPERATOR_CANCELLED' ? 'OPERATOR_CANCELLED: no custody was attempted' : 'WRONG_APPROVAL_CODE: no custody was attempted');
    const unchanged = recheckApprovalBinding(request, review);
    if (!unchanged.ok) throw new Error(`APPROVAL_INVALIDATED: ${unchanged.findings.join(',')}`);
    console.log('\nAPPROVED — Phase 3A.9 STOP: real custody is disabled; no nonce or signature was used.');
  }
  process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }