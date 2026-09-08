// Phase 3B command surface. Submit/observe are separate from and never import the signer path.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRealSubmit, runRealObserve } from './phase3b-submit-observe.mjs';

export const SIGNED_TEXT_SOURCE = 'ATTESTED_TCLK_CANONICAL_FRAME';
const OPERATION = 'phase3b-write-1';
const MANIFEST_PATH = resolve('evidence/phase3b-exact-manifest.json');
const PREVIEW_PATH = resolve('evidence/phase3b-write1-execution-preview.json');
export const PENDING_SIGNED_OPERATION_ROOT = resolve('blackbox/state/phase3b-pending-signed');
const operationPattern = /^phase3b-write-[1-6]$/;

function usage() {
  console.error('USAGE: phase3b2-cli.mjs <sign|submit|observe> --operation phase3b-write-1 [--preflight]');
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

function attestPayload(frame, prepareFrame) {
  const prepared = prepareFrame(frame.canonicalFrame);
  if (prepared.canonicalHash !== frame.canonicalFrameHash) throw new Error('CANONICAL_FRAME_HASH_MISMATCH');
  if (prepared.payloadBytes !== frame.payloadBytes) throw new Error('CANONICAL_FRAME_LENGTH_MISMATCH');
  return prepared;
}

export async function runRealSign(options = {}) {
  const [prepare, envelope, approval, budget, bridge, signer, pendingModule] = await Promise.all([
    import('./airlock/prepare.mjs'), import('./airlock/envelope.mjs'), import('./airlock/operator-approval.mjs'),
    import('./airlock/attempt-budget.mjs'), import('./airlock/detached-bridge.mjs'), import('./airlock/signer.mjs'),
    import('./phase3b2.mjs'),
  ]);
  const signing = await import('./airlock/budget.mjs');
  const { operationId = OPERATION, preflight = false } = options;
  const firstSignIdentity = Object.freeze({ purpose: 'PHASE3B_SIGN', operationClass: 'REAL_DETACHED_ROOM_SIGNATURE', subject: operationId });
  const recoverySubject = 'phase3b-write-1-sign-attempt-2';
  const recoverySignIdentity = Object.freeze({ purpose: 'PHASE3B_SIGN', operationClass: 'REAL_DETACHED_ROOM_SIGNATURE', subject: recoverySubject });
  const frozen = await frozenOperation(operationId, { prepareFrame: prepare.prepareFrame, buildRequest: envelope.buildRequest, reviewedCommit: signing.REVIEWED_CANONICAL_COMMIT });
  await bridge.assertReviewedCanonicalWorktree();
  const firstStatus = budget.inspectOneShotAttempt(firstSignIdentity);
  const recoveryStatus = budget.inspectOneShotAttempt(recoverySignIdentity);
  const pending = pendingSignedOperation(operationId, frozen.manifest.manifestRoot, pendingModule.readPendingSignedOperation);
  const signIdentity = resolveSignBudgetIdentity({ firstStatus, recoveryStatus, pendingSignedOperation: pending, firstSignIdentity, recoverySignIdentity });
  const review = showReview(frozen, firstStatus, approval);
  if (preflight) return Object.freeze({ stopped: 'PREFLIGHT_ONLY', budgetMutations: 0, requestId: frozen.requestId,
    signSubject: signIdentity.subject, signBudgetState: budget.inspectOneShotAttempt(signIdentity).state, verified: false, posted: false });
  const approvalResult = await approval.promptHumanOperator(frozen.request);
  if (!approvalResult.ok) throw new Error(approvalResult.code === 'OPERATOR_CANCELLED' ? 'OPERATOR_CANCELLED: no custody was attempted' : 'WRONG_APPROVAL_CODE: no custody was attempted');
  const unchanged = approval.recheckApprovalBinding(frozen.request, review, { canonicalCommit: signing.REVIEWED_CANONICAL_COMMIT, tclkPin: frozen.manifest.provenance.tclkPin, phase3bReuse: 'NO' });
  if (!unchanged.ok) throw new Error(`APPROVAL_INVALIDATED: ${unchanged.findings.join(',')}`);
  await bridge.assertReviewedCanonicalWorktree();
  const signBudget = budget.acquireOneShotAttempt(signIdentity, { root: budget.BUDGET_ROOT });
  const response = await bridge.invokeRealDetachedBridge({ ...frozen, requestId: signIdentity.subject, signBudget });
  if (!verifyCanonicalSignedOperation(response, frozen, signer, signing.REVIEWED_CANONICAL_COMMIT)) throw new Error('REFUSED: canonical signer response did not verify against WRITE1');
  const saved = pendingModule.writePendingSignedOperation(pendingRecord(response, frozen), PENDING_SIGNED_OPERATION_ROOT);
  return Object.freeze({ requestId: frozen.requestId, room: response.room, did: response.did, nonce: response.nonce,
    custodyMode: response.custodyMode, canonicalCommit: response.canonicalCommit, budgetId: signBudget.budgetId,
    pendingPath: saved.path, pendingSha256: saved.sha256, verified: true, posted: false });
}

export function resolveSignBudgetIdentity({ firstStatus, recoveryStatus, pendingSignedOperation = null, firstSignIdentity, recoverySignIdentity }) {
  if (pendingSignedOperation !== null) throw new Error('PENDING_SIGNED_OPERATION_EXISTS');
  if (firstStatus?.state === 'SPENT') {
    if (recoveryStatus?.state !== 'AVAILABLE') throw new Error('RECOVERY_SIGN_ALREADY_SPENT_OR_UNAVAILABLE');
    return recoverySignIdentity;
  }
  if (firstStatus?.state !== 'AVAILABLE') throw new Error('FIRST_SIGN_BUDGET_STATE_INVALID');
  return firstSignIdentity;
}

function pendingSignedOperation(operationId, manifestRoot, readPendingSignedOperation) {
  const path = resolve(PENDING_SIGNED_OPERATION_ROOT, `${operationId}.json`);
  try { return readPendingSignedOperation(path, manifestRoot, operationId); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function verifyCanonicalSignedOperation(response, frozen, signer, reviewedCommit) {
  const bound = response.room === frozen.room
    && response.text === frozen.text
    && response.did === frozen.expectedSignerDid
    && response.canonicalCommit === reviewedCommit
    && response.custodyMode === 'real';
  return bound && signer.verifyEd25519(response.did, signer.canonicalMessage(response.room, response.nonce, response.text), response.signature);
}

function pendingRecord(response, frozen) {
  return Object.freeze({
    schema: 'tclk/1-signed-operation', manifestRoot: frozen.manifest.manifestRoot,
    operationId: frozen.requestId, did: response.did, room: response.room, nonce: response.nonce,
    text: response.text, signature: response.signature,
    integrity: createHash('sha256').update(`${frozen.manifest.manifestRoot}|${frozen.requestId}|${response.did}|${response.room}|${response.nonce}|${response.text}|${response.signature}`, 'utf8').digest('hex'),
  });
}

export async function frozenOperation(operationId = OPERATION, { prepareFrame, buildRequest, reviewedCommit } = {}) {
  if (!operationPattern.test(operationId)) throw new Error('operation selector is invalid');
  if (operationId !== OPERATION) throw new Error('operation is not frozen for real SIGN');
  const [manifest, preview] = await Promise.all([
    loadExactManifest(), readFile(PREVIEW_PATH, 'utf8').then(JSON.parse),
  ]);
  if (preview.operationId !== operationId || preview.manifestRoot !== manifest.manifestRoot) throw new Error('FROZEN_MANIFEST_ROOT_MISMATCH');
  if (preview.runtime?.signingCommit !== reviewedCommit) throw new Error('frozen canonical signer is invalid');
  const frame = manifestFrame(manifest, operationId);
  const prepared = attestPayload(frame, prepareFrame);
  if (prepared.signerDid !== preview.signerDid || prepared.intendedRoom !== preview.room) throw new Error('FROZEN_WRITE1_BINDING_MISMATCH');
  const request = buildRequest(prepared, { createdAt: '2026-01-01T00:00:00.000Z' });
  return Object.freeze({ manifest, preview, frame, prepared, request, room: prepared.intendedRoom,
    text: prepared.canonicalPayload, requestId: operationId, profile: 'default', expectedSignerDid: prepared.signerDid });
}

function showReview(frozen, recoveryStatus, approval) {
  const { request } = frozen;
  const review = approval.reviewSnapshot(request, { canonicalCommit: frozen.preview.runtime.signingCommit, tclkPin: frozen.manifest.provenance.tclkPin, phase3bReuse: 'NO' });
  console.log('------------------------------------------------');
  console.log('TCLK BLACKBOX — WRITE #1 OFFER SIGN RECOVERY');
  console.log('------------------------------------------------');
  console.log(`FRAME TYPE\n${request.frameType}\n\nROOM\n${review.room}\n\nSIGNER DID\n${review.signerDid}`);
  console.log(`\nCANONICAL FRAME HASH\n${review.canonicalHash}\n\nCANONICAL PAYLOAD BYTES\n${request.payloadBytes}`);
  console.log(`\nMANIFEST ROOT\n${frozen.manifest.manifestRoot}\n\nSIGNED TEXT SOURCE\n${SIGNED_TEXT_SOURCE}`);
  console.log(`\nAPPROVAL CODE\n${approval.approvalCode(request)}\n\nATTEMPT 1\n${recoveryStatus.state}\nRECOVERY SUBJECT\nphase3b-write-1-sign-attempt-2`);
  console.log('\nNETWORK SUBMISSION\nDISABLED\nSTOP AFTER LOCAL VERIFICATION');
  return review;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, flag, selected, maybePreflight] = process.argv.slice(2);
  if (!['sign', 'submit', 'observe'].includes(command) || flag !== '--operation' || !operationPattern.test(selected ?? '') || (maybePreflight !== undefined && maybePreflight !== '--preflight')) usage();
  else if (command === 'submit') {
    try { process.stdout.write(`${JSON.stringify(await runRealSubmit({ operationId: selected, preflight: maybePreflight === '--preflight' }))}\n`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  } else if (command === 'observe') {
    if (maybePreflight !== undefined) usage();
    else try { process.stdout.write(`${JSON.stringify(await runRealObserve({ operationId: selected }))}\n`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
  else {
    try { process.stdout.write(`${JSON.stringify(await runRealSign({ operationId: selected, preflight: maybePreflight === '--preflight' }))}\n`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}