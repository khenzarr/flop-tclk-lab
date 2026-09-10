// Production PaperRail controller. Network access is transport-injected and every production
// mutation is guarded by a public read, an exact CAS condition, and a durable one-shot budget.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../evidence/phase3b-exact-manifest.json' with { type: 'json' };
import { tclk } from '../lab/upstream.mjs';
import { PUBLIC_ORDER, assertExecutionOrder, manifestOperation } from './phase3b2.mjs';
import { requireObservedPublic } from './phase3b-submit-observe.mjs';
import { budgetIdentity, acquireOneShotAttempt, inspectOneShotAttempt, BUDGET_ROOT } from './airlock/attempt-budget.mjs';

const ROOT = resolve('blackbox/state/phase3b-paper-rail');
const SECRET_PATH = resolve('blackbox/state/phase3b-deal-secret/phase3b-deal.json');
const MAX_PUBLIC_READ_BYTES = 65536;
const DIAGNOSTIC_BYTES = 2048;
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const railPath = (id, root = ROOT) => resolve(root, `${id}.json`);
// The legacy name is preserved for the quarantined v1 false positive. New
// production observations use a distinct path so history is never overwritten.
const railObservationPath = (id, root = ROOT) => resolve(root, `${id}-observation.json`);
const productionRailObservationPath = (id, root = ROOT) => resolve(root, `${id}-production-observation.json`);
const railReceiptPath = (id, root = ROOT) => resolve(root, `${id}-write-receipt.json`);
const railBudget = id => budgetIdentity({ purpose: 'PHASE3B_PAPERRAIL_WRITE', operationClass: 'REAL_PAPERRAIL_NOTE_WRITE', subject: id });

function requireRailPredecessorObserved(id, stateRoot) {
  return PUBLIC_ORDER[PUBLIC_ORDER.indexOf(id) - 1] ? requireObservedPublic(id, stateRoot) : null;
}

function requireProductionRailPredecessor(id, railStateRoot, submitStateRoot) {
  if (id === 'phase3b-write-5') return requireObservedPublic(id, submitStateRoot);
  if (id !== 'phase3b-write-6') return null;
  const path = productionRailObservationPath('phase3b-write-5', railStateRoot);
  const receiptPath = railReceiptPath('phase3b-write-5', railStateRoot);
  if (!existsSync(path) || !existsSync(receiptPath)) {
    throw new Error('DEPENDENCY_REFUSED:phase3b-write-5:OBSERVED_PUBLIC_REQUIRED');
  }
  const evidence = readJson(path); const receiptRaw = readFileSync(receiptPath); const receipt = JSON.parse(receiptRaw);
  const operation = railOperation('phase3b-write-5'); const expected = expectedRailValue('phase3b-write-5');
  if (evidence.operationId !== 'phase3b-write-5' || evidence.schema !== 'tclk/phase3b-paper-rail-observation/v2'
    || evidence.production !== true || evidence.classification !== 'OBSERVED_PUBLIC'
    || evidence.exactValueMatch !== true || evidence.observedValueSha256 !== expected.expectedValueSha256
    || expected.manifestBindingValid !== true || evidence.receiptPath !== receiptPath
    || evidence.receiptSha256 !== hash(receiptRaw) || evidence.receiptBudgetId !== receipt.budgetId
    || receipt.schema !== 'tclk/phase3b-paper-rail-write-receipt/v1' || receipt.production !== true
    || receipt.operationId !== 'phase3b-write-5' || receipt.manifestRoot !== manifest.manifestRoot
    || receipt.key?.ns !== operation.note.ns || receipt.key?.key !== operation.note.key
    || receipt.valueCommitment !== operation.valueCommitment
    || receipt.expectedValueSha256 !== expected.expectedValueSha256) {
    throw new Error('DEPENDENCY_REFUSED:phase3b-write-5:OBSERVED_PUBLIC_REQUIRED');
  }
  return evidence;
}

export function railOperation(id) {
  const operation = manifestOperation(id);
  if (operation.actionClass !== 'PaperRail') throw new Error('NOT_PAPERRAIL_OPERATION');
  return operation;
}

function frame(type) {
  const found = manifest.frameSet.frames.find(item => item.type === type);
  if (!found) throw new Error(`PAPERRAIL_MANIFEST_FRAME_MISSING:${type}`);
  return found.canonicalFrame;
}

function dealSecret(path = SECRET_PATH) {
  const record = readJson(path);
  if (!/^0x[0-9a-f]{64}$/.test(record.secret)
    || tclk.hashLockFromPreimage(record.secret).hash !== manifest.execution.secretCommitment) {
    throw new Error('PAPERRAIL_SECRET_COMMITMENT_MISMATCH');
  }
  return record.secret;
}

export function expectedRailValue(id, { secretPath = SECRET_PATH } = {}) {
  const operation = railOperation(id);
  const offer = frame('offer'); const accept = frame('accept');
  const locked = { status: 'locked', lock: offer.lock, statement: accept.statement, refundAfterMs: offer.refundAfterMs };
  const record = id === 'phase3b-write-5' ? locked : { ...locked, status: 'claimed', secret: dealSecret(secretPath) };
  const value = tclk.encodePaperRecord(record);
  const expectedValueSha256 = hash(Buffer.from(value, 'utf8'));
  const derivedManifestCommitment = hash(Buffer.from(tclk.canonicalJson(value), 'utf8'));
  return Object.freeze({ operationId: id, value, expectedValueSha256, derivedManifestCommitment,
    frozenManifestCommitment: operation.valueCommitment,
    manifestBindingValid: derivedManifestCommitment === operation.valueCommitment });
}

export function paperRailWriteBody(id, { secretPath = SECRET_PATH } = {}) {
  const expected = expectedRailValue(id, { secretPath });
  const previous = id === 'phase3b-write-6' ? expectedRailValue('phase3b-write-5', { secretPath }) : null;
  return JSON.stringify(id === 'phase3b-write-5'
    ? { value: expected.value, if_absent: true } : { value: expected.value, if: previous.value });
}

const boundedDiagnostic = body => Buffer.from(body ?? '', 'utf8').subarray(0, DIAGNOSTIC_BYTES).toString('utf8')
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
  .replace(/\bxprv[A-Za-z0-9]{20,}\b/g, '[REDACTED_EXTENDED_PRIVATE_KEY]')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?');

function extractNoteValue(body) {
  const lines = body.split(/\r?\n/).filter(line => !line.startsWith('!!') && line.trim() !== '');
  return lines.length === 1 ? lines[0] : null;
}

async function readPublicNote(operation, transport, maxBytes = MAX_PUBLIC_READ_BYTES) {
  const endpoint = `https://technocore.chat/kv/${encodeURIComponent(operation.note.ns)}/${encodeURIComponent(operation.note.key)}`;
  let response;
  try { response = await transport(endpoint, { method: 'GET', headers: { accept: 'text/plain' }, redirect: 'error', credentials: 'omit' }); }
  catch (error) {
    return Object.freeze({ endpoint, classification: 'PUBLIC_READ_INVALID', observedHttpStatus: null,
      observedContentType: null, observedByteLength: 0, observedValueSha256: null, exactValueMatch: false,
      boundedSanitizedDiagnostic: boundedDiagnostic(error?.code ?? error?.name ?? 'TRANSPORT_EXCEPTION') });
  }
  const contentType = typeof response?.headers?.get === 'function' ? response.headers.get('content-type') : null;
  const body = typeof response?.text === 'function' ? await response.text() : '';
  const bodyBytes = Buffer.from(body, 'utf8');
  if (response?.status === 404) return Object.freeze({ endpoint, classification: 'KEY_VACANT', observedHttpStatus: 404,
    observedContentType: contentType, observedByteLength: 0, observedValue: null, observedValueSha256: null,
    boundedSanitizedDiagnostic: boundedDiagnostic(body) });
  const value = bodyBytes.length <= maxBytes && response?.status === 200
    && typeof contentType === 'string' && contentType.toLowerCase().startsWith('text/plain') ? extractNoteValue(body) : null;
  if (value === null || Buffer.byteLength(value, 'utf8') > maxBytes) return Object.freeze({ endpoint,
    classification: 'PUBLIC_READ_INVALID', observedHttpStatus: response?.status ?? null, observedContentType: contentType,
    observedByteLength: bodyBytes.length, observedValueSha256: null, exactValueMatch: false,
    boundedSanitizedDiagnostic: boundedDiagnostic(body) });
  const valueBytes = Buffer.from(value, 'utf8');
  return Object.freeze({ endpoint, classification: 'KEY_OCCUPIED', observedHttpStatus: response.status,
    observedContentType: contentType, observedByteLength: valueBytes.length, observedValue: value,
    observedValueSha256: hash(valueBytes), boundedSanitizedDiagnostic: null });
}

function persistExclusive(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

export function fixtureRailPreflight(id, { completed = [], stateRoot } = {}) {
  const operation = railOperation(id);
  const predecessorEvidence = stateRoot ? requireRailPredecessorObserved(id, stateRoot) : null;
  return Object.freeze({ operationId: id, actionClass: 'PaperRail', operation: operation.operation,
    key: operation.note, valueCommitment: operation.valueCommitment, signed: false,
    worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', production: false,
    dependency: predecessorEvidence ? { predecessor: predecessorEvidence.operationId, classification: predecessorEvidence.classification } : undefined,
    executionOrder: { completed, expected: PUBLIC_ORDER[completed.length], valid: PUBLIC_ORDER[completed.length] === id },
    networkCalls: 0, writeBudgetMutations: 0, written: false });
}

export function fixtureRailWrite(id, { completed = [], stateRoot } = {}) {
  const operation = railOperation(id);
  assertExecutionOrder(completed, id); requireRailPredecessorObserved(id, stateRoot);
  const railRoot = stateRoot ? resolve(stateRoot, 'paper-rail') : ROOT;
  const receiptPath = railReceiptPath(id, railRoot);
  if (existsSync(receiptPath)) throw new Error('PAPERRAIL_DUPLICATE_WRITE');
  const expected = expectedRailValue(id);
  const evidence = { schema: 'tclk/phase3b-paper-rail-write-receipt/v1', operationId: id,
    manifestRoot: manifest.manifestRoot, key: operation.note, signed: false, worldWritable: true,
    authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', production: false, valueMoved: false,
    valueCommitment: operation.valueCommitment, expectedValueSha256: expected.expectedValueSha256,
    budgetId: `FIXTURE:${id}`, writtenAt: new Date().toISOString() };
  persistExclusive(receiptPath, evidence);
  return Object.freeze(evidence);
}

export function fixtureRailObserve(id, { stateRoot = ROOT } = {}) {
  const receiptPath = railReceiptPath(id, resolve(stateRoot, 'paper-rail'));
  if (!existsSync(receiptPath)) return Object.freeze({ operationId: id, classification: 'PREEXISTING_UNATTRIBUTED_MATCH' });
  const receipt = readJson(receiptPath);
  if (receipt.production !== false) throw new Error('FIXTURE_RECEIPT_CLASS_INVALID');
  return Object.freeze({ operationId: id, classification: 'OBSERVED_PUBLIC', production: false,
    receiptPath, receiptBudgetId: receipt.budgetId, expectedValueSha256: receipt.expectedValueSha256,
    observedValueSha256: receipt.expectedValueSha256, exactValueMatch: true });
}

export async function productionRailPreflight(id, { stateRoot = ROOT, submitStateRoot, budgetRoot = BUDGET_ROOT,
  transport = fetch, maxBytes = MAX_PUBLIC_READ_BYTES, secretPath = SECRET_PATH } = {}) {
  const operation = railOperation(id);
  const predecessor = PUBLIC_ORDER[PUBLIC_ORDER.indexOf(id) - 1];
  const dependency = requireProductionRailPredecessor(id, stateRoot, submitStateRoot);
  const budget = inspectOneShotAttempt(railBudget(id), { root: budgetRoot });
  const expected = expectedRailValue(id, { secretPath });
  const current = await readPublicNote(operation, transport, maxBytes);
  const previous = id === 'phase3b-write-6' ? expectedRailValue('phase3b-write-5', { secretPath }) : null;
  let keyOccupancy = current.classification; let writeEligible = false;
  if (current.classification === 'KEY_OCCUPIED') {
    const wantedCurrentHash = previous?.expectedValueSha256 ?? expected.expectedValueSha256;
    keyOccupancy = current.observedValueSha256 === wantedCurrentHash
      ? (previous ? 'KEY_OCCUPIED_EXPECTED_PREDECESSOR' : 'PREEXISTING_UNATTRIBUTED_MATCH')
      : 'KEY_OCCUPIED_DIFFERENT_VALUE';
    writeEligible = Boolean(previous && current.observedValueSha256 === wantedCurrentHash);
  } else if (current.classification === 'KEY_VACANT') writeEligible = id === 'phase3b-write-5';
  if (!expected.manifestBindingValid) writeEligible = false;
  return Object.freeze({ operationId: id, actionClass: 'PaperRail', operation: operation.operation,
    key: operation.note, valueCommitment: operation.valueCommitment, expectedValueSha256: expected.expectedValueSha256,
    manifestBindingValid: expected.manifestBindingValid, manifestChangeRequired: !expected.manifestBindingValid,
    signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', predecessor,
    dependencyResolution: dependency?.classification === 'OBSERVED_PUBLIC' ? 'OBSERVED_PUBLIC' : 'HISTORICAL_RETENTION_EXCEPTION',
    keyOccupancy, writeEligible, conditionalWrite: id === 'phase3b-write-5' ? 'IF_ABSENT' : 'COMPARE_AND_SET',
    observedHttpStatus: current.observedHttpStatus, observedContentType: current.observedContentType,
    observedByteLength: current.observedByteLength, observedValueSha256: current.observedValueSha256,
    occupancyFingerprint: hash(JSON.stringify(current)), budgetState: budget.state,
    networkCalls: 1, paperRailWrites: 0, stateRoot });
}

export async function productionRailWrite(id, { stateRoot = ROOT, submitStateRoot, confirm = async () => true,
  transport = fetch, budgetRoot = BUDGET_ROOT, afterApproval = async () => {}, secretPath = SECRET_PATH } = {}) {
  const options = { stateRoot, submitStateRoot, budgetRoot, transport, secretPath };
  const review = await productionRailPreflight(id, options);
  if (!review.writeEligible) throw new Error(review.manifestChangeRequired ? 'MANIFEST_CHANGE_REQUIRED'
    : review.keyOccupancy === 'KEY_OCCUPIED_DIFFERENT_VALUE' ? 'KEY_OCCUPIED_DIFFERENT_VALUE' : 'PAPERRAIL_WRITE_NOT_ELIGIBLE');
  if (!await confirm(review)) throw new Error('OPERATOR_CANCELLED');
  await afterApproval();
  const reread = await productionRailPreflight(id, options);
  if (reread.occupancyFingerprint !== review.occupancyFingerprint || !reread.writeEligible) throw new Error('PAPERRAIL_APPROVAL_INVALIDATED');
  const budget = acquireOneShotAttempt(railBudget(id), { root: budgetRoot });
  const operation = railOperation(id); const expected = expectedRailValue(id, { secretPath });
  const previous = id === 'phase3b-write-6' ? expectedRailValue('phase3b-write-5', { secretPath }) : null;
  const endpoint = `https://technocore.chat/kv/${encodeURIComponent(operation.note.ns)}/${encodeURIComponent(operation.note.key)}`;
  const body = paperRailWriteBody(id, { secretPath });
  let response;
  try { response = await transport(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', credentials: 'omit' }); }
  catch (error) { throw Object.assign(new Error('WRITE_UNCERTAIN'), { cause: error }); }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(response?.status === 409 ? 'PAPERRAIL_CAS_CONFLICT' : `PAPERRAIL_WRITE_REJECTED:HTTP_${response?.status ?? 'UNKNOWN'}`);
  }
  const evidence = { schema: 'tclk/phase3b-paper-rail-write-receipt/v1', production: true, operationId: id,
    manifestRoot: manifest.manifestRoot, key: operation.note, signed: false, worldWritable: true,
    authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false,
    valueCommitment: operation.valueCommitment, expectedValueSha256: expected.expectedValueSha256,
    mutation: operation.operation, condition: id === 'phase3b-write-5' ? { ifAbsent: true } : { ifValueSha256: previous.expectedValueSha256 },
    budgetId: budget.budgetId, requestBodySha256: hash(Buffer.from(body, 'utf8')), httpStatus: response.status,
    writtenAt: new Date().toISOString() };
  const receiptPath = railReceiptPath(id, stateRoot); persistExclusive(receiptPath, evidence);
  return Object.freeze({ ...evidence, endpoint, networkCalls: 3, paperRailWrites: 1, resultPath: receiptPath });
}

export async function productionRailObserve(id, { stateRoot = ROOT, transport = fetch,
  maxBytes = MAX_PUBLIC_READ_BYTES, secretPath = SECRET_PATH } = {}) {
  const operation = railOperation(id); const expected = expectedRailValue(id, { secretPath });
  const current = await readPublicNote(operation, transport, maxBytes);
  const receiptPath = railReceiptPath(id, stateRoot); const receiptPresent = existsSync(receiptPath);
  let receipt = null; let receiptSha256 = null;
  if (receiptPresent) {
    const raw = readFileSync(receiptPath, 'utf8'); receipt = JSON.parse(raw); receiptSha256 = hash(Buffer.from(raw, 'utf8'));
    if (receipt.schema !== 'tclk/phase3b-paper-rail-write-receipt/v1' || receipt.production !== true
      || receipt.operationId !== id || receipt.manifestRoot !== manifest.manifestRoot
      || receipt.key?.ns !== operation.note.ns || receipt.key?.key !== operation.note.key
      || receipt.valueCommitment !== operation.valueCommitment
      || receipt.expectedValueSha256 !== expected.expectedValueSha256 || !receipt.budgetId || !receipt.writtenAt) {
      throw new Error('PAPERRAIL_RECEIPT_INVALID');
    }
  }
  const exactValueMatch = current.observedValueSha256 === expected.expectedValueSha256;
  const classification = current.classification === 'PUBLIC_READ_INVALID' || current.classification === 'KEY_VACANT'
    ? 'PUBLIC_READ_INVALID' : !exactValueMatch ? 'PUBLIC_VALUE_MISMATCH'
      : receiptPresent ? 'OBSERVED_PUBLIC' : 'PREEXISTING_UNATTRIBUTED_MATCH';
  const observation = { schema: 'tclk/phase3b-paper-rail-observation/v2', production: true, operationId: id,
    manifestRoot: manifest.manifestRoot, key: operation.note, signed: false, worldWritable: true,
    authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false,
    valueCommitment: operation.valueCommitment, classification, observationSource: 'PAPERRAIL_READ_ONLY',
    receiptPath: receiptPresent ? receiptPath : null, receiptSha256, receiptBudgetId: receipt?.budgetId ?? null,
    observedHttpStatus: current.observedHttpStatus, observedContentType: current.observedContentType,
    observedByteLength: current.observedByteLength, observedValueSha256: current.observedValueSha256,
    expectedValueSha256: expected.expectedValueSha256, exactValueMatch,
    receiptWrittenAt: receipt?.writtenAt ?? null, observedAt: new Date().toISOString(),
    boundedSanitizedDiagnostic: current.boundedSanitizedDiagnostic };
  if (classification === 'OBSERVED_PUBLIC' && Date.parse(receipt.writtenAt) >= Date.parse(observation.observedAt)) {
    throw new Error('PAPERRAIL_RECEIPT_ORDER_INVALID');
  }
  const observationPath = productionRailObservationPath(id, stateRoot);
  if (existsSync(observationPath)) throw new Error('PAPERRAIL_OBSERVATION_ALREADY_EXISTS');
  persistExclusive(observationPath, observation);
  return Object.freeze({ ...observation, observationPath });
}

export function quarantineHistoricalRailObservation(id = 'phase3b-write-5', { stateRoot = ROOT } = {}) {
  const historicalPath = railPath(id, stateRoot); const observationPath = railObservationPath(id, stateRoot);
  if (!existsSync(historicalPath) || !existsSync(observationPath)) throw new Error('HISTORICAL_RAIL_EVIDENCE_MISSING');
  const historicalRaw = readFileSync(historicalPath); const observationRaw = readFileSync(observationPath);
  const observation = JSON.parse(observationRaw.toString('utf8'));
  if (observation.classification !== 'OBSERVED_PUBLIC' || existsSync(railReceiptPath(id, stateRoot))) {
    throw new Error('HISTORICAL_FALSE_POSITIVE_NOT_REPRODUCED');
  }
  const reconciliation = { schema: 'tclk/phase3b-paper-rail-reconciliation/v1', operationId: id,
    classification: 'FALSE_POSITIVE_OBSERVER_HISTORICAL', reason: 'NO_SUCCESSFUL_LOCAL_RAIL_WRITE_RECEIPT',
    historicalEvidencePath: historicalPath, historicalEvidenceSha256: hash(historicalRaw),
    historicalObservationPath: observationPath, historicalObservationSha256: hash(observationRaw),
    manifestRoot: manifest.manifestRoot, productionEligible: false };
  persistExclusive(resolve(stateRoot, `${id}-reconciliation.json`), reconciliation);
  return Object.freeze(reconciliation);
}
