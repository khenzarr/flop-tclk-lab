import { existsSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import manifest from '../evidence/phase3b-exact-manifest.json' with { type: 'json' };
import { PUBLIC_ORDER } from './phase3b2.mjs';

const submitRoot = resolve('blackbox/state/phase3b-submit');
const railRoot = resolve('blackbox/state/phase3b-paper-rail');
const output = resolve('evidence/local-phase3b-production-capsule.json');
const read = path => { if (!existsSync(path)) throw new Error(`FINALIZE_MISSING_EVIDENCE:${path}`); return JSON.parse(readFileSync(path, 'utf8')); };
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function finalizeProductionJourney({ submitStateRoot = submitRoot, railStateRoot = railRoot, outputPath = output } = {}) {
  const observations = PUBLIC_ORDER.map(operationId => {
    const evidence = operationId === 'phase3b-write-5' || operationId === 'phase3b-write-6'
      ? read(resolve(railStateRoot, `${operationId}-production-observation.json`))
      : read(resolve(submitStateRoot, `${operationId}-observation.json`));
    if (evidence.operationId !== operationId) throw new Error(`FINALIZE_OPERATION_MISMATCH:${operationId}`);
    if (operationId === 'phase3b-write-2' && evidence.classification !== 'SERVER_APPENDED_THEN_NOT_RETAINED') throw new Error('FINALIZE_WRITE2_RETENTION_CLASSIFICATION_INVALID');
    if (operationId !== 'phase3b-write-2' && operationId !== 'phase3b-write-5' && operationId !== 'phase3b-write-6' && evidence.classification !== 'OBSERVED_PUBLIC') throw new Error(`FINALIZE_NOT_OBSERVED_PUBLIC:${operationId}`);
    if (operationId === 'phase3b-write-5' || operationId === 'phase3b-write-6') {
      const receiptPath = resolve(railStateRoot, `${operationId}-write-receipt.json`);
      const receipt = read(receiptPath);
      if (evidence.schema !== 'tclk/phase3b-paper-rail-observation/v2' || evidence.production !== true
        || evidence.classification !== 'OBSERVED_PUBLIC'
        || receipt.schema !== 'tclk/phase3b-paper-rail-write-receipt/v1' || receipt.production !== true
        || evidence.evidenceClass !== 'UNSIGNED_RAIL_OBSERVATION' || evidence.valueMoved !== false
        || evidence.receiptPath !== receiptPath || evidence.receiptBudgetId !== receipt.budgetId
        || evidence.receiptSha256 !== sha256File(receiptPath)
        || receipt.operationId !== operationId || receipt.manifestRoot !== manifest.manifestRoot
        || receipt.key?.ns !== evidence.key?.ns || receipt.key?.key !== evidence.key?.key
        || receipt.valueCommitment !== evidence.valueCommitment
        || receipt.expectedValueSha256 !== evidence.expectedValueSha256
        || evidence.observedValueSha256 !== evidence.expectedValueSha256
        || evidence.exactValueMatch !== true || evidence.observedHttpStatus !== 200
        || !receipt.writtenAt || !evidence.receiptWrittenAt || !evidence.observedAt
        || !Number.isFinite(Date.parse(receipt.writtenAt)) || !Number.isFinite(Date.parse(evidence.receiptWrittenAt))
        || !Number.isFinite(Date.parse(evidence.observedAt)) || Date.parse(receipt.writtenAt) !== Date.parse(evidence.receiptWrittenAt)
        || Date.parse(evidence.receiptWrittenAt) >= Date.parse(evidence.observedAt)) {
        throw new Error(`FINALIZE_PAPERRAIL_EVIDENCE_INVALID:${operationId}`);
      }
    }
    return evidence;
  });
  const gaps = observations.filter(item => item.classification === 'SERVER_APPENDED_THEN_NOT_RETAINED');
  if (gaps.length !== 1 || gaps[0].operationId !== 'phase3b-write-2') throw new Error('FINALIZE_RETENTION_GAP_INVALID');
  if (existsSync(outputPath)) throw new Error('FINAL_CAPSULE_ALREADY_EXISTS');
  const capsule = { schema: 'tclk/phase3b-production-evidence-capsule/v1', source: 'PERSISTED_MACHINE_LOCAL_PHASE3B_STATE', production: true,
    manifestRoot: manifest.manifestRoot, order: PUBLIC_ORDER, observations, acceptance: 'PHASE3B_PUBLIC_TRANSCRIPT_COMPLETE',
    PUBLIC_TRANSCRIPT_EVIDENCE_COMPLETE: 'YES', CURRENT_PUBLIC_RETENTION_COMPLETE: 'NO', RETENTION_GAP_COUNT: 1,
    RETENTION_GAP_OPERATION: 'phase3b-write-2', distinctions: ['SIGNED != SUBMITTED', 'ACK_RECEIVED != OBSERVED_PUBLIC', 'SERVER_APPENDED_THEN_NOT_RETAINED != OBSERVED_PUBLIC', 'PaperRail != PAYMENT', 'signature != HUMAN IDENTITY'] };
  mkdirSync(resolve(outputPath, '..'), { recursive: true }); const fd = openSync(outputPath, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(capsule, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  return Object.freeze({ ...capsule, path: outputPath });
}

if (process.argv[1]?.endsWith('phase3b-finalize.mjs')) {
  try { process.stdout.write(`${JSON.stringify(finalizeProductionJourney())}\n`); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
