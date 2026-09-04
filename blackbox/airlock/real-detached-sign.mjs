// Phase 3A.7 future operator entrypoint. It intentionally stops before custody.
import { gateA, SIGNING_MODES, AUDITED_NONCE_EVIDENCE_SHA, REVIEWED_CANONICAL_COMMIT, MAX_REAL_SIGNATURES } from './budget.mjs';

console.error('REAL DETACHED SIGNATURE');
console.error('TCLK PIN: d48e87343200e3115e243df39e8f295f5ce2e645');
console.error(`CANONICAL SIGNER COMMIT: ${REVIEWED_CANONICAL_COMMIT}`);
console.error(`TECHNOCORE NONCE EVIDENCE SHA: ${AUDITED_NONCE_EVIDENCE_SHA}`);
console.error('FRAME TYPE: signed-room');
console.error('SYNTHETIC ROOM: fixture-only preview');
console.error('BYTE FREEZE: REQUIRED');
console.error('NETWORK SUBMISSION: DISABLED');
console.error('LOCAL NONCE: WILL BE CONSUMED (future real execution)');
console.error(`MAX SIGNATURES: ${MAX_REAL_SIGNATURES}`);
const gate = gateA({ mode: SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION, realCustody: false });
console.error(`GATE A: ${gate.decision}`);
console.error('REAL_OPERATOR_APPROVAL_REQUIRED');
process.exitCode = 1;