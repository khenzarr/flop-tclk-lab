import test from 'node:test';
import assert from 'node:assert/strict';
import { gateA, SIGNING_MODES, REVIEWED_CANONICAL_COMMIT, AUDITED_NONCE_EVIDENCE_SHA } from '../airlock/budget.mjs';
import { invokeFixtureDetachedBridge, canonicalPython, CANONICAL_WORKTREE } from '../airlock/detached-bridge.mjs';
import { spawn } from 'node:child_process';

function runBridge(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(canonicalPython(CANONICAL_WORKTREE), ['-m', 'technocore_agent.signer.detached_bridge'], {
      cwd: CANONICAL_WORKTREE, env: { ...process.env, PYTHONPATH: 'src' }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(`${request}\n`);
  });
}

test('Gate A refuses legacy coupled operation and allows detached architecture only', () => {
  assert.equal(gateA({ mode: SIGNING_MODES.LEGACY_COUPLED_ROOM_OPERATION }).decision, 'REFUSE');
  const result = gateA({ mode: SIGNING_MODES.DETACHED_NETWORK_FREE_ROOM_OPERATION });
  assert.equal(result.decision, 'ALLOW_ARCHITECTURE');
  assert.equal(result.localNonceConsumed, true);
  assert.equal(result.networkCalls, 0);
});

test('fixture Node to Python bridge returns a locally verifiable operation without raw logging', async () => {
  const operation = await invokeFixtureDetachedBridge({ room: 'fixture-room', text: 'fixture detached text', requestId: 'phase3a7-fixture' });
  assert.equal(operation.room, 'fixture-room');
  assert.equal(operation.nonce, 1);
  assert.match(operation.did, /^did:key:z6Mk/);
  assert.equal(typeof operation.signature, 'string');
  assert.equal(operation.signature.length > 0, true);
  assert.equal(REVIEWED_CANONICAL_COMMIT.length, 40);
  assert.equal(AUDITED_NONCE_EVIDENCE_SHA.length, 40);
  assert.equal(JSON.stringify(operation).includes(operation.signature), true);
  assert.equal(operation.canonicalCommit, REVIEWED_CANONICAL_COMMIT);
});

test('captured bridge output is not emitted to parent console or evidence text', async () => {
  const operation = await invokeFixtureDetachedBridge({ room: 'fixture-leak-room', text: 'fixture leak test', requestId: 'phase3a7-leak' });
  const raw = JSON.stringify(operation);
  const captured = `${raw}\n`;
  const parentLog = 'fixture bridge completed';
  const evidence = JSON.stringify({ requestId: 'phase3a7-leak', status: 'POST_ELIGIBLE', posted: false });
  assert.equal(parentLog.includes(operation.signature), false);
  assert.equal(evidence.includes(operation.signature), false);
  assert.equal(captured.includes(operation.signature), true);
  assert.equal(JSON.stringify({ stdout: parentLog, evidence }).includes(operation.signature), false);
});

test('canonical bridge refuses an exact-commit mismatch before signing', async () => {
  const request = JSON.stringify({
    schema: 'technocore-detached-sign-request/v1', room: 'fixture-room', text: 'no sign',
    requestId: 'phase3a7-mismatch', expectedCanonicalCommit: '0'.repeat(40),
    noncePath: 'C:\\phase3a7-never-used.json',
  });
  const { stdout } = await runBridge(request);
  const response = JSON.parse(stdout);
  assert.match(response.error, /does not match reviewed request pin/);
});