// Phase 3B.2-PREP command surface. SIGN is the only reachable human-gated operation;
// SUBMIT and OBSERVE remain deliberately unavailable. The budget owner lives here, immediately
// before the irreversible canonical signer boundary, never inside the detached bridge.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFrame } from './airlock/prepare.mjs';
import { buildRequest } from './airlock/envelope.mjs';
import { approvalCode, promptHumanOperator, recheckApprovalBinding, reviewSnapshot } from './airlock/operator-approval.mjs';
import { acquireOneShotAttempt, inspectOneShotAttempt, BUDGET_ROOT } from './airlock/attempt-budget.mjs';
import { assertReviewedCanonicalWorktree, invokeRealDetachedBridge } from './airlock/detached-bridge.mjs';
import { REVIEWED_CANONICAL_COMMIT } from './airlock/budget.mjs';
import { canonicalMessage, cleanText, verifyEd25519 } from './airlock/signer.mjs';
import { readPendingSignedOperation, writePendingSignedOperation } from './phase3b2.mjs';

export const SIGNED_TEXT_SOURCE = 'ATTESTED_TCLK_CANONICAL_FRAME';
export const REAL_SIGN_BUDGET_OWNER = 'blackbox/phase3b2-cli.mjs/runRealSign';
export const RECOVERY_SUBJECT = 'phase3b-write-1-sign-attempt-2';
export const SIGN_BUDGET_IDENTITY = Object.freeze({ purpose: 'PHASE3B_SIGN', operationClass: 'REAL_DETACHED_ROOM_SIGNATURE' });
const OPERATION = 'phase3b-write-1';
const FIRST_SIGN_IDENTITY = Object.freeze({ ...SIGN_BUDGET_IDENTITY, subject: OPERATION });
const RECOVERY_SIGN_IDENTITY = Object.freeze({ ...SIGN_BUDGET_IDENTITY, subject: RECOVERY_SUBJECT });
const MANIFEST_PATH = resolve('evidence/phase3b-exact-manifest.json');
const PREVIEW_PATH = resolve('evidence/phase3b-write1-execution-preview.json');
export const PENDING_SIGNED_OPERATION_ROOT = resolve('blackbox/state/phase3b-pending-signed');
const operationPattern = /^phase3b-write-[1-6]$/;

function usage() {
  console.error('USAGE: phase3b2-cli.mjs sign --operation phase3b-write-1 [--preflight]');
  process.exitCode = 2;
}

export async function loadExactManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (manifest.frozen !== true || manifest.signed !== false || typeof manifest.manifestRoot !== 'string') throw new Error('FROZEN_MANIFEST_INVALID');
  return manifest;
}

function manifestFrame(manifest, operationId) {
  const frame = manifest.frameSet?.frames?.find(candidate => `phase3b-write-${candidate.write}` === operationId);
  if (!frame || frame.write !== 1 || frame.type !== 'offer') throw new Error('WRITE1_FRAME_NOT_FROZEN');
  return frame;
}

function attestPayload(frame) {
  const prepared = prepareFrame(frame.canonicalFrame);
  if (prepared.canonicalHash !== frame.canonicalFrameHash) throw new Error('CANONICAL_FRAME_HASH_MISMATCH');
  if (prepared.payloadBytes !== frame.payloadBytes) throw new Error('CANONICAL_FRAME_LENGTH_MISMATCH');
  return prepared;
}

export function resolveSignBudgetIdentity({ firstStatus, recoveryStatus, pendingSignedOperation = null }) {
  if (pendingSignedOperation !== null) throw new Error('PENDING_SIGNED_OPERATION_EXISTS');
  if (firstStatus?.state === 'SPENT') {
    if (recoveryStatus?.state !== 'AVAILABLE') throw new Error('RECOVERY_SIGN_ALREADY_SPENT_OR_UNAVAILABLE');
    return RECOVERY_SIGN_IDENTITY;
  }
  if (firstStatus?.state !== 'AVAILABLE') throw new Error('FIRST_SIGN_BUDGET_STATE_INVALID');
  return FIRST_SIGN_IDENTITY;
}

function pendingSignedOperation(operationId, manifestRoot) {
  const path = resolve(PENDING_SIGNED_OPERATION_ROOT, `${operationId}.json`);
  try { return readPendingSignedOperation(path, manifestRoot, operationId); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function verifyCanonicalSignedOperation(response, frozen) {
  const bound = response.room === frozen.room
    && cleanText(response.text) === cleanText(frozen.text)
    && response.text === frozen.text
    && response.did === frozen.expectedSignerDid
    && response.canonicalCommit === REVIEWED_CANONICAL_COMMIT
    && response.custodyMode === 'real';
  return bound && verifyEd25519(response.did, canonicalMessage(response.room, response.nonce, response.text), response.signature);
}

function pendingRecord(response, frozen) {
  return Object.freeze({
    schema: 'tclk/1-signed-operation', manifestRoot: frozen.manifest.manifestRoot,
    operationId: frozen.requestId, did: response.did, room: response.room, nonce: response.nonce,
    text: response.text, signature: response.signature,
    integrity: createHash('sha256').update(`${frozen.manifest.manifestRoot}|${frozen.requestId}|${response.did}|${response.room}|${response.nonce}|${response.text}|${response.signature}`, 'utf8').digest('hex'),
  });
}

export async function frozenOperation(operationId = OPERATION) {
  if (!operationPattern.test(operationId)) throw new Error('operation selector is invalid');
  if (operationId !== OPERATION) throw new Error('operation is not frozen for real SIGN');
  const [manifest, preview] = await Promise.all([
    loadExactManifest(), readFile(PREVIEW_PATH, 'utf8').then(JSON.parse),
  ]);
  if (preview.operationId !== operationId || preview.manifestRoot !== manifest.manifestRoot) throw new Error('FROZEN_MANIFEST_ROOT_MISMATCH');
  if (preview.runtime?.signingCommit !== REVIEWED_CANONICAL_COMMIT) throw new Error('frozen canonical signer is invalid');
  const frame = manifestFrame(manifest, operationId);
  const prepared = attestPayload(frame);
  if (prepared.signerDid !== preview.signerDid || prepared.intendedRoom !== preview.room) throw new Error('FROZEN_WRITE1_BINDING_MISMATCH');
  const request = buildRequest(prepared, { createdAt: '2026-01-01T00:00:00.000Z' });
  return Object.freeze({ manifest, preview, frame, prepared, request, room: prepared.intendedRoom,
    text: prepared.canonicalPayload, requestId: operationId, profile: 'default', expectedSignerDid: prepared.signerDid });
}

function showReview(frozen, recoveryStatus) {
  const { request } = frozen;
  const review = reviewSnapshot(request, { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: frozen.manifest.provenance.tclkPin, phase3bReuse: 'NO' });
  console.log('------------------------------------------------');
  console.log('TCLK BLACKBOX — WRITE #1 OFFER SIGN RECOVERY');
  console.log('------------------------------------------------');
  console.log(`FRAME TYPE\n${request.frameType}\n\nROOM\n${review.room}\n\nSIGNER DID\n${review.signerDid}`);
  console.log(`\nCANONICAL FRAME HASH\n${review.canonicalHash}\n\nCANONICAL PAYLOAD BYTES\n${request.payloadBytes}`);
  console.log(`\nMANIFEST ROOT\n${frozen.manifest.manifestRoot}\n\nSIGNED TEXT SOURCE\n${SIGNED_TEXT_SOURCE}`);
  console.log(`\nAPPROVAL CODE\n${approvalCode(request)}\n\nATTEMPT 1\n${recoveryStatus.state}\nRECOVERY SUBJECT\n${RECOVERY_SUBJECT}`);
  console.log('\nNETWORK SUBMISSION\nDISABLED\nSTOP AFTER LOCAL VERIFICATION');
  return review;
}

/** Sole production budget owner: review, approval, TOCTOU, then one acquisition at the boundary. */
export async function runRealSign({ operationId = OPERATION, preflight = false } = {}) {
  const frozen = await frozenOperation(operationId);
  await assertReviewedCanonicalWorktree();
  const firstStatus = inspectOneShotAttempt(FIRST_SIGN_IDENTITY);
  const recoveryStatus = inspectOneShotAttempt(RECOVERY_SIGN_IDENTITY);
  const pending = pendingSignedOperation(operationId, frozen.manifest.manifestRoot);
  const signIdentity = resolveSignBudgetIdentity({ firstStatus, recoveryStatus, pendingSignedOperation: pending });
  const review = showReview(frozen, firstStatus);
  if (preflight) return Object.freeze({ stopped: 'PREFLIGHT_ONLY', budgetMutations: 0, requestId: frozen.requestId,
    signSubject: signIdentity.subject, signBudgetState: inspectOneShotAttempt(signIdentity).state, verified: false, posted: false });
  const approval = await promptHumanOperator(frozen.request);
  if (!approval.ok) throw new Error(approval.code === 'OPERATOR_CANCELLED' ? 'OPERATOR_CANCELLED: no custody was attempted' : 'WRONG_APPROVAL_CODE: no custody was attempted');
  const unchanged = recheckApprovalBinding(frozen.request, review, { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: frozen.manifest.provenance.tclkPin, phase3bReuse: 'NO' });
  if (!unchanged.ok) throw new Error(`APPROVAL_INVALIDATED: ${unchanged.findings.join(',')}`);
  await assertReviewedCanonicalWorktree();
  const signBudget = acquireOneShotAttempt(signIdentity, { root: BUDGET_ROOT });
  const response = await invokeRealDetachedBridge({ ...frozen, requestId: signIdentity.subject, signBudget });
  if (!verifyCanonicalSignedOperation(response, frozen)) throw new Error('REFUSED: canonical signer response did not verify against WRITE1');
  const saved = writePendingSignedOperation(pendingRecord(response, frozen), PENDING_SIGNED_OPERATION_ROOT);
  return Object.freeze({ requestId: frozen.requestId, room: response.room, did: response.did, nonce: response.nonce,
    custodyMode: response.custodyMode, canonicalCommit: response.canonicalCommit, budgetId: signBudget.budgetId,
    pendingPath: saved.path, pendingSha256: saved.sha256, verified: true, posted: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, flag, selected, maybePreflight] = process.argv.slice(2);
  if (!['sign', 'submit', 'observe'].includes(command) || flag !== '--operation' || !operationPattern.test(selected ?? '') || (maybePreflight !== undefined && maybePreflight !== '--preflight')) usage();
  else if (command === 'submit' || command === 'observe') { console.error('REAL_SUBMIT_AND_OBSERVE_DISABLED: no network or transport is reachable.'); process.exitCode = 3; }
  else {
    try { process.stdout.write(`${JSON.stringify(await runRealSign({ operationId: selected, preflight: maybePreflight === '--preflight' }))}\n`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}