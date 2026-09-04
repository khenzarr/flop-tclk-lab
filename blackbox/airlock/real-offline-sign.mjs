// SPDX-License-Identifier: Apache-2.0
//
// PHASE 3A.4 OPERATOR-ONLY ENTRYPOINT.
//
// This command is intentionally a Gate-A refusal at the adopted audit result. It is not a
// disguised mock, does not import the canonical project, and cannot contact a signer. A future
// phase may replace the refusal only after a new authoritative side-effect audit proves a
// proceedable class and receives a new explicit operator decision.

import { prepareFrame, sha256 } from './prepare.mjs';
import { buildRequest, approveRequest, requestIsIntact } from './envelope.mjs';
import { gateA, AUDITED_SIGNER_SIDE_EFFECT_CLASS, MAX_REAL_SIGNATURES } from './budget.mjs';
import { buildRehearsalAccept, assertNonReuse, phase3bFootprint } from './rehearsal.mjs';

const REQUIRED_MODE = 'PHASE3A4_REAL_OFFLINE_SIGNATURE';

function stop(message) {
  console.error(message);
  process.exitCode = 1;
}

console.error('REAL CANONICAL SIGNATURE');
console.error('OFFLINE ONLY');
console.error('NO TECHNOCORE POST');
console.error(`MAX SIGNATURES: ${MAX_REAL_SIGNATURES}`);

if (process.env.FLOPLAB_PHASE3A4_MODE !== REQUIRED_MODE) {
  stop(`REFUSED: set FLOPLAB_PHASE3A4_MODE=${REQUIRED_MODE} for the explicit operator-only mode`);
} else {
  const rehearsal = buildRehearsalAccept();
  const prepared = prepareFrame(rehearsal.frame, { offlineRehearsalRoom: rehearsal.room });
  const request = buildRequest(prepared, { createdAt: '2023-11-14T22:13:20.000Z' });
  const approval = approveRequest(request, { approvedAt: '2023-11-14T22:13:21.000Z' });
  const nonReuse = assertNonReuse({
    room: rehearsal.room,
    contractId: rehearsal.contractId,
    canonicalHash: prepared.canonicalHash,
    requestId: request.requestId,
    requestFingerprint: request.requestFingerprint,
  }, phase3bFootprint());
  if (!nonReuse.ok) {
    stop(`REFUSED: OFFLINE_REHEARSAL_ARTIFACT collision (${nonReuse.findings.join(', ')})`);
  } else if (!requestIsIntact(request)) {
    stop('REFUSED: request fingerprint is invalid');
  } else {
    const gate = gateA(AUDITED_SIGNER_SIDE_EFFECT_CLASS);
    console.error('PHASE 3A.4 — REAL OFFLINE SIGNATURE');
    console.error(`FRAME TYPE: ${rehearsal.frameType}`);
    console.error(`PURPOSE: ${rehearsal.purpose}`);
    console.error(`ROOM: ${rehearsal.room}`);
    console.error('TCLK PIN: d48e873...');
    console.error(`CANONICAL HASH: ${sha256(prepared.canonicalPayload)}`);
    console.error('BYTE FREEZE: PASS');
    console.error('PUBLIC POSTING: DISABLED');
    console.error('REAL SIGNATURE: ONE ONLY');
    stop(`GATE A REFUSED: ${gate.sideEffectClass}; signer contact was not attempted`);
  }
}