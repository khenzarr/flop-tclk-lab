// Controlled Phase 3B WRITE #1 submission and bounded observation.
// This module intentionally has no import path to custody, nonce, or signing code.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createInterface } from 'node:readline';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetIdentity, acquireOneShotAttempt, inspectOneShotAttempt, BUDGET_ROOT } from './airlock/attempt-budget.mjs';

export const WRITE1_OPERATION = 'phase3b-write-1';
export const WRITE1_MANIFEST_ROOT = '9887263d84fb29a6fd99de286793a5e31ad84c6cd3c354ea62cd6582829632e7';
export const WRITE1_DID = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';
export const WRITE1_ROOM = 'tclk-offers';
export const WRITE1_NONCE = 1;
export const WRITE1_TEXT_BYTES = 348;
export const WRITE1_TEXT_SHA256 = 'ed9160e09f18d96f4646c9f632bdec50ebd0b6279154bc690984fe63ba72882c';
export const SUBMIT_ORIGIN = 'https://technocore.chat';
export const SUBMIT_PATH = '/r/tclk-offers';
export const SUBMIT_QUERY = 'format=json';
export const SUBMIT_ENDPOINT = `${SUBMIT_ORIGIN}${SUBMIT_PATH}?${SUBMIT_QUERY}`;
export const SUBMIT_ATTEMPT_IDENTITY = Object.freeze({
  purpose: 'PHASE3B_SUBMIT', operationClass: 'REAL_TECHNOCORE_ROOM_POST',
  subject: 'phase3b-write-1-submit-attempt-2',
});
export const SUBMIT_ATTEMPT_2_IDENTITY = SUBMIT_ATTEMPT_IDENTITY;
export const ATTEMPT1_IDENTITY = Object.freeze({ ...SUBMIT_ATTEMPT_IDENTITY, subject: 'phase3b-write-1-submit-attempt-1' });
export const HISTORICAL_ATTEMPT1_BODY_SHA256 = '0b7ee26cc5fd069e00fbdbf8fb564d4206247cfcd7f7c617dd60258e34343a96';
export const CORRECTED_REQUEST_BODY_SHA256 = '06bdd51270af8292a84124a75f4c297940deeeb6fad86a454c7d76d4b4b03083';
export const HISTORICAL_PENDING_ARTIFACT_SHA256 = '089e9fbb1f0ad80abf05098dc32f066311cfb7cb58a1c440018abcf9119e7259';
export const SERVER_DIAGNOSTIC_MAX_BYTES = 2048;
export const REAL_SUBMIT_BUDGET_OWNER = 'blackbox/phase3b-submit-observe.mjs/runRealSubmit';
export const MAX_HTTP_POST_ATTEMPTS = 1;
export const AUTOMATIC_RETRY = 'NO';

const BLACKBOX_ROOT = resolve(fileURLToPath(new URL('./', import.meta.url)));
export const PENDING_ROOT = resolve(BLACKBOX_ROOT, 'state', 'phase3b-pending-signed');
export const SUBMIT_STATE_ROOT = resolve(BLACKBOX_ROOT, 'state', 'phase3b-submit');
const PENDING_PATH = resolve(PENDING_ROOT, `${WRITE1_OPERATION}.json`);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const textSha = text => sha256(Buffer.from(text, 'utf8'));
const PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function didPublicKey(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) throw new Error('PENDING_OPERATION_DID_INVALID');
  let number = 0n;
  for (const character of did.slice('did:key:z'.length)) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) throw new Error('PENDING_OPERATION_DID_INVALID');
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number) { bytes.unshift(Number(number % 256n)); number /= 256n; }
  const raw = Buffer.from([...new Array(Math.max(0, 34 - bytes.length)).fill(0), ...bytes]).subarray(2);
  if (raw.length !== 32) throw new Error('PENDING_OPERATION_DID_INVALID');
  return createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, raw]), format: 'der', type: 'spki' });
}

function verifyPendingRecord(record) {
  const expectedIntegrity = sha256(`${record.manifestRoot}|${record.operationId}|${record.did}|${record.room}|${record.nonce}|${record.text}|${record.signature}`);
  if (expectedIntegrity !== record.integrity) return false;
  return verify(null, Buffer.from(`${record.room}|${record.nonce}|${record.text}`), didPublicKey(record.did), Buffer.from(record.signature, 'base64url'));
}

export function submitBudgetIdentity() { return budgetIdentity(SUBMIT_ATTEMPT_IDENTITY); }
export function submitBudgetStatus(root = BUDGET_ROOT) { return inspectOneShotAttempt(submitBudgetIdentity(), { root }); }

export function validatePendingOperation({ path = PENDING_PATH, expectedRoot = WRITE1_MANIFEST_ROOT,
  expectedOperationId = WRITE1_OPERATION, expectedDid = WRITE1_DID, expectedRoom = WRITE1_ROOM,
  expectedNonce = WRITE1_NONCE, expectedTextBytes = WRITE1_TEXT_BYTES, expectedTextSha256 = WRITE1_TEXT_SHA256 } = {}) {
  const raw = readFileSync(path, 'utf8');
  const record = JSON.parse(raw);
  const findings = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('PENDING_OPERATION_FROZEN_BINDING_REFUSED:RECORD_SHAPE_INVALID');
  if (typeof record.operationId !== 'string' || typeof record.manifestRoot !== 'string'
    || typeof record.did !== 'string' || typeof record.room !== 'string' || !Number.isInteger(record.nonce)
    || typeof record.text !== 'string' || typeof record.signature !== 'string' || typeof record.integrity !== 'string') {
    throw new Error('PENDING_OPERATION_FROZEN_BINDING_REFUSED:RECORD_FIELDS_INVALID');
  }
  if (record.operationId !== expectedOperationId || record.manifestRoot !== expectedRoot || !verifyPendingRecord(record)) findings.push('INTEGRITY_OR_PROVENANCE_INVALID');
  if (record.did !== expectedDid) findings.push('DID_MISMATCH');
  if (record.room !== expectedRoom) findings.push('ROOM_MISMATCH');
  if (record.nonce !== expectedNonce) findings.push('NONCE_MISMATCH');
  if (Buffer.byteLength(record.text, 'utf8') !== expectedTextBytes) findings.push('TEXT_LENGTH_MISMATCH');
  if (textSha(record.text) !== expectedTextSha256) findings.push('TEXT_HASH_MISMATCH');
  if (findings.length) throw new Error(`PENDING_OPERATION_FROZEN_BINDING_REFUSED:${findings.join(',')}`);
  return Object.freeze({ record, rawSha256: sha256(raw), integrity: record.integrity, path });
}

export function requestFor(record) {
  const body = JSON.stringify({ did: record.did, sig: record.signature, nonce: String(record.nonce), text: record.text });
  return Object.freeze({ endpoint: SUBMIT_ENDPOINT, origin: SUBMIT_ORIGIN, path: SUBMIT_PATH, query: SUBMIT_QUERY,
    method: 'POST', headers: Object.freeze({ 'content-type': 'application/json' }), body, bodySha256: sha256(body) });
}

export function validateTransportBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.did !== 'string' || typeof body.sig !== 'string'
    || typeof body.nonce !== 'string' || !/^[0-9]{1,19}$/.test(body.nonce)
    || typeof body.text !== 'string') throw new Error('TRANSPORT_SCHEMA_REFUSED');
  return true;
}

function approvalFingerprint({ pending, request, submitAttemptIdentity = SUBMIT_ATTEMPT_IDENTITY }) {
  return sha256(JSON.stringify({ pending: pending.rawSha256, integrity: pending.integrity, endpoint: request.endpoint,
    method: request.method, bodySha256: request.bodySha256, submitAttemptIdentity }));
}

export function reviewData(pending, request, budget) {
  validateTransportBody(JSON.parse(request.body));
  const fingerprint = approvalFingerprint({ pending, request });
  return Object.freeze({ operationId: pending.record.operationId, frame: 'offer', did: pending.record.did,
    room: pending.record.room, nonce: pending.record.nonce, manifestRoot: pending.record.manifestRoot,
    signedTextSha256: textSha(pending.record.text), pendingArtifactSha256: pending.rawSha256,
    pendingIntegrity: pending.integrity, destinationOrigin: request.origin, exactPath: request.path,
    exactQuery: request.query, method: request.method, requestBodySha256: request.bodySha256,
    signedNonceValue: pending.record.nonce, transportNonceJsonType: typeof JSON.parse(request.body).nonce,
    transportNonceJsonValue: JSON.parse(request.body).nonce,
    submitAttemptIdentity: SUBMIT_ATTEMPT_IDENTITY.subject, submitBudgetId: budget.budgetId,
    submitBudgetState: budget.state, maxHttpPosts: 1, approvalFingerprint: fingerprint,
    warnings: Object.freeze(['ACK != OBSERVED', 'NO AUTOMATIC RETRY', 'SIGNATURE ALREADY EXISTS — NO SIGNING WILL OCCUR']) });
}

function approvalPhrase(review) { return `SUBMIT ONCE ${review.approvalFingerprint.slice(-6).toUpperCase()}`; }
async function confirmSubmit(review, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (stdin.isTTY !== true || stdout.isTTY !== true) throw new Error('INTERACTIVE_TTY_REQUIRED: submit approval is human-owned');
  const phrase = approvalPhrase(review);
  stdout.write(`\nType exactly: ${phrase}\nApproval (blank or Ctrl+C cancels): `);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const entered = await new Promise(resolvePromise => { rl.once('SIGINT', () => resolvePromise(null)); rl.once('line', line => resolvePromise(line.trim())); });
    if (!entered) return false;
    return entered === phrase;
  } finally { rl.close(); }
}

function assertSamePending(before, after) {
  if (before.rawSha256 !== after.rawSha256 || before.integrity !== after.integrity) throw new Error('APPROVAL_INVALIDATED:PENDING_OPERATION_MUTATED_AFTER_APPROVAL');
}

function classifyResponse(status) {
  if ([408, 425, 429].includes(status) || status >= 500) return 'SUBMISSION_UNCERTAIN';
  if (status >= 400) return 'REJECTED';
  if (status >= 200 && status < 300) return 'ACK_RECEIVED';
  return 'SUBMISSION_UNCERTAIN';
}

function historicalAttempt1(root) {
  const path = resolve(root, `${WRITE1_OPERATION}.json`);
  if (!existsSync(path)) return null;
  const result = JSON.parse(readFileSync(path, 'utf8'));
  if (result.submitAttemptIdentity !== ATTEMPT1_IDENTITY.subject || result.classification !== 'REJECTED'
    || result.httpStatus !== 400 || result.postCalls !== 1 || result.requestBodySha256 !== HISTORICAL_ATTEMPT1_BODY_SHA256) {
    throw new Error('RECOVERY_ELIGIBILITY_REFUSED:ATTEMPT1_EVIDENCE_MISMATCH');
  }
  return Object.freeze({ path, result });
}

function assertRecoveryEligibility(pending, request, stateRoot) {
  const historical = historicalAttempt1(stateRoot);
  if (!historical) throw new Error('RECOVERY_ELIGIBILITY_REFUSED:ATTEMPT1_NOT_PRESENT');
  const numeric = JSON.stringify({ did: pending.record.did, sig: pending.record.signature,
    nonce: pending.record.nonce, text: pending.record.text });
  const historicalNumericBodySha256 = historical.result.numericRequestBodySha256 ?? historical.result.requestBodySha256;
  if (sha256(numeric) !== historicalNumericBodySha256
    || sha256(numeric) === request.bodySha256
    || (historical.result.correctedTransportOnly !== undefined && historical.result.correctedTransportOnly !== true)
    || historical.result.pendingArtifactSha256 !== pending.rawSha256) {
    throw new Error('RECOVERY_ELIGIBILITY_REFUSED:TRANSPORT_CHANGE_NOT_EXACT');
  }
  if (pending.path === PENDING_PATH && (pending.rawSha256 !== HISTORICAL_PENDING_ARTIFACT_SHA256
    || request.bodySha256 !== CORRECTED_REQUEST_BODY_SHA256
    || historicalNumericBodySha256 !== HISTORICAL_ATTEMPT1_BODY_SHA256)) {
    throw new Error('RECOVERY_ELIGIBILITY_REFUSED:FROZEN_EVIDENCE_MISMATCH');
  }
  return historical;
}

function writeResult(result, root = SUBMIT_STATE_ROOT, operationId = WRITE1_OPERATION) {
  mkdirSync(root, { recursive: true });
  const path = resolve(root, `${operationId}-submit-attempt-2.json`);
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(result, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  return path;
}

export function inspectSubmitResult({ budgetRoot = BUDGET_ROOT, stateRoot = SUBMIT_STATE_ROOT } = {}) {
  const budget = submitBudgetStatus(budgetRoot);
  const path = resolve(stateRoot, `${WRITE1_OPERATION}-submit-attempt-2.json`);
  if (existsSync(path)) return Object.freeze(JSON.parse(readFileSync(path, 'utf8')));
  return Object.freeze({ operationId: WRITE1_OPERATION, submitBudgetId: budget.budgetId,
    classification: budget.state === 'SPENT' ? 'SUBMISSION_UNCERTAIN' : 'NOT_ATTEMPTED',
    resultRecorded: false, retryAllowed: false });
}

export async function runRealSubmit({ operationId = WRITE1_OPERATION, preflight = false, transport = fetch,
  budgetRoot = BUDGET_ROOT, stateRoot = SUBMIT_STATE_ROOT, pendingPath = PENDING_PATH,
  expectedRoot = WRITE1_MANIFEST_ROOT, expectedBindings = {}, confirm = confirmSubmit,
  afterApproval = async () => {}, reviewSink = printSubmitReview } = {}) {
  if (operationId !== WRITE1_OPERATION) throw new Error('operation is not frozen for real SUBMIT');
  const validation = { path: pendingPath, expectedRoot, expectedOperationId: operationId, ...expectedBindings };
  const pending = validatePendingOperation(validation);
  const request = requestFor(pending.record);
  validateTransportBody(JSON.parse(request.body));
  if (pending.record.nonce !== WRITE1_NONCE || !verifyPendingRecord(pending.record)) throw new Error('LOCAL_SIGNATURE_REVERIFY_FAILED');
  if (pending.path === PENDING_PATH && request.bodySha256 !== CORRECTED_REQUEST_BODY_SHA256) throw new Error('CORRECTED_BODY_HASH_MISMATCH');
  const historical = assertRecoveryEligibility(pending, request, stateRoot);
  const budget = submitBudgetStatus(budgetRoot);
  const review = reviewData(pending, request, budget);
  reviewSink(review);
  if (preflight) return Object.freeze({ operationId, room: pending.record.room, did: pending.record.did, nonce: pending.record.nonce,
    signedNonceValue: pending.record.nonce, transportNonceJsonType: 'string', transportNonceJsonValue: String(pending.record.nonce),
    pendingVerification: 'PASS', requestBodySha256: request.bodySha256, endpoint: request.endpoint,
    attempt1: historical ? 'REJECTED / SPENT' : 'NOT PRESENT (fixture)', submitAttemptIdentity: SUBMIT_ATTEMPT_IDENTITY.subject,
    submitBudgetId: budget.budgetId, submitBudget: budget.state, posted: false,
    budgetMutations: 0, signBudgetMutations: 0, networkCalls: 0 });
  if (budget.state !== 'AVAILABLE') throw new Error(`SUBMIT_REFUSED:BUDGET_${budget.state}`);
  if (!await confirm(review)) throw new Error('OPERATOR_CANCELLED: no submit budget or network was used');
  await afterApproval();
  const reread = validatePendingOperation(validation);
  assertSamePending(pending, reread);
  const rereadRequest = requestFor(reread.record);
  validateTransportBody(JSON.parse(rereadRequest.body));
  if (rereadRequest.bodySha256 !== request.bodySha256) throw new Error('APPROVAL_INVALIDATED:CORRECTED_BODY_MUTATED_AFTER_APPROVAL');
  const evidence = { schema: 'tclk/phase3b-submit-result/v1', operationId, submitAttemptIdentity: SUBMIT_ATTEMPT_IDENTITY.subject,
    submitBudgetId: budget.budgetId, pendingIntegrity: reread.integrity, pendingArtifactSha256: reread.rawSha256,
    requestBodySha256: rereadRequest.bodySha256, endpoint: rereadRequest.endpoint, method: 'POST', postCalls: 0,
    timestamp: new Date().toISOString(), classification: 'SUBMISSION_UNCERTAIN', httpStatus: null };
  acquireOneShotAttempt(submitBudgetIdentity(), { root: budgetRoot });
  try {
    const response = await transport(rereadRequest.endpoint, { method: 'POST', headers: rereadRequest.headers, body: rereadRequest.body, redirect: 'error', credentials: 'omit' });
    evidence.httpStatus = response.status;
    evidence.classification = classifyResponse(response.status);
    const responseBody = typeof response.text === 'function' ? await response.text() : '';
    evidence.responseBodySha256 = sha256(responseBody);
    if (response.status >= 400) {
      evidence.responseContentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') : null;
      evidence.diagnosticExcerpt = Buffer.from(responseBody, 'utf8').subarray(0, SERVER_DIAGNOSTIC_MAX_BYTES).toString('utf8');
    }
    evidence.postCalls = 1;
  } catch (error) {
    evidence.postCalls = 1; evidence.transportError = error?.code ?? error?.name ?? 'TRANSPORT_EXCEPTION';
  }
  const resultPath = writeResult(evidence, stateRoot, operationId);
  return Object.freeze({ ...evidence, resultPath, posted: true });
}

export function printSubmitReview(review) {
  console.log('------------------------------------------------');
  console.log('TCLK BLACKBOX — WRITE #1 PUBLIC SUBMIT ATTEMPT #2 REVIEW');
  console.log('------------------------------------------------');
  for (const [key, value] of Object.entries(review)) if (key !== 'warnings') console.log(`${key}=${value}`);
  for (const warning of review.warnings) console.log(warning);
}

function recordsFrom(value) {
  if (Array.isArray(value)) return value.flatMap(recordsFrom);
  if (!value || typeof value !== 'object') return [];
  const own = Object.prototype.hasOwnProperty.call(value, 'did') && Object.prototype.hasOwnProperty.call(value, 'text') ? [value] : [];
  return [...own, ...Object.values(value).flatMap(recordsFrom)];
}

export function observeMatch(signed, responseJson) {
  const match = recordsFrom(responseJson).some(entry => entry.room === signed.room && entry.did === signed.did
    && Number.isSafeInteger(Number(entry.nonce ?? entry.signedNonce)) && Number(entry.nonce ?? entry.signedNonce) === signed.nonce && entry.text === signed.text);
  return Object.freeze({ classification: match ? 'OBSERVED_PUBLIC' : 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW', match,
    observationIdentity: Object.freeze({ room: signed.room, did: signed.did, signedNonce: signed.nonce, canonicalText: signed.text }) });
}

export async function runRealObserve({ operationId = WRITE1_OPERATION, transport = fetch, pendingPath = PENDING_PATH,
  expectedRoot = WRITE1_MANIFEST_ROOT, expectedBindings = {} } = {}) {
  if (operationId !== WRITE1_OPERATION) throw new Error('operation is not frozen for real OBSERVE');
  const pending = validatePendingOperation({ path: pendingPath, expectedRoot, expectedOperationId: operationId, ...expectedBindings });
  const response = await transport(SUBMIT_ENDPOINT, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`OBSERVATION_READ_FAILED:HTTP_${response.status}`);
  return Object.freeze({ operationId, endpoint: SUBMIT_ENDPOINT, method: 'GET', ...(observeMatch(pending.record, await response.json())) });
}