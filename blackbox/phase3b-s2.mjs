// SPDX-License-Identifier: Apache-2.0
// Isolated production command implementation for the superseding Phase 3B lineage.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../evidence/phase3b-s2-exact-manifest.json' with { type: 'json' };
import finalManifest from '../evidence/phase3b-final-exact-manifest.json' with { type: 'json' };
import { tclk } from '../lab/upstream.mjs';
import { prepareFrame } from './airlock/prepare.mjs';
import { buildRequest } from './airlock/envelope.mjs';
import * as approval from './airlock/operator-approval.mjs';
import { assertReviewedCanonicalWorktree, invokeRealDetachedBridge } from './airlock/detached-bridge.mjs';
import { REVIEWED_CANONICAL_COMMIT } from './airlock/budget.mjs';
import { canonicalMessage, verifyEd25519 } from './airlock/signer.mjs';
import { acquireOneShotAttempt, inspectOneShotAttempt } from './airlock/attempt-budget.mjs';

export const LINEAGE = 'phase3b-s2';
export const ORDER = Object.freeze(['phase3b-s2-write-1', 'phase3b-s2-write-2', 'phase3b-s2-write-3', 'phase3b-s2-write-5', 'phase3b-s2-write-4', 'phase3b-s2-write-6']);
export const ROOTS = Object.freeze({
  pending: resolve('blackbox/state/phase3b-s2/pending-signed'), submit: resolve('blackbox/state/phase3b-s2/submit'),
  rail: resolve('blackbox/state/phase3b-s2/paper-rail'), budget: resolve('blackbox/state/phase3b-s2/attempt-budget'),
  secret: resolve('blackbox/state/phase3b-s2/deal-secret.json'), final: resolve('evidence/local-phase3b-s2-production-capsule.json'),
});
export const MANIFEST = Object.freeze(manifest);
export const FINAL_LINEAGE = 'phase3b-final';
export const FINAL_ORDER = Object.freeze(['phase3b-final-write-1', 'phase3b-final-write-2', 'phase3b-final-write-3', 'phase3b-final-write-5', 'phase3b-final-write-4', 'phase3b-final-write-6']);
export const FINAL_ROOTS = Object.freeze({ pending: resolve('blackbox/state/phase3b-final/pending-signed'), submit: resolve('blackbox/state/phase3b-final/submit'),
  rail: resolve('blackbox/state/phase3b-final/paper-rail'), budget: resolve('blackbox/state/phase3b-final/attempt-budget'),
  secret: resolve('blackbox/state/phase3b-final/deal-secret.json'), final: resolve('evidence/local-phase3b-final-production-capsule.json') });
export const FINAL_MANIFEST = Object.freeze(finalManifest);
export const FINAL_VENUE_ORIGIN = finalManifest.venueOrigin;
export const executionVenue = id => assertVenue(contextForId(id));
export const executionUrl = (id, path) => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('EXECUTION_PATH_INVALID');
  return `${executionVenue(id)}${path}`;
};
export const MAX_HTTP_POST_ATTEMPTS = 1;
export const AUTOMATIC_RETRY = 'NO';
const S2_ORIGIN = 'https://technocore.chat'; const MAX_READ = 65536; const MAX_DIAGNOSTIC = 2048;
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const contextForId = id => id.startsWith('phase3b-final-')
  ? { lineage: FINAL_LINEAGE, order: FINAL_ORDER, roots: FINAL_ROOTS, manifest: finalManifest, origin: finalManifest.venueOrigin }
  : { lineage: LINEAGE, order: ORDER, roots: ROOTS, manifest, origin: S2_ORIGIN };
const assertVenue = context => {
  if (context.lineage === FINAL_LINEAGE && context.origin !== finalManifest.venueOrigin) throw new Error('FINAL_VENUE_MANIFEST_BINDING_REFUSED');
  return context.origin;
};
const op = id => {
  const context = contextForId(id);
  if (!context.order.includes(id)) throw new Error('UNKNOWN_PHASE3B_OPERATION');
  const frame = context.manifest.frameSet.frames.find(x => x.operationId === id);
  if (frame) return { ...frame, actionClass: 'TCLK' };
  const rail = context.manifest.frameSet.paperRailWrites.find(x => x.operationId === id);
  if (rail) return { ...rail, actionClass: 'PaperRail' };
  throw new Error('S2_MANIFEST_OPERATION_MISSING');
};
const persist = (path, value) => { mkdirSync(resolve(path, '..'), { recursive: true }); const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); } return path; };
const bounded = value => Buffer.from(value ?? '', 'utf8').subarray(0, MAX_DIAGNOSTIC).toString('utf8')
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
  .replace(/\bxprv[A-Za-z0-9]{20,}\b/g, '[REDACTED_EXTENDED_PRIVATE_KEY]')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?');
const budgetIdentity = (purpose, operationClass, subject) => ({ purpose, operationClass, subject });
const submitBudgetPurpose = context => context.lineage === LINEAGE ? 'PHASE3B_S2_SUBMIT' : 'PHASE3B_FINAL_SUBMIT';
const railBudgetPurpose = context => context.lineage === LINEAGE ? 'PHASE3B_S2_PAPERRAIL_WRITE' : 'PHASE3B_FINAL_PAPERRAIL_WRITE';
const pendingPath = (id, root = contextForId(id).roots.pending) => resolve(root, `${id}.json`);
const submitPath = (id, root = contextForId(id).roots.submit) => resolve(root, `${id}-submit.json`);
const observationPath = (id, root = contextForId(id).roots.submit) => resolve(root, `${id}-observation.json`);
const correctedObservationPath = (id, root = contextForId(id).roots.submit) => resolve(root, `${id}-corrected-observation.json`);
const observationReconciliationPath = (id, root = contextForId(id).roots.submit) => resolve(root, `${id}-observation-reconciliation.json`);
const receiptPath = (id, root = contextForId(id).roots.rail) => resolve(root, `${id}-write-receipt.json`);
const railObservationPath = (id, root = contextForId(id).roots.rail) => resolve(root, `${id}-production-observation.json`);

function secret(id) {
  const context = contextForId(id); const record = readJson(context.roots.secret);
  if (!/^0x[0-9a-f]{64}$/.test(record.secret) || tclk.hashLockFromPreimage(record.secret).hash !== context.manifest.execution.secretCommitment) throw new Error('PHASE3B_SECRET_COMMITMENT_MISMATCH');
  return record.secret;
}
function payload(spec, id) { return spec.type === 'reveal' ? { ...spec.canonicalFrame, secret: secret(id) } : spec.canonicalFrame; }
function preparedOperation(id) {
  const spec = op(id); if (spec.actionClass !== 'TCLK') throw new Error('S2_UNSIGNED_OPERATION');
  const prepared = prepareFrame(payload(spec, id));
  if (prepared.canonicalHash !== spec.canonicalFrameHash || prepared.payloadBytes !== spec.payloadBytes
    || prepared.intendedRoom !== spec.room || prepared.signerDid !== spec.canonicalFrame.from) throw new Error('S2_MANIFEST_BINDING_REFUSED');
  const request = buildRequest(prepared, { createdAt: '2026-01-01T00:00:00.000Z' });
  return Object.freeze({ spec, prepared, request, room: spec.room, text: prepared.canonicalPayload, expectedSignerDid: prepared.signerDid });
}
function pending(id, root = contextForId(id).roots.pending) {
  const context = contextForId(id); const path = pendingPath(id, root); const record = readJson(path); const spec = op(id);
  const integrity = hash(`${record.manifestRoot}|${record.operationId}|${record.did}|${record.room}|${record.nonce}|${record.text}|${record.signature}`);
  if (record.manifestRoot !== context.manifest.manifestRoot || record.operationId !== id || record.did !== spec.canonicalFrame.from
    || record.room !== spec.room || !Number.isSafeInteger(record.nonce) || record.nonce < 1 || record.integrity !== integrity
    || !verifyEd25519(record.did, canonicalMessage(record.room, record.nonce, record.text), record.signature)) throw new Error('S2_PENDING_BINDING_REFUSED');
  return Object.freeze({ record, path, rawSha256: hash(readFileSync(path)) });
}
export function requirePredecessor(id, { submitStateRoot = contextForId(id).roots.submit, railStateRoot = contextForId(id).roots.rail } = {}) {
  const context = contextForId(id); const predecessor = context.order[context.order.indexOf(id) - 1]; if (!predecessor) return null;
  const isRail = op(predecessor).actionClass === 'PaperRail'; const path = isRail ? railObservationPath(predecessor, railStateRoot) : effectiveRoomObservationPath(predecessor, submitStateRoot);
  if (!existsSync(path)) throw new Error(`DEPENDENCY_REFUSED:${predecessor}:OBSERVED_PUBLIC_REQUIRED`);
  const evidence = readJson(path);
  if (evidence.operationId !== predecessor || evidence.manifestRoot !== context.manifest.manifestRoot || evidence.classification !== 'OBSERVED_PUBLIC'
    || (context.lineage === FINAL_LINEAGE && (evidence.production !== true || evidence.venueOrigin !== assertVenue(context)))) throw new Error(`DEPENDENCY_REFUSED:${predecessor}:OBSERVED_PUBLIC_REQUIRED`);
  if (isRail) {
    const path = receiptPath(predecessor, railStateRoot); const receipt = existsSync(path) ? readJson(path) : null;
    if (!receipt || evidence.receiptSha256 !== hash(readFileSync(path))
      || (context.lineage === FINAL_LINEAGE && (receipt.production !== true || receipt.venueOrigin !== assertVenue(context)))) throw new Error(`DEPENDENCY_REFUSED:${predecessor}:WRITE_RECEIPT_REQUIRED`);
  }
  return evidence;
}
function requestFor(record) {
  const context = contextForId(record.operationId); const origin = assertVenue(context);
  const path = `/r/${encodeURIComponent(record.room)}`; const body = JSON.stringify({ did: record.did, sig: record.signature, nonce: String(record.nonce), text: record.text });
  return Object.freeze({ endpoint: `${origin}${path}?format=json`, body, bodySha256: hash(body), headers: { 'content-type': 'application/json', accept: 'application/json' } });
}
async function confirm(label, fingerprint) {
  const { createInterface } = await import('node:readline');
  approval.requireInteractiveOperatorTerminal(); const phrase = `${label} ONCE ${fingerprint.slice(-6).toUpperCase()}`;
  process.stdout.write(`Type exactly: ${phrase}\nApproval: `); const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try { return await new Promise(resolvePromise => rl.once('line', line => resolvePromise(line.trim() === phrase))); } finally { rl.close(); }
}

export async function signPreflight(id) {
  const context = contextForId(id); const frozen = preparedOperation(id); const identity = budgetIdentity('PHASE3B_SIGN', 'REAL_DETACHED_ROOM_SIGNATURE', `${id}-sign`);
  const budget = inspectOneShotAttempt(identity, { root: context.roots.budget });
  return Object.freeze({ stopped: 'PREFLIGHT_ONLY', operationId: id, manifestRoot: context.manifest.manifestRoot, venueOrigin: assertVenue(context), room: frozen.room,
    signerDid: frozen.expectedSignerDid, canonicalFrameHash: frozen.spec.canonicalFrameHash, signBudget: budget.state,
    noncePolicy: context.manifest.execution.noncePolicy, realNoncesAllocated: 0, realSignatures: 0, posted: false });
}
export async function runRealSign(id) {
  const context = contextForId(id); assertVenue(context); requirePredecessor(id); const frozen = preparedOperation(id); if (existsSync(pendingPath(id))) throw new Error('PHASE3B_PENDING_SIGNED_OPERATION_EXISTS');
  const identity = budgetIdentity('PHASE3B_SIGN', 'REAL_DETACHED_ROOM_SIGNATURE', `${id}-sign`);
  const status = inspectOneShotAttempt(identity, { root: context.roots.budget }); if (status.state !== 'AVAILABLE') throw new Error(`SIGN_REFUSED:BUDGET_${status.state}`);
  await assertReviewedCanonicalWorktree(); const snapshot = approval.reviewSnapshot(frozen.request, { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: context.manifest.provenance.tclkPin, phase3bReuse: 'NO' });
  const approved = await approval.promptHumanOperator(frozen.request); if (!approved.ok) throw new Error('OPERATOR_CANCELLED');
  if (!approval.recheckApprovalBinding(frozen.request, snapshot, { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: context.manifest.provenance.tclkPin, phase3bReuse: 'NO' }).ok) throw new Error('APPROVAL_INVALIDATED');
  await assertReviewedCanonicalWorktree(); const signBudget = acquireOneShotAttempt(identity, { root: context.roots.budget });
  const response = await invokeRealDetachedBridge({ ...frozen, manifest: context.manifest, requestId: identity.subject, profile: frozen.spec.signerRole.includes('party B') ? 'phase3b-counterparty-b' : 'default', signBudget });
  if (response.room !== frozen.room || response.text !== frozen.text || response.did !== frozen.expectedSignerDid || response.canonicalCommit !== REVIEWED_CANONICAL_COMMIT
    || response.custodyMode !== 'real' || !verifyEd25519(response.did, canonicalMessage(response.room, response.nonce, response.text), response.signature)) throw new Error('REFUSED:CANONICAL_SIGNER_RESPONSE_INVALID');
  const record = { schema: 'tclk/1-signed-operation', manifestRoot: context.manifest.manifestRoot, operationId: id, did: response.did, room: response.room,
    nonce: response.nonce, text: response.text, signature: response.signature };
  record.integrity = hash(`${record.manifestRoot}|${record.operationId}|${record.did}|${record.room}|${record.nonce}|${record.text}|${record.signature}`);
  persist(pendingPath(id), record); return Object.freeze({ operationId: id, verified: true, posted: false, pendingPath: pendingPath(id), budgetId: signBudget.budgetId });
}
export function submitPreflight(id) {
  const context = contextForId(id); requirePredecessor(id); const signed = pending(id); const request = requestFor(signed.record);
  const identity = budgetIdentity(submitBudgetPurpose(context), 'REAL_TECHNOCORE_ROOM_POST', `${id}-submit`); const budget = inspectOneShotAttempt(identity, { root: context.roots.budget });
  return Object.freeze({ stopped: 'PREFLIGHT_ONLY', operationId: id, manifestRoot: context.manifest.manifestRoot, venueOrigin: assertVenue(context), room: signed.record.room,
    did: signed.record.did, nonce: signed.record.nonce, pendingVerification: 'PASS', requestBodySha256: request.bodySha256,
    endpoint: request.endpoint, submitBudget: budget.state, automaticRetry: AUTOMATIC_RETRY, networkCalls: 0, posted: false });
}
export async function runRealSubmit(id, { transport = globalThis.fetch } = {}) {
  const context = contextForId(id); requirePredecessor(id); const signed = pending(id); const request = requestFor(signed.record);
  const identity = budgetIdentity(submitBudgetPurpose(context), 'REAL_TECHNOCORE_ROOM_POST', `${id}-submit`); const status = inspectOneShotAttempt(identity, { root: context.roots.budget });
  if (status.state !== 'AVAILABLE' || existsSync(submitPath(id))) throw new Error(`SUBMIT_REFUSED:BUDGET_${status.state}`);
  const fingerprint = hash(`${context.manifest.manifestRoot}|${id}|${signed.rawSha256}|${request.bodySha256}|${request.endpoint}`);
  if (!await confirm('SUBMIT', fingerprint)) throw new Error('OPERATOR_CANCELLED');
  const reread = pending(id); const again = requestFor(reread.record); if (reread.rawSha256 !== signed.rawSha256 || again.bodySha256 !== request.bodySha256) throw new Error('APPROVAL_INVALIDATED');
  const spent = acquireOneShotAttempt(identity, { root: context.roots.budget }); const evidence = { schema: 'tclk/phase3b-submit-result/v1', lineageId: context.lineage,
    manifestRoot: context.manifest.manifestRoot, venueOrigin: assertVenue(context), operationId: id, submitBudgetId: spent.budgetId, pendingArtifactSha256: reread.rawSha256,
    requestBodySha256: again.bodySha256, endpoint: again.endpoint, method: 'POST', postCalls: 1, timestamp: new Date().toISOString(), classification: 'SUBMISSION_UNCERTAIN', httpStatus: null };
  try { const response = await transport(again.endpoint, { method: 'POST', headers: again.headers, body: again.body, redirect: 'error', credentials: 'omit' });
    evidence.httpStatus = response.status; const body = typeof response.text === 'function' ? await response.text() : '';
    evidence.responseBodySha256 = hash(body); evidence.classification = response.status >= 200 && response.status < 300 ? 'ACK_RECEIVED' : response.status >= 400 && response.status < 500 ? 'REJECTED' : 'SUBMISSION_UNCERTAIN';
    if (response.status < 200 || response.status >= 300) { evidence.responseContentType = response.headers?.get?.('content-type') ?? null; evidence.boundedSanitizedDiagnostic = bounded(body); }
  } catch (error) { evidence.transportError = error?.code ?? error?.name ?? 'TRANSPORT_EXCEPTION'; }
  persist(submitPath(id), evidence); return Object.freeze({ ...evidence, resultPath: submitPath(id), posted: true });
}
function records(value) { if (Array.isArray(value)) return value.flatMap(records); if (!value || typeof value !== 'object') return [];
  return [...((Object.hasOwn(value, 'did') || Object.hasOwn(value, 'from')) && Object.hasOwn(value, 'text') ? [value] : []), ...Object.values(value).flatMap(records)]; }
export function parseExportJsonl(text) {
  if (typeof text !== 'string') throw new Error('S2_EXPORT_TEXT_REQUIRED');
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`S2_EXPORT_JSONL_MALFORMED:LINE_${index + 1}:${error.message}`); }
  });
}
export function exactRoomMatch(signed, data) {
  const canonicalTextSha256 = hash(signed.text);
  const matches = records(data).filter(entry => (entry.did ?? entry.from) === signed.did
    && Number.isSafeInteger(Number(entry.nonce ?? entry.signedNonce))
    && Number(entry.nonce ?? entry.signedNonce) === signed.nonce
    && typeof entry.text === 'string' && hash(entry.text) === canonicalTextSha256
    && (!entry.room || entry.room === signed.room));
  const match = matches[0] ?? null;
  return Object.freeze({ match: match !== null, exactMatchCount: matches.length, canonicalTextSha256,
    publicSeq: match?.seq ?? null, publicTimestamp: match?.ts ?? match?.timestamp ?? null,
    signatureSeen: typeof (match?.sig ?? match?.signature) === 'string' && (match?.sig ?? match?.signature).length > 0 });
}
export function reconcileRoomObservation(id, evidence, { stateRoot = contextForId(id).roots.submit } = {}) {
  const context = contextForId(id);
  const historicalPath = observationPath(id, stateRoot); const correctedPath = correctedObservationPath(id, stateRoot);
  const reconciliationPath = observationReconciliationPath(id, stateRoot);
  if (!existsSync(historicalPath)) { persist(historicalPath, evidence); return Object.freeze({ ...evidence, evidencePath: historicalPath }); }
  const historicalRaw = readFileSync(historicalPath); const historical = JSON.parse(historicalRaw);
  if (historical.operationId !== id || historical.manifestRoot !== context.manifest.manifestRoot
    || historical.classification !== 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW' || evidence.classification !== 'OBSERVED_PUBLIC') {
    throw new Error('S2_OBSERVATION_ALREADY_EXISTS');
  }
  if (!existsSync(correctedPath)) persist(correctedPath, evidence);
  const correctedRaw = readFileSync(correctedPath); const corrected = JSON.parse(correctedRaw);
  if (corrected.operationId !== id || corrected.manifestRoot !== context.manifest.manifestRoot || corrected.classification !== 'OBSERVED_PUBLIC') {
    throw new Error('S2_CORRECTED_OBSERVATION_INVALID');
  }
  const reconciliation = { schema: 'tclk/phase3b-room-observation-reconciliation/v1', lineageId: context.lineage,
    manifestRoot: context.manifest.manifestRoot, operationId: id, classification: 'FALSE_NEGATIVE_OBSERVER_HISTORICAL',
    reason: 'EXPORT_RECORD_USES_FROM_FIELD_INSTEAD_OF_DID', historicalObservationPath: historicalPath,
    historicalObservationSha256: hash(historicalRaw), correctedObservationPath: correctedPath,
    correctedObservationSha256: hash(correctedRaw), exactMatchCount: corrected.exactMatchCount,
    publicSeq: corrected.publicSeq, publicTimestamp: corrected.publicTimestamp, signatureSeen: corrected.signatureSeen };
  if (!existsSync(reconciliationPath)) persist(reconciliationPath, reconciliation);
  return Object.freeze({ ...corrected, evidencePath: correctedPath, reconciliationPath });
}
export function effectiveRoomObservationPath(id, stateRoot = contextForId(id).roots.submit) {
  const context = contextForId(id);
  const correctedPath = correctedObservationPath(id, stateRoot); const reconciliationPath = observationReconciliationPath(id, stateRoot);
  if (!existsSync(correctedPath) || !existsSync(reconciliationPath)) return observationPath(id, stateRoot);
  const historicalPath = observationPath(id, stateRoot); const historicalRaw = readFileSync(historicalPath);
  const correctedRaw = readFileSync(correctedPath); const reconciliation = readJson(reconciliationPath);
  const historical = JSON.parse(historicalRaw); const corrected = JSON.parse(correctedRaw);
  if (historical.classification !== 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW'
    || reconciliation.classification !== 'FALSE_NEGATIVE_OBSERVER_HISTORICAL'
    || reconciliation.historicalObservationSha256 !== hash(historicalRaw)
    || reconciliation.correctedObservationSha256 !== hash(correctedRaw)
    || corrected.classification !== 'OBSERVED_PUBLIC' || corrected.manifestRoot !== context.manifest.manifestRoot || corrected.operationId !== id) {
    throw new Error('S2_OBSERVATION_RECONCILIATION_INVALID');
  }
  return correctedPath;
}
export async function runRealObserve(id, { transport = globalThis.fetch, stateRoot = contextForId(id).roots.submit, pendingRoot = contextForId(id).roots.pending } = {}) {
  const context = contextForId(id); const origin = assertVenue(context);
  if (!existsSync(resolve(stateRoot, `${id}-submit.json`))) throw new Error('OBSERVE_REFUSED:SUBMIT_EVIDENCE_REQUIRED'); const signed = pending(id, pendingRoot).record;
  const endpoints = [`${origin}/r/${encodeURIComponent(signed.room)}?format=json`, `${origin}/r/${encodeURIComponent(signed.room)}/export`]; let match = false; let source = null;
  let exact = { exactMatchCount: 0, canonicalTextSha256: hash(signed.text), publicSeq: null, publicTimestamp: null, signatureSeen: false };
  for (const endpoint of endpoints) { const response = await transport(endpoint, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`PUBLIC_READ_INVALID:HTTP_${response.status}`); const data = endpoint.endsWith('/export')
      ? parseExportJsonl(await response.text()) : await response.json(); exact = exactRoomMatch(signed, data); if (exact.match) { match = true; source = endpoint; break; } }
  const evidence = { schema: 'tclk/phase3b-room-observation/v1', production: true, lineageId: context.lineage, manifestRoot: context.manifest.manifestRoot, venueOrigin: origin, operationId: id,
    classification: match ? 'OBSERVED_PUBLIC' : 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW', observationSource: source ?? 'NOT_FOUND_IN_RETAINED_RING',
    room: signed.room, did: signed.did, signedNonce: signed.nonce, canonicalTextSha256: exact.canonicalTextSha256,
    exactMatchCount: exact.exactMatchCount, publicSeq: exact.publicSeq, publicTimestamp: exact.publicTimestamp,
    signatureSeen: exact.signatureSeen, observedAt: new Date().toISOString() };
  return reconcileRoomObservation(id, evidence, { stateRoot });
}
function expectedRail(id) {
  const context = contextForId(id); const operation = op(id); if (operation.actionClass !== 'PaperRail') throw new Error('NOT_PHASE3B_PAPERRAIL_OPERATION');
  const offer = context.manifest.frameSet.frames.find(x => x.type === 'offer').canonicalFrame; const accept = context.manifest.frameSet.frames.find(x => x.type === 'accept').canonicalFrame;
  const locked = { status: 'locked', lock: offer.lock, statement: accept.statement, refundAfterMs: offer.refundAfterMs };
  const value = tclk.encodePaperRecord(id.endsWith('write-5') ? locked : { ...locked, status: 'claimed', secret: secret(id) });
  const expectedValueSha256 = hash(value); const manifestBindingValid = hash(tclk.canonicalJson(value)) === operation.valueCommitment;
  return { operation, value, expectedValueSha256, manifestBindingValid };
}
async function readNote(operation, transport) {
  const context = contextForId(operation.operationId); const endpoint = `${assertVenue(context)}/kv/${encodeURIComponent(operation.note.ns)}/${encodeURIComponent(operation.note.key)}`;
  let response; try { response = await transport(endpoint, { method: 'GET', headers: { accept: 'text/plain' }, redirect: 'error', credentials: 'omit' }); }
  catch (error) { return { endpoint, classification: 'PUBLIC_READ_INVALID', diagnostic: bounded(error?.code ?? error?.name) }; }
  const body = typeof response.text === 'function' ? await response.text() : ''; if (response.status === 404) return { endpoint, classification: 'KEY_VACANT', status: 404, bodyHash: hash(body) };
  const type = response.headers?.get?.('content-type') ?? ''; const lines = body.split(/\r?\n/).filter(x => x.trim() && !x.startsWith('!!'));
  if (response.status !== 200 || !type.toLowerCase().startsWith('text/plain') || Buffer.byteLength(body) > MAX_READ || lines.length !== 1) return { endpoint, classification: 'PUBLIC_READ_INVALID', status: response.status, bodyHash: hash(body), diagnostic: bounded(body) };
  return { endpoint, classification: 'KEY_OCCUPIED', status: 200, value: lines[0], valueHash: hash(lines[0]) };
}
export async function railPreflight(id, { transport = globalThis.fetch } = {}) {
  const context = contextForId(id); requirePredecessor(id); const expected = expectedRail(id); const current = await readNote(expected.operation, transport); const previous = id.endsWith('write-6') ? expectedRail(`${context.lineage}-write-5`) : null;
  const eligible = expected.manifestBindingValid && (id.endsWith('write-5') ? current.classification === 'KEY_VACANT' : current.classification === 'KEY_OCCUPIED' && current.valueHash === previous.expectedValueSha256);
  const identity = budgetIdentity(railBudgetPurpose(context), 'REAL_PAPERRAIL_NOTE_WRITE', id); const budget = inspectOneShotAttempt(identity, { root: context.roots.budget });
  return Object.freeze({ operationId: id, manifestRoot: context.manifest.manifestRoot, venueOrigin: assertVenue(context), key: expected.operation.note, valueCommitment: expected.operation.valueCommitment,
    expectedValueSha256: expected.expectedValueSha256, manifestBindingValid: expected.manifestBindingValid, keyOccupancy: current.classification,
    observedValueSha256: current.valueHash ?? null, occupancyFingerprint: hash(JSON.stringify(current)), writeEligible: eligible,
    conditionalWrite: id.endsWith('write-5') ? 'IF_ABSENT' : 'COMPARE_AND_SET', budgetState: budget.state, networkCalls: 1, paperRailWrites: 0 });
}
export async function railWrite(id, { transport = globalThis.fetch } = {}) {
  const context = contextForId(id);
  const first = await railPreflight(id, { transport }); if (!first.writeEligible || first.budgetState !== 'AVAILABLE') throw new Error(first.manifestBindingValid ? 'PAPERRAIL_WRITE_NOT_ELIGIBLE' : 'MANIFEST_CHANGE_REQUIRED');
  if (!await confirm('PAPERRAIL WRITE', first.occupancyFingerprint)) throw new Error('OPERATOR_CANCELLED'); const second = await railPreflight(id, { transport });
  if (!second.writeEligible || second.occupancyFingerprint !== first.occupancyFingerprint) throw new Error('PAPERRAIL_APPROVAL_INVALIDATED');
  const expected = expectedRail(id); const previous = id.endsWith('write-6') ? expectedRail(`${context.lineage}-write-5`) : null;
  const body = JSON.stringify(id.endsWith('write-5') ? { value: expected.value, if_absent: true } : { value: expected.value, if: previous.value });
  const identity = budgetIdentity(railBudgetPurpose(context), 'REAL_PAPERRAIL_NOTE_WRITE', id); const spent = acquireOneShotAttempt(identity, { root: context.roots.budget });
  let response; try { response = await transport(`${assertVenue(context)}/kv/${encodeURIComponent(expected.operation.note.ns)}/${encodeURIComponent(expected.operation.note.key)}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', credentials: 'omit' }); } catch (error) { throw Object.assign(new Error('WRITE_UNCERTAIN'), { cause: error }); }
  if (!response || response.status < 200 || response.status >= 300) throw new Error(response?.status === 409 ? 'PAPERRAIL_CAS_CONFLICT' : `PAPERRAIL_WRITE_REJECTED:HTTP_${response?.status ?? 'UNKNOWN'}`);
  const receipt = { schema: 'tclk/phase3b-paper-rail-write-receipt/v1', production: true, lineageId: context.lineage, manifestRoot: context.manifest.manifestRoot, venueOrigin: assertVenue(context),
    operationId: id, key: expected.operation.note, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION',
    valueMoved: false, valueCommitment: expected.operation.valueCommitment, expectedValueSha256: expected.expectedValueSha256, budgetId: spent.budgetId,
    requestBodySha256: hash(body), httpStatus: response.status, writtenAt: new Date().toISOString() };
  persist(receiptPath(id), receipt); return Object.freeze({ ...receipt, resultPath: receiptPath(id) });
}
export async function railObserve(id, { transport = globalThis.fetch } = {}) {
  const context = contextForId(id); const expected = expectedRail(id); const path = receiptPath(id); if (!existsSync(path)) throw new Error('PAPERRAIL_WRITE_RECEIPT_REQUIRED'); const raw = readFileSync(path); const receipt = JSON.parse(raw);
  if (receipt.manifestRoot !== context.manifest.manifestRoot || (context.lineage === FINAL_LINEAGE && receipt.venueOrigin !== assertVenue(context))
    || receipt.operationId !== id || receipt.expectedValueSha256 !== expected.expectedValueSha256) throw new Error('PAPERRAIL_RECEIPT_INVALID');
  const current = await readNote(expected.operation, transport); const exact = current.valueHash === expected.expectedValueSha256;
  const classification = current.classification === 'PUBLIC_READ_INVALID' || current.classification === 'KEY_VACANT' ? 'PUBLIC_READ_INVALID' : exact ? 'OBSERVED_PUBLIC' : 'PUBLIC_VALUE_MISMATCH';
  const evidence = { schema: 'tclk/phase3b-paper-rail-observation/v2', production: true, lineageId: context.lineage, manifestRoot: context.manifest.manifestRoot, venueOrigin: assertVenue(context),
    operationId: id, key: expected.operation.note, classification, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false,
    valueCommitment: expected.operation.valueCommitment, receiptPath: path, receiptSha256: hash(raw), receiptBudgetId: receipt.budgetId,
    expectedValueSha256: expected.expectedValueSha256, observedValueSha256: current.valueHash ?? null, exactValueMatch: exact,
    observedHttpStatus: current.status ?? null, receiptWrittenAt: receipt.writtenAt, observedAt: new Date().toISOString(), boundedSanitizedDiagnostic: current.diagnostic ?? null };
  persist(railObservationPath(id), evidence); return Object.freeze({ ...evidence, observationPath: railObservationPath(id) });
}
function finalizeContext(context) {
  const origin = assertVenue(context);
  const observations = context.order.map(id => { const rail = op(id).actionClass === 'PaperRail'; const evidence = readJson(rail ? railObservationPath(id) : effectiveRoomObservationPath(id));
    if (evidence.operationId !== id || evidence.manifestRoot !== context.manifest.manifestRoot || evidence.classification !== 'OBSERVED_PUBLIC'
      || (context.lineage === FINAL_LINEAGE && evidence.production !== true)
      || (context.lineage === FINAL_LINEAGE && evidence.venueOrigin !== origin)) throw new Error(`FINALIZE_NOT_OBSERVED_PUBLIC:${id}`);
    if (rail) { const raw = readFileSync(receiptPath(id)); const receipt = JSON.parse(raw); if (evidence.receiptSha256 !== hash(raw) || receipt.manifestRoot !== context.manifest.manifestRoot
      || (context.lineage === FINAL_LINEAGE && receipt.production !== true)
      || (context.lineage === FINAL_LINEAGE && receipt.venueOrigin !== origin)
      || receipt.operationId !== id || evidence.exactValueMatch !== true || evidence.observedValueSha256 !== receipt.expectedValueSha256) throw new Error(`FINALIZE_PAPERRAIL_EVIDENCE_INVALID:${id}`); }
    return evidence; });
  const capsule = { schema: 'tclk/phase3b-production-evidence-capsule/v1', lineageId: context.lineage, source: `PERSISTED_MACHINE_LOCAL_${context.lineage.toUpperCase().replaceAll('-', '_')}_STATE`,
    production: true, manifestRoot: context.manifest.manifestRoot, venueOrigin: origin, order: context.order, observations, acceptance: `${context.lineage.toUpperCase().replaceAll('-', '_')}_PUBLIC_TRANSCRIPT_COMPLETE`,
    PUBLIC_TRANSCRIPT_EVIDENCE_COMPLETE: 'YES', CURRENT_PUBLIC_RETENTION_COMPLETE: 'YES', RETENTION_GAP_COUNT: 0 };
  persist(context.roots.final, capsule); return Object.freeze({ ...capsule, path: context.roots.final });
}
export function finalize() { return finalizeContext(contextForId('phase3b-s2-write-1')); }
export function finalizeFinal() { return finalizeContext(contextForId('phase3b-final-write-1')); }
