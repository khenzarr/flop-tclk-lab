// The only Blackbox-to-canonical signer boundary. stdout is always captured and never logged.
//
// PHASE 3B.2-PREP — the human real SIGN route is executable; SUBMIT/OBSERVE remain unavailable:
//
//   * `custody: 'real'` refuses unless this process owns an interactive operator terminal, and the
//     child then runs its OWN request-bound interactive confirmation before touching custody;
//   * the request file carries non-secret operation metadata only — it is transport, never
//     authorization, and never an approval phrase;
//   * for real custody the child's stdin and stderr stay attached to the human terminal, so a
//     later custody credential prompt is typed directly into the canonical child. Node cannot
//     read, proxy, or capture it. Only stdout (the machine response) is captured;
//   * the reviewed CLI owner supplies a frozen durable-budget receipt immediately before the
//     child is contacted; this bridge validates that capability and never acquires a budget.
//
// Fixture validation drives this same function; only the custody provider and the interactive
// input provider are test implementations.
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { REVIEWED_CANONICAL_COMMIT } from './budget.mjs';
import { requireInteractiveOperatorTerminal } from './operator-approval.mjs';

const execFileAsync = promisify(execFile);
const BLACKBOX_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CANONICAL_WORKTREE = resolve(BLACKBOX_ROOT, '..', '..', 'technocore-agent-canonical-profile-signing', 'local-agent');
export const DETACHED_REQUEST_SCHEMA = 'technocore-detached-sign-request/v2';
export const DETACHED_PURPOSE = 'DETACHED_ROOM_SIGNING';

export function canonicalPython(worktree) {
  const candidates = process.platform === 'win32'
    ? [resolve(worktree, '.venv', 'Scripts', 'python.exe'), 'py.exe', 'python.exe']
    : [resolve(worktree, '.venv', 'bin', 'python'), 'python3', 'python'];
  const executable = candidates.find(candidate => candidate.includes('/') || candidate.includes('\\')
    ? existsSync(candidate) : true);
  if (!executable) throw new Error('REFUSE: canonical Python interpreter is unavailable');
  return executable;
}

/** The unmodified DPAPI custody location. Blackbox never reads or writes inside it. */
export function protectedCustodyStateRoot() {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('REFUSE: protected custody state root is unavailable');
  return resolve(local, 'TechnocoreAgent');
}

function runBridgeProcess(python, args, { cwd, env, stdio }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, args, { cwd, env, windowsHide: true, stdio });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
    if (child.stdin) child.stdin.end();
  });
}

export async function assertReviewedCanonicalWorktree(worktree = CANONICAL_WORKTREE) {
  const root = resolve(worktree, '..');
  const { stdout: commit } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true });
  const { stdout: status } = await execFileAsync('git', ['-C', root, 'status', '--porcelain', '--', 'local-agent/src/technocore_agent/signer', 'local-agent/src/technocore_agent/storage/nonce.py'], { windowsHide: true });
  if (commit.trim() !== REVIEWED_CANONICAL_COMMIT || status.trim() !== '') throw new Error('REFUSE: canonical signer commit or relevant tree is not reviewed and clean');
  return Object.freeze({ commit: commit.trim(), clean: true });
}

/** Non-secret operation metadata only: no approval phrase, credential, key, or seed. */
export function detachedRequestFrame({ room, text, requestId }) {
  return Object.freeze({
    schema: DETACHED_REQUEST_SCHEMA,
    room,
    text,
    requestId,
    expectedCanonicalCommit: REVIEWED_CANONICAL_COMMIT,
    purpose: DETACHED_PURPOSE,
  });
}

function requireRealSignBudget(signBudget, requestId) {
  if (!signBudget || typeof signBudget !== 'object' || !Object.isFrozen(signBudget)) {
    throw new Error('REAL_SIGN_BUDGET_CAPABILITY_REQUIRED: acquire the reviewed one-shot budget before the signer boundary');
  }
  if (signBudget.acquired !== true
    || signBudget.purpose !== 'PHASE3B_SIGN'
    || signBudget.operationClass !== 'REAL_DETACHED_ROOM_SIGNATURE'
    || typeof signBudget.budgetId !== 'string'
    || signBudget.subject !== requestId) {
    throw new Error('REAL_SIGN_BUDGET_CAPABILITY_INVALID: receipt is not bound to this reviewed SIGN request');
  }
  return signBudget;
}

/**
 * The single production handoff. `custody` selects the canonical provider; nothing else differs.
 *
 * Real custody additionally requires this process to own an interactive terminal, and the child
 * performs its own independent human confirmation. There is no argv, environment, or file input
 * that can stand in for either human checkpoint, and there is no retry.
 */
export async function invokeDetachedBridge({
  room, text, requestId = randomUUID(), custody = 'fixture',
  worktree = CANONICAL_WORKTREE, state, approvalResponse, profile = 'default', expectedSignerDid, signBudget,
} = {}) {
  if (custody !== 'fixture' && custody !== 'real') throw new Error('REFUSE: custody mode is invalid');
  await assertReviewedCanonicalWorktree(worktree);
  const real = custody === 'real';
  if (real) {
    // Fail closed before any custody handoff when no human owns this terminal.
    requireInteractiveOperatorTerminal();
    requireRealSignBudget(signBudget, requestId);
  }
  const statePath = state ?? (real ? protectedCustodyStateRoot()
    : resolve(tmpdir(), `flop-tclk-fixture-state-${randomUUID()}`));
  const requestPath = resolve(tmpdir(), `flop-tclk-detached-request-${randomUUID()}.json`);
  const args = ['-m', 'technocore_agent.signer.real_detached_sign_bridge',
    '--request-file', requestPath, '--custody', custody, '--state', statePath];
  // Fixture-only interactive input provider. The canonical child refuses it for real custody, so
  // it can never become an approval bypass; real custody has no approval argument at all.
  if (!real) args.push('--approval-source', 'fixture', '--approval-response', approvalResponse ?? 'correct');
  try {
    const request = { ...detachedRequestFrame({ room, text, requestId }), profile, ...(expectedSignerDid ? { expectedSignerDid } : {}) };
    await writeFile(requestPath, JSON.stringify(request), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const { code, stdout, stderr } = await runBridgeProcess(canonicalPython(worktree), args, {
      cwd: worktree,
      env: { ...process.env, PYTHONPATH: 'src' },
      // Real: the operator's terminal owns stdin and the child's prompt output. Node captures the
      // machine response only. Fixture: no terminal exists, so stdio is fully captured.
      stdio: real ? ['inherit', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    if (code !== 0 || stderr) throw new Error('canonical bridge failed without exposing child output');
    const response = JSON.parse(stdout);
    if (response.error) throw new Error('canonical bridge refused request');
    if (response.canonicalCommit !== REVIEWED_CANONICAL_COMMIT) throw new Error('canonical bridge provenance mismatch');
    if (response.custodyMode !== custody) throw new Error('canonical bridge custody mode mismatch');
    return Object.freeze(response);
  } finally {
    await rm(requestPath, { force: true });
    if (!real) await rm(statePath, { force: true, recursive: true });
  }
}

/** Fixture custody through the identical production flow. */
export function invokeFixtureDetachedBridge(options = {}) {
  return invokeDetachedBridge({ ...options, custody: 'fixture' });
}

/** Real protected custody. Reachable only from the human entrypoint on an interactive terminal. */
export function invokeRealDetachedBridge(options = {}) {
  return invokeDetachedBridge({ ...options, custody: 'real' });
}


