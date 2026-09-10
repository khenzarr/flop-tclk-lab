// SPDX-License-Identifier: Apache-2.0
// Isolated production command implementation for the superseding Phase 3B lineage.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../evidence/phase3b-s2-exact-manifest.json' with { type: 'json' };
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
export const MAX_HTTP_POST_ATTEMPTS = 1;
export const AUTOMATIC_RETRY = 'NO';
const ORIGIN = 'https://technocore.chat'; const MAX_READ = 65536; const MAX_DIAGNOSTIC = 2048;
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const op = id => {
  if (!ORDER.includes(id)) throw new Error('UNKNOWN_S2_OPERATION');
  const frame = manifest.frameSet.frames.find(x => x.operationId === id);
  if (frame) return { ...frame, actionClass: 'TCLK' };
  const rail = manifest.frameSet.paperRailWrites.find(x => x.operationId === id);
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
const pendingPath = id => resolve(ROOTS.pending, `${id}.json`);
const submitPath = id => resolve(ROOTS.submit, `${id}-submit.json`);
const observationPath = id => resolve(ROOTS.submit, `${id}-observation.json`);
const receiptPath = id => resolve(ROOTS.rail, `${id}-write-receipt.json`);
const railObservationPath = id => resolve(ROOTS.rail, `${id}-production-observation.json`);

function secret() {
  const record = readJson(ROOTS.secret);
  if (!/^0x[0-9a-f]{64}$/.test(record.secret) || tclk.hashLockFromPreimage(record.secret).hash !== manifest.execution.secretCommitment) throw new Error('S2_SECRET_COMMITMENT_MISMATCH');
  return record.secret;
}
function payload(spec) { return spec.type === 'reveal' ? { ...spec.canonicalFrame, secret: secret() } : spec.canonicalFrame; }
function preparedOperation(id) {
  const spec = op(id); if (spec.actionClass !== 'TCLK') throw new Error('S2_UNSIGNED_OPERATION');
  const prepared = prepareFrame(payload(spec));
  if (prepared.canonicalHash !== spec.canonicalFrameHash || prepared.payloadBytes !== spec.payloadBytes
    || prepared.intendedRoom !== spec.room || prepared.signerDid !== spec.canonicalFrame.from) throw new Error('S2_MANIFEST_BINDING_REFUSED');
  const request = buildRequest(prepared, { createdAt: '2026-01-01T00:00:00.000Z' });
  return Object.freeze({ spec, prepared, request, room: spec.room, text: prepared.canonicalPayload, expectedSignerDid: prepared.signerDid });
}
function pending(id) {
  const path = pendingPath(id); const record = readJson(path); const spec = op(id);
  const integrity = hash(`${record.manifestRoot}|${record.operationId}|${record.did}|${record.room}|${record.nonce}|${record.text}|${record.signature}`);
  if (record.manifestRoot !== manifest.manifestRoot || record.operationId !== id || record.did !== spec.canonicalFrame.from
    || record.room !== spec.room || !Number.isSafeInteger(record.nonce) || record.nonce < 1 || record.integrity !== integrity
    || !verifyEd25519(record.did, canonicalMessage(record.room, record.nonce, record.text), record.signature)) throw new Error('S2_PENDING_BINDING_REFUSED');
  return Object.freeze({ record, path, rawSha256: hash(readFileSync(path)) });
}
function requirePredecessor(id) {
  const predecessor = ORDER[ORDER.indexOf(id) - 1]; if (!predecessor) return null;
  const isRail = op(predecessor).actionClass === 'PaperRail'; const path = isRail ? railObservationPath(predecessor) : observationPath(predecessor);
  if (!existsSync(path)) throw new Error(`DEPENDENCY_REFUSED:${predecessor}:OBSERVED_PUBLIC_REQUIRED`);
  const evidence = readJson(path);
  if (evidence.operationId !== predecessor || evidence.manifestRoot !== manifest.manifestRoot || evidence.classification !== 'OBSERVED_PUBLIC') throw new Error(`DEPENDENCY_REFUSED:${predecessor}:OBSERVED_PUBLIC_REQUIRED`);
  if (isRail && (!existsSync(receiptPath(predecessor)) || evidence.receiptSha256 !== hash(readFileSync(receiptPath(predecessor))))) throw new Error(`DEPENDENCY_REFUSED:${predecessor}:WRITE_RECEIPT_REQUIRED`);
  return evidence;
}
function requestFor(record) {
  const path = `/r/${encodeURIComponent(record.room)}`; const body = JSON.stringify({ did: record.did, sig: record.signature, nonce: String(record.nonce), text: record.text });
  return Object.freeze({ endpoint: `${ORIGIN}${path}?format=json`, body, bodySha256: hash(body), headers: { 'content-type': 'application/json', accept: 'application/json' } });
}
async function confirm(label, fingerprint) {
  const { createInterface } = await import('node:readline');
  approval.requireInteractiveOperatorTerminal(); const phrase = `${label} ONCE ${fingerprint.slice(-6).toUpperCase()}`;
  process.stdout.write(`Type exactly: ${phrase}\nApproval: `); const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try { return await new Promise(resolvePromise => rl.once('line', line => resolvePromise(line.trim() === phrase))); } finally { rl.close(); }
}

export async function signPreflight(id) {
  const frozen = preparedOperation(id); const identity = budgetIdentity('PHASE3B_SIGN', 'REAL_DETACHED_ROOM_SIGNATURE', `${id}-sign`);
  const budget = inspectOneShotAttempt(identity, { root: ROOTS.budget });
  return Object.freeze({ stopped: 'PREFLIGHT_ONLY', operationId: id, manifestRoot: manifest.manifestRoot, room: frozen.room,
    signerDid: frozen.expectedSignerDid, canonicalFrameHash: frozen.spec.canonicalFrameHash, signBudget: budget.state,
    noncePolicy: manifest.execution.noncePolicy, realNoncesAllocated: 0, realSignatures: 0, posted: false });
}
export async function runRealSign(id) {
  requirePredecessor(id); const frozen = preparedOperation(id); if (existsSync(pendingPath(id))) throw new Error('S2_PENDING_SIGNED_OPERATION_EXISTS');
  const identity = budgetIdentity('PHASE3B_SIGN', 'REAL_DETACHED_ROOM_SIGNATURE', `${id}-sign`);
  const status = inspectOneShotAttempt(identity, { root: ROOTS.budget }); if (status.state !== 'AVAILABLE') throw new Error(`SIGN_REFUSED:BUDGET_${status.state}`);
  await assertReviewedCanonicalWorktree(); const snapshot = approval.reviewSnapshot(frozen.request, { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: manifest.provenance.tclkPin, phase3bReuse: 'NO' });
  const approved = await approval.promptHumanOperator(frozen.request); if (!approved.ok) throw new Error('OPERATOR_CANCELLED');
  if (!approval.recheckApprovalBinding(frozen.request, snapshot, { canonicalCommit: REVIEWED_CANONICAL_COMMIT, tclkPin: manifest.provenance.tclkPin, phase3bReuse: 'NO' }).ok) throw new Error('APPROVAL_INVALIDATED');
  await assertReviewedCanonicalWorktree(); const signBudget = acquireOneShotAttempt(identity, { root: ROOTS.budget });
  const response = await invokeRealDetachedBridge({ ...frozen, manifest, requestId: identity.subject, profile: frozen.spec.signerRole.includes('party B') ? 'phase3b-counterparty-b' : 'default', signBudget });
  if (response.room !== frozen.room || response.text !== frozen.text || response.did !== frozen.expectedSignerDid || response.canonicalCommit !== REVIEWED_CANONICAL_COMMIT
    || response.custodyMode !== 'real' || !verifyEd25519(response.did, canonicalMessage(response.room, response.nonce, response.text), response.signature)) throw new Error('REFUSED:CANONICAL_SIGNER_RESPONSE_INVALID');
  const record = { schema: 'tclk/1-signed-operation', manifestRoot: manifest.manifestRoot, operationId: id, did: response.did, room: response.room,
    nonce: response.nonce, text: response.text, signature: response.signature };
  record.integrity = hash(`${record.manifestRoot}|${record.operationId}|${record.did}|${record.room}|${record.nonce}|${record.text}|${record.signature}`);
  persist(pendingPath(id), record); return Object.freeze({ operationId: id, verified: true, posted: false, pendingPath: pendingPath(id), budgetId: signBudget.budgetId });
}
export function submitPreflight(id) {
  requirePredecessor(id); const signed = pending(id); const request = requestFor(signed.record);
  const identity = budgetIdentity('PHASE3B_S2_SUBMIT', 'REAL_TECHNOCORE_ROOM_POST', `${id}-submit`); const budget = inspectOneShotAttempt(identity, { root: ROOTS.budget });
  return Object.freeze({ stopped: 'PREFLIGHT_ONLY', operationId: id, manifestRoot: manifest.manifestRoot, room: signed.record.room,
    did: signed.record.did, nonce: signed.record.nonce, pendingVerification: 'PASS', requestBodySha256: request.bodySha256,
    endpoint: request.endpoint, submitBudget: budget.state, automaticRetry: AUTOMATIC_RETRY, networkCalls: 0, posted: false });
}
export async function runRealSubmit(id, { transport = globalThis.fetch } = {}) {
  requirePredecessor(id); const signed = pending(id); const request = requestFor(signed.record);
  const identity = budgetIdentity('PHASE3B_S2_SUBMIT', 'REAL_TECHNOCORE_ROOM_POST', `${id}-submit`); const status = inspectOneShotAttempt(identity, { root: ROOTS.budget });
  if (status.state !== 'AVAILABLE' || existsSync(submitPath(id))) throw new Error(`SUBMIT_REFUSED:BUDGET_${status.state}`);
  const fingerprint = hash(`${manifest.manifestRoot}|${id}|${signed.rawSha256}|${request.bodySha256}|${request.endpoint}`);
  if (!await confirm('SUBMIT', fingerprint)) throw new Error('OPERATOR_CANCELLED');
  const reread = pending(id); const again = requestFor(reread.record); if (reread.rawSha256 !== signed.rawSha256 || again.bodySha256 !== request.bodySha256) throw new Error('APPROVAL_INVALIDATED');
  const spent = acquireOneShotAttempt(identity, { root: ROOTS.budget }); const evidence = { schema: 'tclk/phase3b-s2-submit-result/v1', lineageId: LINEAGE,
    manifestRoot: manifest.manifestRoot, operationId: id, submitBudgetId: spent.budgetId, pendingArtifactSha256: reread.rawSha256,
    requestBodySha256: again.bodySha256, endpoint: again.endpoint, method: 'POST', postCalls: 1, timestamp: new Date().toISOString(), classification: 'SUBMISSION_UNCERTAIN', httpStatus: null };
  try { const response = await transport(again.endpoint, { method: 'POST', headers: again.headers, body: again.body, redirect: 'error', credentials: 'omit' });
    evidence.httpStatus = response.status; const body = typeof response.text === 'function' ? await response.text() : '';
    evidence.responseBodySha256 = hash(body); evidence.classification = response.status >= 200 && response.status < 300 ? 'ACK_RECEIVED' : response.status >= 400 && response.status < 500 ? 'REJECTED' : 'SUBMISSION_UNCERTAIN';
    if (response.status < 200 || response.status >= 300) { evidence.responseContentType = response.headers?.get?.('content-type') ?? null; evidence.boundedSanitizedDiagnostic = bounded(body); }
  } catch (error) { evidence.transportError = error?.code ?? error?.name ?? 'TRANSPORT_EXCEPTION'; }
  persist(submitPath(id), evidence); return Object.freeze({ ...evidence, resultPath: submitPath(id), posted: true });
}
function records(value) { if (Array.isArray(value)) return value.flatMap(records); if (!value || typeof value !== 'object') return [];
  return [...(Object.hasOwn(value, 'did') && Object.hasOwn(value, 'text') ? [value] : []), ...Object.values(value).flatMap(records)]; }
const matches = (signed, data) => records(data).some(x => x.did === signed.did && x.text === signed.text && Number(x.nonce ?? x.signedNonce) === signed.nonce && (!x.room || x.room === signed.room));
export async function runRealObserve(id, { transport = globalThis.fetch } = {}) {
  if (!existsSync(submitPath(id))) throw new Error('OBSERVE_REFUSED:SUBMIT_EVIDENCE_REQUIRED'); const signed = pending(id).record;
  const endpoints = [`${ORIGIN}/r/${encodeURIComponent(signed.room)}?format=json`, `${ORIGIN}/r/${encodeURIComponent(signed.room)}/export`]; let match = false; let source = null;
  for (const endpoint of endpoints) { const response = await transport(endpoint, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`PUBLIC_READ_INVALID:HTTP_${response.status}`); const data = endpoint.endsWith('/export')
      ? (await response.text()).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : await response.json(); if (matches(signed, data)) { match = true; source = endpoint; break; } }
  const evidence = { schema: 'tclk/phase3b-s2-room-observation/v1', lineageId: LINEAGE, manifestRoot: manifest.manifestRoot, operationId: id,
    classification: match ? 'OBSERVED_PUBLIC' : 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW', observationSource: source ?? 'NOT_FOUND_IN_RETAINED_RING',
    room: signed.room, did: signed.did, signedNonce: signed.nonce, canonicalTextSha256: hash(signed.text), observedAt: new Date().toISOString() };
  persist(observationPath(id), evidence); return Object.freeze({ ...evidence, evidencePath: observationPath(id) });
}
function expectedRail(id) {
  const operation = op(id); if (operation.actionClass !== 'PaperRail') throw new Error('NOT_S2_PAPERRAIL_OPERATION');
  const offer = manifest.frameSet.frames.find(x => x.type === 'offer').canonicalFrame; const accept = manifest.frameSet.frames.find(x => x.type === 'accept').canonicalFrame;
  const locked = { status: 'locked', lock: offer.lock, statement: accept.statement, refundAfterMs: offer.refundAfterMs };
  const value = tclk.encodePaperRecord(id.endsWith('write-5') ? locked : { ...locked, status: 'claimed', secret: secret() });
  const expectedValueSha256 = hash(value); const manifestBindingValid = hash(tclk.canonicalJson(value)) === operation.valueCommitment;
  return { operation, value, expectedValueSha256, manifestBindingValid };
}
async function readNote(operation, transport) {
  const endpoint = `${ORIGIN}/kv/${encodeURIComponent(operation.note.ns)}/${encodeURIComponent(operation.note.key)}`;
  let response; try { response = await transport(endpoint, { method: 'GET', headers: { accept: 'text/plain' }, redirect: 'error', credentials: 'omit' }); }
  catch (error) { return { endpoint, classification: 'PUBLIC_READ_INVALID', diagnostic: bounded(error?.code ?? error?.name) }; }
  const body = typeof response.text === 'function' ? await response.text() : ''; if (response.status === 404) return { endpoint, classification: 'KEY_VACANT', status: 404, bodyHash: hash(body) };
  const type = response.headers?.get?.('content-type') ?? ''; const lines = body.split(/\r?\n/).filter(x => x.trim() && !x.startsWith('!!'));
  if (response.status !== 200 || !type.toLowerCase().startsWith('text/plain') || Buffer.byteLength(body) > MAX_READ || lines.length !== 1) return { endpoint, classification: 'PUBLIC_READ_INVALID', status: response.status, bodyHash: hash(body), diagnostic: bounded(body) };
  return { endpoint, classification: 'KEY_OCCUPIED', status: 200, value: lines[0], valueHash: hash(lines[0]) };
}
export async function railPreflight(id, { transport = globalThis.fetch } = {}) {
  requirePredecessor(id); const expected = expectedRail(id); const current = await readNote(expected.operation, transport); const previous = id.endsWith('write-6') ? expectedRail('phase3b-s2-write-5') : null;
  const eligible = expected.manifestBindingValid && (id.endsWith('write-5') ? current.classification === 'KEY_VACANT' : current.classification === 'KEY_OCCUPIED' && current.valueHash === previous.expectedValueSha256);
  const identity = budgetIdentity('PHASE3B_S2_PAPERRAIL_WRITE', 'REAL_PAPERRAIL_NOTE_WRITE', id); const budget = inspectOneShotAttempt(identity, { root: ROOTS.budget });
  return Object.freeze({ operationId: id, manifestRoot: manifest.manifestRoot, key: expected.operation.note, valueCommitment: expected.operation.valueCommitment,
    expectedValueSha256: expected.expectedValueSha256, manifestBindingValid: expected.manifestBindingValid, keyOccupancy: current.classification,
    observedValueSha256: current.valueHash ?? null, occupancyFingerprint: hash(JSON.stringify(current)), writeEligible: eligible,
    conditionalWrite: id.endsWith('write-5') ? 'IF_ABSENT' : 'COMPARE_AND_SET', budgetState: budget.state, networkCalls: 1, paperRailWrites: 0 });
}
export async function railWrite(id, { transport = globalThis.fetch } = {}) {
  const first = await railPreflight(id, { transport }); if (!first.writeEligible || first.budgetState !== 'AVAILABLE') throw new Error(first.manifestBindingValid ? 'PAPERRAIL_WRITE_NOT_ELIGIBLE' : 'MANIFEST_CHANGE_REQUIRED');
  if (!await confirm('PAPERRAIL WRITE', first.occupancyFingerprint)) throw new Error('OPERATOR_CANCELLED'); const second = await railPreflight(id, { transport });
  if (!second.writeEligible || second.occupancyFingerprint !== first.occupancyFingerprint) throw new Error('PAPERRAIL_APPROVAL_INVALIDATED');
  const expected = expectedRail(id); const previous = id.endsWith('write-6') ? expectedRail('phase3b-s2-write-5') : null;
  const body = JSON.stringify(id.endsWith('write-5') ? { value: expected.value, if_absent: true } : { value: expected.value, if: previous.value });
  const identity = budgetIdentity('PHASE3B_S2_PAPERRAIL_WRITE', 'REAL_PAPERRAIL_NOTE_WRITE', id); const spent = acquireOneShotAttempt(identity, { root: ROOTS.budget });
  let response; try { response = await transport(`${ORIGIN}/kv/${encodeURIComponent(expected.operation.note.ns)}/${encodeURIComponent(expected.operation.note.key)}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', credentials: 'omit' }); } catch (error) { throw Object.assign(new Error('WRITE_UNCERTAIN'), { cause: error }); }
  if (!response || response.status < 200 || response.status >= 300) throw new Error(response?.status === 409 ? 'PAPERRAIL_CAS_CONFLICT' : `PAPERRAIL_WRITE_REJECTED:HTTP_${response?.status ?? 'UNKNOWN'}`);
  const receipt = { schema: 'tclk/phase3b-paper-rail-write-receipt/v1', production: true, lineageId: LINEAGE, manifestRoot: manifest.manifestRoot,
    operationId: id, key: expected.operation.note, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION',
    valueMoved: false, valueCommitment: expected.operation.valueCommitment, expectedValueSha256: expected.expectedValueSha256, budgetId: spent.budgetId,
    requestBodySha256: hash(body), httpStatus: response.status, writtenAt: new Date().toISOString() };
  persist(receiptPath(id), receipt); return Object.freeze({ ...receipt, resultPath: receiptPath(id) });
}
export async function railObserve(id, { transport = globalThis.fetch } = {}) {
  const expected = expectedRail(id); const path = receiptPath(id); if (!existsSync(path)) throw new Error('PAPERRAIL_WRITE_RECEIPT_REQUIRED'); const raw = readFileSync(path); const receipt = JSON.parse(raw);
  if (receipt.manifestRoot !== manifest.manifestRoot || receipt.operationId !== id || receipt.expectedValueSha256 !== expected.expectedValueSha256) throw new Error('PAPERRAIL_RECEIPT_INVALID');
  const current = await readNote(expected.operation, transport); const exact = current.valueHash === expected.expectedValueSha256;
  const classification = current.classification === 'PUBLIC_READ_INVALID' || current.classification === 'KEY_VACANT' ? 'PUBLIC_READ_INVALID' : exact ? 'OBSERVED_PUBLIC' : 'PUBLIC_VALUE_MISMATCH';
  const evidence = { schema: 'tclk/phase3b-paper-rail-observation/v2', production: true, lineageId: LINEAGE, manifestRoot: manifest.manifestRoot,
    operationId: id, key: expected.operation.note, classification, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false,
    valueCommitment: expected.operation.valueCommitment, receiptPath: path, receiptSha256: hash(raw), receiptBudgetId: receipt.budgetId,
    expectedValueSha256: expected.expectedValueSha256, observedValueSha256: current.valueHash ?? null, exactValueMatch: exact,
    observedHttpStatus: current.status ?? null, receiptWrittenAt: receipt.writtenAt, observedAt: new Date().toISOString(), boundedSanitizedDiagnostic: current.diagnostic ?? null };
  persist(railObservationPath(id), evidence); return Object.freeze({ ...evidence, observationPath: railObservationPath(id) });
}
export function finalize() {
  const observations = ORDER.map(id => { const rail = op(id).actionClass === 'PaperRail'; const evidence = readJson(rail ? railObservationPath(id) : observationPath(id));
    if (evidence.operationId !== id || evidence.manifestRoot !== manifest.manifestRoot || evidence.classification !== 'OBSERVED_PUBLIC') throw new Error(`FINALIZE_NOT_OBSERVED_PUBLIC:${id}`);
    if (rail) { const raw = readFileSync(receiptPath(id)); const receipt = JSON.parse(raw); if (evidence.receiptSha256 !== hash(raw) || receipt.manifestRoot !== manifest.manifestRoot
      || receipt.operationId !== id || evidence.exactValueMatch !== true || evidence.observedValueSha256 !== receipt.expectedValueSha256) throw new Error(`FINALIZE_PAPERRAIL_EVIDENCE_INVALID:${id}`); }
    return evidence; });
  const capsule = { schema: 'tclk/phase3b-s2-production-evidence-capsule/v1', lineageId: LINEAGE, source: 'PERSISTED_MACHINE_LOCAL_PHASE3B_S2_STATE',
    production: true, manifestRoot: manifest.manifestRoot, order: ORDER, observations, acceptance: 'PHASE3B_S2_PUBLIC_TRANSCRIPT_COMPLETE',
    PUBLIC_TRANSCRIPT_EVIDENCE_COMPLETE: 'YES', CURRENT_PUBLIC_RETENTION_COMPLETE: 'YES', RETENTION_GAP_COUNT: 0 };
  persist(ROOTS.final, capsule); return Object.freeze({ ...capsule, path: ROOTS.final });
}
