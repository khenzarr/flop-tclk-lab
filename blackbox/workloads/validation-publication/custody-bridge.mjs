// W2's only BLACKBOX-to-trusted-signer handoff. No private material enters Node.
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CANONICAL_WORKTREE, canonicalPython, protectedCustodyStateRoot } from '../../airlock/detached-bridge.mjs';
import { requireInteractiveOperatorTerminal } from '../../airlock/operator-approval.mjs';
import { requireNonce } from './canonical.mjs';

const exec = promisify(execFile);
export const REVIEWED_W2_SIGNER_COMMIT = 'ceee25b573c9385e79b50b46ddd044204185aa3e';

function reservationCreatedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  throw new Error('W2_CUSTODY_RESERVATION_MISMATCH');
}

async function inspectSigner(worktree) {
  const root = resolve(worktree, '..');
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    exec('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true }),
    exec('git', ['-C', root, 'status', '--porcelain', '--', 'local-agent/src/technocore_agent/signer',
      'local-agent/src/technocore_agent/storage/nonce.py', 'local-agent/src/technocore_agent/service/runtime.py'], { windowsHide: true }),
  ]);
  return { commit: commit.trim(), status: status.trim() };
}

export async function assertReviewedW2Signer(worktree = CANONICAL_WORKTREE, expectedCommit = REVIEWED_W2_SIGNER_COMMIT, inspect = inspectSigner) {
  const state = await inspect(worktree);
  if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? '') || state.commit !== expectedCommit || state.status) throw new Error('W2_REVIEWED_SIGNER_REQUIRED');
  return state.commit;
}

function childOnce(python, args, { cwd, realSign }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, args, { cwd, env: { ...process.env, PYTHONPATH: 'src' }, windowsHide: true,
      stdio: realSign ? ['inherit', 'pipe', 'inherit'] : ['ignore', 'pipe', 'ignore'] });
    let output = ''; let excessive = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 16384) { excessive = true; child.kill(); } });
    child.on('error', reject);
    child.on('close', code => excessive || code !== 0 ? reject(new Error('W2_CUSTODY_REFUSED')) : resolveResult(output));
  });
}

export class W2TrustedCustody {
  constructor({ identities, worktree = CANONICAL_WORKTREE } = {}) {
    this.identities = identities; this.worktree = worktree;
  }

  async invoke(frame, { signing = false } = {}) {
    const commit = await assertReviewedW2Signer(this.worktree);
    if (signing) requireInteractiveOperatorTerminal();
    const requestPath = resolve(tmpdir(), `blackbox-w2-custody-${randomUUID()}.json`);
    try {
      await writeFile(requestPath, JSON.stringify({ ...frame, expectedCanonicalCommit: commit }), { flag: 'wx', mode: 0o600 });
      const output = await childOnce(canonicalPython(this.worktree), ['-m', 'technocore_agent.signer.w2_reserved_bridge',
        '--request-file', requestPath, '--custody', 'real', '--state', protectedCustodyStateRoot()],
      { cwd: this.worktree, realSign: signing });
      let response; try { response = JSON.parse(output); } catch { throw new Error('W2_CUSTODY_RESPONSE_INVALID'); }
      if (response?.error || response?.canonicalCommit !== commit || response?.custodyMode !== 'real'
        || response?.requestId !== frame.requestId) throw new Error('W2_CUSTODY_RESPONSE_INVALID');
      return response;
    } finally { await rm(requestPath, { force: true }); }
  }

  async profile(did) { return this.identities.existingSignerProfile(did); }

  async reserve({ requestId, room, signerDid, venueOrigin, signedTextSha256 }) {
    const profile = await this.profile(signerDid);
    const value = await this.invoke({ schema: 'technocore-w2-reserve-request/v1', purpose: 'W2_RESERVE_ROOM_NONCE',
      requestId, profile, expectedSignerDid: signerDid, targetRoom: room, targetVenueOrigin: venueOrigin, signedTextSha256 });
    requireNonce(value.nonce, { allowZero: false });
    if (value.schema !== 'technocore-w2-reservation/v1' || value.state !== 'RESERVED'
      || value.signerDid !== signerDid || value.room !== room || value.venueOrigin !== venueOrigin
      || !Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error('W2_CUSTODY_RESERVATION_MISMATCH');
    return { ...value, createdAt: reservationCreatedAt(value.createdAt) };
  }

  async signReserved({ requestId, signerDid, nonce, approvalCandidate, approvalHash, operationId }) {
    const profile = await this.profile(signerDid);
    const value = await this.invoke({ schema: 'technocore-w2-sign-reserved-request/v1', purpose: 'W2_SIGN_EXACT_RESERVATION',
      requestId, profile, expectedSignerDid: signerDid, approvalCandidate, approvalHash }, { signing: true });
    if (value.schema !== 'technocore-w2-signed-operation/v1' || value.did !== signerDid || value.nonce !== nonce
      || value.operationId !== operationId || value.approvalHash !== approvalHash) throw new Error('W2_CUSTODY_SIGNATURE_MISMATCH');
    return value;
  }

  async cancelReserved({ requestId, signerDid, nonce, approvalCandidate, approvalHash, operationId, reason }) {
    const profile = await this.profile(signerDid);
    const value = await this.invoke({ schema: 'technocore-w2-cancel-reserved-request/v1', purpose: 'W2_CANCEL_EXACT_RESERVATION',
      requestId, profile, expectedSignerDid: signerDid, approvalCandidate, approvalHash, cancelReason: reason });
    if (value.schema !== 'technocore-w2-cancellation/v1' || value.signerDid !== signerDid || value.nonce !== nonce
      || value.operationId !== operationId || value.state !== 'BURNED') throw new Error('W2_CUSTODY_CANCELLATION_MISMATCH');
    return value;
  }
}
