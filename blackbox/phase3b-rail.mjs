// Production PaperRail controller. It is deliberately transport-injected for offline rehearsal
// and tests; the default transport is the real venue only when a human invokes the write command.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../evidence/phase3b-exact-manifest.json' with { type: 'json' };
import { PUBLIC_ORDER, assertExecutionOrder, manifestOperation } from './phase3b2.mjs';
import { requireObservedPublic } from './phase3b-submit-observe.mjs';
import { budgetIdentity, acquireOneShotAttempt, inspectOneShotAttempt, BUDGET_ROOT } from './airlock/attempt-budget.mjs';

const ROOT = resolve('blackbox/state/phase3b-paper-rail');
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
function requireRailPredecessorObserved(id, stateRoot) {
  const predecessor = PUBLIC_ORDER[PUBLIC_ORDER.indexOf(id) - 1];
  if (!predecessor) return null;
  return requireObservedPublic(id, stateRoot);
}
export function railOperation(id) {
  const operation = manifestOperation(id);
  if (operation.actionClass !== 'PaperRail') throw new Error('NOT_PAPERRAIL_OPERATION');
  return operation;
}
export function fixtureRailPreflight(id, { completed = [], stateRoot } = {}) {
  const operation = railOperation(id);
  const predecessorEvidence = stateRoot ? requireRailPredecessorObserved(id, stateRoot) : null;
  return Object.freeze({ operationId: id, actionClass: 'PaperRail', operation: operation.operation,
    key: operation.note, valueCommitment: operation.valueCommitment, signed: false,
    worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION',
    dependency: predecessorEvidence ? { predecessor: predecessorEvidence.operationId, classification: predecessorEvidence.classification } : undefined,
    executionOrder: { completed, expected: PUBLIC_ORDER[completed.length], valid: PUBLIC_ORDER[completed.length] === id },
    networkCalls: 0, writeBudgetMutations: 0, written: false });
}
export function fixtureRailWrite(id, { completed = [], stateRoot } = {}) {
  const operation = railOperation(id);
  assertExecutionOrder(completed, id);
  requireRailPredecessorObserved(id, stateRoot);
  const railRoot = stateRoot ? resolve(stateRoot, 'paper-rail') : ROOT;
  mkdirSync(railRoot, { recursive: true });
  const path = resolve(railRoot, `${id}.json`);
  if (existsSync(path)) throw new Error('PAPERRAIL_DUPLICATE_WRITE');
  const evidence = { schema: 'tclk/phase3b-paper-rail-observation/v1', operationId: id,
    manifestRoot: manifest.manifestRoot, key: operation.note, signed: false, worldWritable: true,
    authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false,
    valueCommitment: operation.valueCommitment };
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return Object.freeze(evidence);
}
export function fixtureRailObserve(id) {
  const operation = railOperation(id);
  const path = resolve(ROOT, `${id}.json`);
  if (!existsSync(path)) throw new Error('PAPERRAIL_NOT_FOUND');
  const evidence = JSON.parse(readFileSync(path, 'utf8'));
  if (evidence.operationId !== id || evidence.manifestRoot !== manifest.manifestRoot || evidence.valueCommitment !== operation.valueCommitment) throw new Error('PAPERRAIL_OBSERVATION_MISMATCH');
  return Object.freeze({ ...evidence, classification: 'OBSERVED_PUBLIC', observationSource: 'FIXTURE_PAPER_RAIL' });
}

function railPath(id, stateRoot = ROOT) { return resolve(stateRoot, `${id}.json`); }
function railObservationPath(id, stateRoot = ROOT) { return resolve(stateRoot, `${id}-observation.json`); }
function railBudget(id) { return budgetIdentity({ purpose: 'PHASE3B_PAPERRAIL_WRITE', operationClass: 'REAL_PAPERRAIL_NOTE_WRITE', subject: id }); }

export function productionRailPreflight(id, { stateRoot, submitStateRoot, budgetRoot = BUDGET_ROOT } = {}) {
  const operation = railOperation(id);
  const predecessor = PUBLIC_ORDER[PUBLIC_ORDER.indexOf(id) - 1];
  const dependency = requireObservedPublic(id, submitStateRoot);
  const budget = inspectOneShotAttempt(railBudget(id), { root: budgetRoot });
  return Object.freeze({ operationId: id, actionClass: 'PaperRail', operation: operation.operation,
    key: operation.note, valueCommitment: operation.valueCommitment, signed: false, worldWritable: true,
    authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', predecessor,
    dependencyResolution: dependency?.classification === 'OBSERVED_PUBLIC' ? 'OBSERVED_PUBLIC' : 'HISTORICAL_RETENTION_EXCEPTION',
    budgetState: budget.state, networkCalls: 0, paperRailWrites: 0, stateRoot: stateRoot ?? ROOT });
}

export async function productionRailWrite(id, { stateRoot = ROOT, submitStateRoot, confirm = async () => true,
  transport = fetch, budgetRoot = BUDGET_ROOT, afterApproval = async () => {} } = {}) {
  const review = productionRailPreflight(id, { stateRoot, submitStateRoot, budgetRoot });
  if (!await confirm(review)) throw new Error('OPERATOR_CANCELLED');
  await afterApproval();
  const budget = acquireOneShotAttempt(railBudget(id), { root: budgetRoot });
  const operation = railOperation(id); const path = railPath(id, stateRoot);
  if (existsSync(path)) throw new Error('PAPERRAIL_DUPLICATE_WRITE');
  const endpoint = `https://technocore.chat/kv/${encodeURIComponent(operation.note.ns)}/${encodeURIComponent(operation.note.key)}`;
  const body = JSON.stringify({ operation: operation.operation, valueCommitment: operation.valueCommitment });
  let response;
  try { response = await transport(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', credentials: 'omit' }); }
  catch (error) { throw Object.assign(new Error('WRITE_UNCERTAIN'), { cause: error }); }
  if (!response || response.status < 200 || response.status >= 300) throw new Error(`PAPERRAIL_WRITE_REJECTED:HTTP_${response?.status ?? 'UNKNOWN'}`);
  const evidence = { schema: 'tclk/phase3b-paper-rail-observation/v1', operationId: id, manifestRoot: manifest.manifestRoot,
    key: operation.note, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION',
    valueMoved: false, valueCommitment: operation.valueCommitment, mutation: operation.operation, budgetId: budget.budgetId };
  mkdirSync(stateRoot, { recursive: true }); const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(evidence, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  return Object.freeze({ ...evidence, endpoint, networkCalls: 1, paperRailWrites: 1, resultPath: path });
}

export function productionRailObserve(id, { stateRoot = ROOT } = {}) {
  const operation = railOperation(id); const path = railPath(id, stateRoot);
  if (!existsSync(path)) throw new Error('PAPERRAIL_NOT_FOUND');
  const evidence = JSON.parse(readFileSync(path, 'utf8'));
  if (evidence.operationId !== id || evidence.manifestRoot !== manifest.manifestRoot || evidence.valueCommitment !== operation.valueCommitment) throw new Error('PAPERRAIL_OBSERVATION_MISMATCH');
  const observation = { ...evidence, classification: 'OBSERVED_PUBLIC', observationSource: 'PAPERRAIL_READ_ONLY' };
  const observationPath = railObservationPath(id, stateRoot);
  if (existsSync(observationPath)) throw new Error('PAPERRAIL_OBSERVATION_ALREADY_EXISTS');
  mkdirSync(stateRoot, { recursive: true });
  const fd = openSync(observationPath, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(observation, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  return Object.freeze({ ...observation, observationPath });
}