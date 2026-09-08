// Offline PaperRail controller. The production rail is intentionally not imported here.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../evidence/phase3b-exact-manifest.json' with { type: 'json' };
import { PUBLIC_ORDER, assertExecutionOrder, manifestOperation } from './phase3b2.mjs';

const ROOT = resolve('blackbox/state/phase3b-paper-rail');
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
export function railOperation(id) {
  const operation = manifestOperation(id);
  if (operation.actionClass !== 'PaperRail') throw new Error('NOT_PAPERRAIL_OPERATION');
  return operation;
}
export function fixtureRailPreflight(id, { completed = [] } = {}) {
  const operation = railOperation(id);
  return Object.freeze({ operationId: id, actionClass: 'PaperRail', operation: operation.operation,
    key: operation.note, valueCommitment: operation.valueCommitment, signed: false,
    worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION',
    executionOrder: { completed, expected: PUBLIC_ORDER[completed.length], valid: PUBLIC_ORDER[completed.length] === id },
    networkCalls: 0, writeBudgetMutations: 0, written: false });
}
export function fixtureRailWrite(id, { completed = [] } = {}) {
  const operation = railOperation(id);
  assertExecutionOrder(completed, id);
  mkdirSync(ROOT, { recursive: true });
  const path = resolve(ROOT, `${id}.json`);
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