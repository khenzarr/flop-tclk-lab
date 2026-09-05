// The only Blackbox-to-canonical signer boundary. stdout is always captured and never logged.
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

const execFileAsync = promisify(execFile);
const BLACKBOX_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CANONICAL_WORKTREE = resolve(BLACKBOX_ROOT, '..', '..', 'technocore-agent-canonical-human-execution', 'local-agent');

export function canonicalPython(worktree) {
  const candidates = process.platform === 'win32'
    ? [resolve(worktree, '.venv', 'Scripts', 'python.exe'), 'py.exe', 'python.exe']
    : [resolve(worktree, '.venv', 'bin', 'python'), 'python3', 'python'];
  const executable = candidates.find(candidate => candidate.includes('/') || candidate.includes('\\')
    ? existsSync(candidate) : true);
  if (!executable) throw new Error('REFUSE: canonical Python interpreter is unavailable');
  return executable;
}

function runCapturedBridge(python, args, { cwd, env }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
    child.stdin.end();
  });
}

export async function assertReviewedCanonicalWorktree(worktree = CANONICAL_WORKTREE) {
  const root = resolve(worktree, '..');
  const { stdout: commit } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true });
  const { stdout: status } = await execFileAsync('git', ['-C', root, 'status', '--porcelain', '--', 'local-agent/src/technocore_agent/signer', 'local-agent/src/technocore_agent/storage/nonce.py'], { windowsHide: true });
  if (commit.trim() !== REVIEWED_CANONICAL_COMMIT || status.trim() !== '') throw new Error('REFUSE: canonical signer commit or relevant tree is not reviewed and clean');
  return Object.freeze({ commit: commit.trim(), clean: true });
}

export async function invokeFixtureDetachedBridge({ room, text, requestId = randomUUID(), worktree = CANONICAL_WORKTREE } = {}) {
  await assertReviewedCanonicalWorktree(worktree);
  const noncePath = resolve(tmpdir(), `flop-tclk-fixture-nonce-${randomUUID()}.json`);
  const requestPath = resolve(tmpdir(), `flop-tclk-detached-request-${randomUUID()}.json`);
  const statePath = noncePath.replace('.json', '-state');
  const request = JSON.stringify({ schema: 'technocore-detached-sign-request/v2', room, text, requestId,
    expectedCanonicalCommit: REVIEWED_CANONICAL_COMMIT, purpose: 'DETACHED_ROOM_SIGNING' });
  try {
    await writeFile(requestPath, request, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const { code, stdout, stderr } = await runCapturedBridge(canonicalPython(worktree), ['-m', 'technocore_agent.signer.real_detached_sign_bridge', '--request-file', requestPath, '--custody', 'fixture', '--state', statePath], {
      cwd: worktree, env: { ...process.env, PYTHONPATH: 'src' },
    });
    if (code !== 0 || stderr) throw new Error('canonical bridge failed without exposing child output');
    const response = JSON.parse(stdout);
    if (response.error) throw new Error('canonical bridge refused request');
    if (response.canonicalCommit !== REVIEWED_CANONICAL_COMMIT) throw new Error('canonical bridge provenance mismatch');
    return Object.freeze(response);
  } finally {
    await rm(requestPath, { force: true });
    await rm(noncePath, { force: true });
    await rm(`${noncePath}.lock`, { force: true });
    await rm(statePath, { force: true, recursive: true });
  }
}