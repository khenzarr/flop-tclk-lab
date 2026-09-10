import { createHash } from 'node:crypto';
import { publicSession, readSession, saveSession } from './session.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const FINAL_STATES = new Set(['VERIFIED', 'COMPLETE']);

function operation(session, operationId) {
  const item = session.operations.find(candidate => candidate.id === operationId);
  if (!item) throw new Error('OPERATION_NOT_ALLOWED');
  const previous = session.operations[item.ordinal - 2];
  if (previous && !FINAL_STATES.has(previous.state)) throw new Error('PREDECESSOR_EVIDENCE_REQUIRED');
  return item;
}

function event(item, state, detail = null) {
  item.state = state; item.updatedAt = new Date().toISOString();
  item.history ??= []; item.history.push({ state, at: item.updatedAt, ...(detail ? { detail } : {}) });
}

function unlockNext(session, item) {
  const next = session.operations[item.ordinal];
  if (next && next.state === 'BLOCKED') event(next, 'READY', 'Predecessor evidence complete');
}

function safeResult(result) {
  if (!result || typeof result !== 'object') return {};
  const blocked = /secret|preimage|private|signature|passphrase|seed|path/i;
  return Object.fromEntries(Object.entries(result).filter(([key]) => !blocked.test(key)));
}

export class DealEngine {
  constructor({ root, executor }) { this.root = root; this.executor = executor; this.active = new Set(); }

  async inspect(id) { return publicSession(await readSession(id, { root: this.root })); }

  async prepare(id, operationId) {
    const session = await readSession(id, { root: this.root }); const item = operation(session, operationId);
    let action;
    if (item.state === 'READY') action = item.kind === 'rail' ? 'PAPERRAIL_WRITE' : 'SIGN';
    else if (item.state === 'SIGNED') action = 'SUBMIT';
    else if (item.state === 'NOT_OBSERVED' && item.recoveryAvailable === true) action = item.kind === 'rail' ? 'PAPERRAIL_RECOVERY_WRITE' : 'RECOVERY_SUBMIT';
    else throw new Error(`ACTION_NOT_PREPARABLE:${item.state}`);
    const review = await this.executor.prepare({ session, operation: item, action });
    item.pending = { action, fingerprint: sha256(JSON.stringify(review)), review: safeResult(review) };
    event(item, 'AWAITING_LOCAL_APPROVAL', action); await saveSession(session, { root: this.root });
    return { session: publicSession(session), approval: { action, review: item.pending.review, terminalRequired: true } };
  }

  async execute(id, operationId) {
    if (this.active.has(operationId)) throw new Error('ACTION_ALREADY_RUNNING'); this.active.add(operationId);
    try {
      const session = await readSession(id, { root: this.root }); const item = operation(session, operationId);
      if (item.state !== 'AWAITING_LOCAL_APPROVAL' || !item.pending) throw new Error('PREPARE_REQUIRED');
      const pending = item.pending; const result = await this.executor.execute({ session, operation: item, action: pending.action, fingerprint: pending.fingerprint });
      item.attempts.push({ action: pending.action, at: new Date().toISOString(), result: safeResult(result) }); delete item.pending;
      if (pending.action === 'SIGN') event(item, 'SIGNED', 'Signature verified locally; not submitted');
      else if (result.classification === 'ACK_RECEIVED') event(item, 'ACK_RECEIVED', 'Venue acknowledged; public observation still required');
      else if (result.classification === 'REJECTED') event(item, 'REJECTED', result.diagnostic ?? 'Venue rejected the request');
      else if (result.classification === 'SUBMISSION_UNCERTAIN') event(item, 'SUBMISSION_UNCERTAIN', 'No retry; observation required');
      else if (result.classification === 'WRITE_RECEIPT') event(item, 'WRITE_RECEIPT', 'Receipt recorded; exact public read required');
      else throw new Error('EXECUTOR_RESULT_INVALID');
      item.evidence = { ...(item.evidence ?? {}), ...safeResult(result) }; await saveSession(session, { root: this.root });
      return publicSession(session);
    } finally { this.active.delete(operationId); }
  }

  async refresh(id, operationId) {
    const session = await readSession(id, { root: this.root }); const item = operation(session, operationId);
    if (!['ACK_RECEIVED', 'SUBMISSION_UNCERTAIN', 'WRITE_RECEIPT'].includes(item.state)) throw new Error(`OBSERVATION_NOT_AVAILABLE:${item.state}`);
    const result = await this.executor.observe({ session, operation: item }); item.evidence = { ...(item.evidence ?? {}), ...safeResult(result) };
    if (result.classification === 'OBSERVED_PUBLIC' && (item.kind !== 'rail' || result.exactValueMatch === true)) {
      event(item, 'VERIFIED', 'Required public evidence found'); unlockNext(session, item);
    } else if (result.classification === 'NOT_OBSERVED') {
      event(item, 'NOT_OBSERVED', 'Exact public record was not found'); item.recoveryAvailable = result.recoveryAvailable === true;
    } else event(item, 'BLOCKED', result.diagnostic ?? 'Public evidence did not satisfy completion policy');
    await saveSession(session, { root: this.root }); return publicSession(session);
  }

  async finalize(id) {
    const session = await readSession(id, { root: this.root });
    if (!session.operations.every(item => item.state === 'VERIFIED')) throw new Error('FINALIZE_REQUIRES_ALL_EVIDENCE');
    session.operations.forEach(item => event(item, 'COMPLETE', 'Included in final flight record'));
    session.finalized = true; session.completedAt = new Date().toISOString();
    session.publicCapsule = this.executor.exportPublic({ session }); await saveSession(session, { root: this.root });
    return publicSession(session);
  }
}

export class SimulatedExecutor {
  constructor({ submitOutcomes = [] } = {}) { this.submitOutcomes = [...submitOutcomes]; }
  async prepare({ operation, action }) { return { operationId: operation.id, action, mode: 'SIMULATED_LOCAL_TEST' }; }
  async execute({ operation, action }) {
    if (action === 'SIGN') return { classification: 'SIGNED', signed: true, simulated: true };
    if (action.startsWith('PAPERRAIL_')) return { classification: 'WRITE_RECEIPT', receiptSha256: sha256(`${operation.id}:receipt`), simulated: true };
    const classification = this.submitOutcomes.shift() ?? 'ACK_RECEIVED';
    return { classification, httpStatus: classification === 'REJECTED' ? 400 : classification === 'SUBMISSION_UNCERTAIN' ? 500 : 200,
      diagnostic: classification === 'REJECTED' ? 'Sanitized simulated rejection' : null, simulated: true };
  }
  async observe({ operation }) {
    if (operation.kind === 'rail') return { classification: 'OBSERVED_PUBLIC', exactValueMatch: true, observedValueSha256: sha256(`${operation.id}:value`), simulated: true };
    if (operation.state === 'SUBMISSION_UNCERTAIN') return { classification: 'NOT_OBSERVED', recoveryAvailable: !operation.attempts.some(item => item.action === 'RECOVERY_SUBMIT'), simulated: true };
    return { classification: 'OBSERVED_PUBLIC', exactMatchCount: 1, signatureSeen: true, simulated: true };
  }
  exportPublic({ session }) { return { schema: 'tclk-blackbox/public-deal-capsule/v1', simulated: true, label: 'SIMULATED / LOCAL TEST',
    sessionId: session.id, manifestRoot: session.manifestRoot, complete: true, operations: session.operations.map(publicOperation => ({ id: publicOperation.id, step: publicOperation.step, state: 'COMPLETE' })) }; }
}
