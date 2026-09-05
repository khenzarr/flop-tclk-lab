// HUMAN-OWNED APPROVAL HANDOFF — Phase 3A.9.
// This module contains no custody or signing capability. Approval is process-local and is never
// accepted from argv, environment, files, or a previous run.
import { createInterface } from 'node:readline';
import { fingerprintRequest, requestIsIntact } from './envelope.mjs';

export const REAL_COMMAND = 'pnpm airlock:real-detached-sign';

export function requireInteractiveOperatorTerminal(streams = { stdin: process.stdin, stdout: process.stdout }) {
  if (streams.stdin?.isTTY !== true || streams.stdout?.isTTY !== true) {
    throw new Error('INTERACTIVE_TTY_REQUIRED: approval must be entered in a human-owned terminal');
  }
}

export function approvalCode(request) {
  if (!requestIsIntact(request)) throw new Error('cannot derive approval code from an intact request');
  return fingerprintRequest(request).slice(-4).toUpperCase();
}

export function expectedApprovalPhrase(request) {
  return `SIGN ONCE ${approvalCode(request)}`;
}

/** A review snapshot is deliberately limited to public binding values. */
export function reviewSnapshot(request, { canonicalCommit, tclkPin, phase3bReuse = 'NO' }) {
  if (!requestIsIntact(request)) throw new Error('cannot review an invalid request');
  const snapshot = Object.freeze({
    requestFingerprint: request.requestFingerprint,
    canonicalHash: request.canonicalHash,
    room: request.intendedRoom,
    signerDid: request.signerDid,
    canonicalCommit,
    tclkPin,
    phase3bReuse,
  });
  return snapshot;
}

export function recheckApprovalBinding(request, snapshot, currentMetadata = snapshot) {
  const findings = [];
  if (!requestIsIntact(request)) findings.push('REQUEST_MUTATED_AFTER_APPROVAL');
  const current = requestIsIntact(request) ? reviewSnapshot(request, currentMetadata) : null;
  if (current) for (const key of Object.keys(snapshot)) {
    if (current[key] !== snapshot[key]) findings.push(`${key.toUpperCase()}_MUTATED_AFTER_APPROVAL`);
  }
  return Object.freeze({ ok: findings.length === 0, findings: Object.freeze(findings) });
}

/** Fixture-only provider contract. It returns a phrase, not an approval token or persisted state. */
export function fixtureOperatorConfirmation({ response = 'correct', request }) {
  if (response === 'correct') return expectedApprovalPhrase(request);
  if (response === 'cancel') return null;
  if (response === 'blank') return '';
  return `SIGN ONCE ${String(response).toUpperCase()}`;
}

export function confirmFixtureOperator(request, provider = fixtureOperatorConfirmation) {
  const entered = provider({ request });
  if (entered === null) return Object.freeze({ ok: false, code: 'OPERATOR_CANCELLED' });
  if (entered !== expectedApprovalPhrase(request)) return Object.freeze({ ok: false, code: 'WRONG_APPROVAL_CODE' });
  return Object.freeze({ ok: true, code: 'APPROVED' });
}

/** Production-only interactive prompt. readline never sees a credential; it ends before custody. */
export async function promptHumanOperator(request, { stdin = process.stdin, stdout = process.stdout } = {}) {
  requireInteractiveOperatorTerminal({ stdin, stdout });
  const phrase = expectedApprovalPhrase(request);
  stdout.write(`\nType exactly: ${phrase}\nApproval (blank or Ctrl+C cancels): `);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const entered = await new Promise(resolve => {
      rl.once('SIGINT', () => resolve(null));
      rl.once('line', line => resolve(line.trim()));
    });
    if (entered === null || entered === '') return Object.freeze({ ok: false, code: 'OPERATOR_CANCELLED' });
    return entered === phrase
      ? Object.freeze({ ok: true, code: 'APPROVED' })
      : Object.freeze({ ok: false, code: 'WRONG_APPROVAL_CODE' });
  } finally { rl.close(); }
}

export function approvalInvalidated(request, snapshot) {
  return recheckApprovalBinding(request, snapshot);
}