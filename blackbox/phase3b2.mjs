// Phase 3B.2-PREP: fixture-only reviewed execution machinery.
// This module never imports custody, DPAPI, the canonical bridge, or a live transport.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, closeSync, writeSync, fsyncSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireOneShotAttempt, inspectOneShotAttempt } from './airlock/attempt-budget.mjs';
import { prepareFrame } from './airlock/prepare.mjs';
import manifest from '../evidence/phase3b-exact-manifest.json' with { type: 'json' };

export const CURRENT_MANIFEST_ROOT = manifest.manifestRoot;
export const PUBLIC_ORDER = Object.freeze(['phase3b-write-1', 'phase3b-write-2', 'phase3b-write-3', 'phase3b-write-5', 'phase3b-write-4', 'phase3b-write-6']);

export const PHASE3B_STATES = Object.freeze([
  'PLANNED', 'APPROVED_FOR_SIGN', 'SIGN_ATTEMPTED', 'SIGNED', 'APPROVED_FOR_SUBMIT',
  'SUBMIT_ATTEMPTED', 'ACK_RECEIVED', 'SUBMISSION_UNCERTAIN', 'OBSERVED_PUBLIC',
  'ACCEPTED_BY_MACHINE', 'REJECTED', 'RECONCILING', 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW', 'ABORTED',
]);

const TRANSITIONS = Object.freeze({
  PLANNED: ['APPROVED_FOR_SIGN', 'ABORTED'],
  APPROVED_FOR_SIGN: ['SIGN_ATTEMPTED', 'ABORTED'],
  SIGN_ATTEMPTED: ['SIGNED', 'ABORTED'],
  SIGNED: ['APPROVED_FOR_SUBMIT', 'ABORTED'],
  APPROVED_FOR_SUBMIT: ['SUBMIT_ATTEMPTED', 'ABORTED'],
  SUBMIT_ATTEMPTED: ['ACK_RECEIVED', 'SUBMISSION_UNCERTAIN', 'REJECTED'],
  ACK_RECEIVED: ['RECONCILING'],
  SUBMISSION_UNCERTAIN: ['RECONCILING'],
  RECONCILING: ['OBSERVED_PUBLIC', 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW'],
  OBSERVED_PUBLIC: ['ACCEPTED_BY_MACHINE'],
  PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW: [],
  ACCEPTED_BY_MACHINE: [], REJECTED: [], ABORTED: [],
});

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function operationId(frame) {
  return `phase3b-write-${frame.write}`;
}

export function manifestOperation(operationIdValue) {
  if (!PUBLIC_ORDER.includes(operationIdValue)) throw new Error('UNKNOWN_OPERATION');
  const frame = manifest.frameSet.frames.find(item => item.operationId === operationIdValue);
  if (frame) return Object.freeze({ ...frame, actionClass: 'TCLK', rail: 'technocore', operationId: operationIdValue });
  const rail = manifest.frameSet.paperRailWrites.find(item => item.operationId === operationIdValue);
  if (rail) return Object.freeze({ ...rail, actionClass: 'PaperRail', rail: 'paper' });
  throw new Error('MANIFEST_OPERATION_MISSING');
}

export function assertExecutionOrder(completed, operationIdValue) {
  const expected = PUBLIC_ORDER[completed.length];
  if (expected !== operationIdValue) throw new Error(`OUT_OF_ORDER_OPERATION:${operationIdValue}:EXPECTED_${expected ?? 'NONE'}`);
  return true;
}

export function namedProfile(profile = 'default') {
  if (profile !== 'default' && !/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(profile)) {
    throw new Error('PROFILE_INVALID');
  }
  const did = didFor(fixtureKey(profile));
  return Object.freeze({ selector: profile, root: profile === 'default' ? 'DEFAULT_ROOT' : `IDENTITIES_ROOT/${profile}`, publicDid: did });
}

export function transition(record, next) {
  if (!TRANSITIONS[record.state]?.includes(next)) throw new Error(`LIFECYCLE_REFUSED:${record.state}->${next}`);
  return Object.freeze({ ...record, state: next, history: [...record.history, next] });
}

export function createOperation(frame, manifestRoot) {
  return Object.freeze({ operationId: operationId(frame), manifestRoot, frame: frame.type, room: frame.room,
    signerDid: frame.canonicalFrame.from, payload: frame.canonicalFrame, state: 'PLANNED', history: ['PLANNED'] });
}

export function fixtureSignManifestOperation(operationIdValue, { nonce = 1, secret } = {}) {
  const frame = manifestOperation(operationIdValue);
  if (frame.actionClass !== 'TCLK') throw new Error('UNSIGNED_OPERATION');
  const payload = frame.type === 'reveal' && secret ? { ...frame.canonicalFrame, secret } : frame.canonicalFrame;
  const profile = frame.signerRole.includes('party B') ? 'phase3b-counterparty-b' : 'default';
  const operation = Object.freeze({ operationId: operationIdValue, manifestRoot: manifest.manifestRoot, frame: frame.type,
    room: frame.room, signerDid: namedProfile(profile).publicDid, payload, state: 'PLANNED', history: ['PLANNED'] });
  const prepared = prepareFrame(payload);
  if (hash(prepared.canonicalPayload) !== frame.canonicalFrameHash || prepared.payloadBytes !== frame.payloadBytes) throw new Error('MANIFEST_PAYLOAD_BINDING_REFUSED');
  return fixtureSign(operation, { profile, nonce });
}

const PRIVATE_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const didFor = key => `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 1]), createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(PUBLIC_PREFIX.length)]))}`;
function base58(bytes) { const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let out = ''; while (n) { out = chars[Number(n % 58n)] + out; n /= 58n; } return '1'.repeat(bytes.findIndex(b => b !== 0)) + out; }
function fixtureKey(profile) { const material = createHash('sha256').update(`phase3b-fixture-profile:${profile}`).digest(); return createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, material]), format: 'der', type: 'pkcs8' }); }

export function fixtureSign(operation, { profile = 'default', nonce = 1 } = {}) {
  const key = fixtureKey(profile); const did = didFor(key);
  if (did !== operation.signerDid) throw new Error(`EXPECTED_SIGNER_DID_BINDING:${did}`);
  // Full protocol frames use the upstream canonical encoder. Minimal synthetic records remain
  // supported for older lifecycle-unit tests; they are not accepted by the WRITE1 E2E path.
  const text = operation.payload?.type ? prepareFrame(operation.payload).canonicalPayload : JSON.stringify(operation.payload);
  const message = `${operation.room}|${nonce}|${text}`;
  const signature = sign(null, Buffer.from(message), key).toString('base64url');
  return Object.freeze({ schema: 'tclk/1-signed-operation-fixture', manifestRoot: operation.manifestRoot,
    operationId: operation.operationId, did, room: operation.room, nonce, text, signature,
    integrity: hash(`${operation.manifestRoot}|${operation.operationId}|${did}|${operation.room}|${nonce}|${text}|${signature}`) });
}

export function previewWrite1(manifest) {
  const frame = manifest.execution?.write1 ?? manifest.frameSet.frames[0];
  return Object.freeze({
    schema: 'tclk-blackbox/phase3b-write1-execution-preview/v1',
    phase: '3B.2-PREP', fixtureOnly: true, signed: false, posted: false,
    manifestRoot: manifest.manifestRoot,
    operationId: operationId(frame),
    runtime: { attestation: manifest.provenance.runtimeAttestation, sourceSha: manifest.provenance.sourceSha, signingCommit: manifest.provenance.signingCommit },
    frame: frame.type, signerDid: frame.canonicalFrame.from, room: frame.room,
    publicFields: { room: frame.room, frame: frame.canonicalFrame, signature: 'WILL_BE_PUBLIC_AFTER_SUBMIT', signedNonce: 'WILL_BE_PUBLIC_AFTER_SUBMIT' },
    runtimeOnlyFields: ['signature', 'signedNonce'],
    stateBefore: 'PLANNED', stateAfterIfAccepted: frame.stateAfter === 'proposed' ? 'ACCEPTED_BY_MACHINE' : frame.stateAfter,
    signBudgetId: 'DERIVED_AT_SIGN_ONLY', submitBudgetId: 'DERIVED_AT_SUBMIT_ONLY',
    observationMatching: { room: frame.room, signedNonce: 'SIGNED_OPERATION_NONCE', canonicalLine: 'SIGNED_OPERATION_TEXT' },
    failureRules: ['SIGN budget is spent before signer boundary', 'SUBMIT budget is spent before one HTTP POST', 'ACK_RECEIVED is not OBSERVED_PUBLIC', 'uncertain submit is never automatically retried'],
    paperRail: 'NOT INVOLVED YET', valueMoved: false, payment: false, settlement: false, flopRewardProof: false,
  });
}

export function verifyFixtureSignedOperation(record) {
  const expected = hash(`${record.manifestRoot}|${record.operationId}|${record.did}|${record.room}|${record.nonce}|${record.text}|${record.signature}`);
  if (expected !== record.integrity) return false;
  const decoded = record.did.slice('did:key:z'.length);
  let n = 0n; for (const c of decoded) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));
  const bytes = []; while (n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  const raw = Buffer.from([...new Array(Math.max(0, 34 - bytes.length)).fill(0), ...bytes]).subarray(2);
  return verify(null, Buffer.from(`${record.room}|${record.nonce}|${record.text}`), createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, raw]), format: 'der', type: 'spki' }), Buffer.from(record.signature, 'base64url'));
}

export function writePendingSignedOperation(record, root) {
  mkdirSync(root, { recursive: true }); const path = resolve(root, `${record.operationId}.json`);
  const fd = openSync(`${path}.tmp`, 'wx', 0o600); try { writeSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${path}.tmp`, path); return Object.freeze({ path, sha256: hash(JSON.stringify(record)) });
}

export function readPendingSignedOperation(path, manifestRoot, expectedOperationId) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.manifestRoot !== manifestRoot || record.operationId !== expectedOperationId || !verifyFixtureSignedOperation(record)) throw new Error('PENDING_OPERATION_INTEGRITY_REFUSED');
  return Object.freeze(record);
}

export function budgetIdentityFor(kind, operationIdValue) { return { purpose: kind, operationClass: 'PHASE3B', subject: operationIdValue }; }
export function inspectBudget(kind, id, root) { return inspectOneShotAttempt(budgetIdentityFor(kind, id), { root }); }
export function spendBudget(kind, id, root) { return acquireOneShotAttempt(budgetIdentityFor(kind, id), { root }); }

export function fixtureSubmit(signed, response, { attempts = [] } = {}) {
  attempts.push({ method: 'POST', path: `/r/${signed.room}?format=json`, body: { did: signed.did, sig: signed.signature, nonce: signed.nonce, text: signed.text } });
  if (response === 'connection-close' || response === 'timeout' || [408, 425, 429, 500].includes(response)) return { classification: 'SUBMISSION_UNCERTAIN', attempts };
  if (typeof response === 'number' && response >= 400) return { classification: 'REJECTED', attempts };
  return { classification: 'ACK_RECEIVED', attempts };
}

export function fixtureObserve(signed, roomHistory) {
  const match = roomHistory.some(line => line.room === signed.room && line.nonce === signed.nonce && line.text === signed.text && line.did === signed.did);
  return { classification: match ? 'OBSERVED_PUBLIC' : 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW', match };
}

export function fixtureWrite1E2E({ response = 200, budgetRoot } = {}) {
  if (typeof budgetRoot !== 'string' || budgetRoot.length === 0) throw new Error('FIXTURE_BUDGET_ROOT_REQUIRED');
  const source = manifest.frameSet.frames[0];
  // The fixture key is deliberately separate from the frozen real signer DID. Keep the frozen
  // canonical payload byte-for-byte intact while binding this offline rehearsal to its fixture key.
  const operation = Object.freeze({ ...createOperation(source, manifest.manifestRoot), signerDid: namedProfile().publicDid });
  let lifecycle = operation;
  lifecycle = transition(lifecycle, 'APPROVED_FOR_SIGN');
  const signBudget = spendBudget('SIGN', operation.operationId, budgetRoot);
  lifecycle = transition(lifecycle, 'SIGN_ATTEMPTED');
  const signed = fixtureSign(operation);
  lifecycle = transition(lifecycle, 'SIGNED');
  lifecycle = transition(lifecycle, 'APPROVED_FOR_SUBMIT');
  lifecycle = transition(lifecycle, 'SUBMIT_ATTEMPTED');
  const submission = fixtureSubmit(signed, response);
  lifecycle = transition(lifecycle, submission.classification);
  return Object.freeze({ operation: lifecycle, signed, signBudget, submission });
}