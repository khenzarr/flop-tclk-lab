import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONNECTOR_HOST, PAIRING_TTL_MS, createConnector, createPairing } from '../hub/connector.mjs';
import { DealEngine, SimulatedExecutor } from '../hub/engine.mjs';
import { exactPublicMatch } from '../hub/real-executor.mjs';
import { PROFILES, createDealSession, listSessions, readSecret } from '../hub/session.mjs';

const origin = 'http://127.0.0.1:4173';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const referencePath = new URL('../../evidence/public/phase3b-final-public-capsule.json', import.meta.url);

test('connector is loopback-only, expiring, authenticated, origin-bound and public-safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-connector-')); const nowMs = Date.parse('2026-09-10T20:00:00.000Z');
  try {
    const pairing = await createPairing({ root, now: () => nowMs, random: size => Buffer.alloc(size, 7), port: 8799 });
    assert.equal(Date.parse(pairing.record.expiresAt) - Date.parse(pairing.record.createdAt), PAIRING_TTL_MS);
    assert.equal(Object.keys(pairing.record).some(key => /private|seed|passphrase|preimage|dealSecret/i.test(key)), false);
    const connector = await createConnector({ root, now: () => nowMs, origins: [origin], mode: 'simulated', port: 0 });
    const server = connector.createServer(); await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
    try {
      const address = server.address(); assert.equal(address.address, CONNECTOR_HOST);
      const base = `http://${CONNECTOR_HOST}:${address.port}`;
      const badOrigin = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } }); assert.equal(badOrigin.status, 403);
      const unauthenticated = await fetch(`${base}/profiles`, { headers: { origin } }); assert.equal(unauthenticated.status, 401);
      const headers = { origin, authorization: `Bearer ${connector.pairing.record.token}`, 'content-type': 'application/json' };
      const missingOrigin = await fetch(`${base}/session`, { headers: { authorization: `Bearer ${connector.pairing.record.token}` } }); assert.equal(missingOrigin.status, 403);
      assert.equal((await missingOrigin.json()).error, 'ORIGIN_REQUIRED');
      const connected = await fetch(`${base}/session`, { headers }); assert.equal((await connected.json()).status, 'CONNECTED');
      const created = await fetch(`${base}/deals`, { method: 'POST', headers, body: JSON.stringify({ amount: '12', asset: 'TEST' }) });
      assert.equal(created.status, 201); const deal = await created.json(); const publicText = JSON.stringify(deal);
      assert.equal(deal.operations.length, 6); assert.equal(deal.label, 'SIMULATED / LOCAL TEST');
      assert.doesNotMatch(publicText, /secret|preimage|privateKey|signature|blackbox[\\/]state/i);
      const arbitrary = await fetch(`${base}/deals/${deal.id}/actions/${deal.id}-write-9/execute`, { method: 'POST', headers, body: '{}' });
      assert.equal(arbitrary.status, 404);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retained public matching requires exact DID, nonce and canonical text hash', () => {
  const signed = { did: PROFILES[0].did, nonce: 9, room: 'tclk-deal-test', text: '{"exact":true}' };
  const exact = { did: signed.did, nonce: '9', room: signed.room, text: signed.text, sig: 'public-signature', seq: 41, ts: '2026-09-10T00:00:00.000Z' };
  assert.deepEqual(exactPublicMatch(signed, [exact]), { exactMatchCount: 1, publicSeq: 41, publicTimestamp: exact.ts, signatureSeen: true });
  assert.equal(exactPublicMatch(signed, [{ ...exact, did: PROFILES[1].did }, { ...exact, nonce: '10' }, { ...exact, text: '{"exact":false}' }]).exactMatchCount, 0);
});

test('generic isolated sessions preserve evidence gating, failures, recovery and finalization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-hub-')); const referenceBefore = await readFile(referencePath);
  let byte = 1; const random = size => Buffer.alloc(size, byte++);
  try {
    const first = await createDealSession({ amount: '9', asset: 'TEST', mode: 'simulated' }, { root, now: () => 1800000000000, random });
    const second = await createDealSession({ amount: '10', asset: 'TEST', mode: 'simulated' }, { root, now: () => 1800000001000, random });
    assert.notEqual(first.id, second.id); assert.notEqual(first.deal.contractId, second.deal.contractId);
    assert.notEqual(first.deal.dealCommitment, second.deal.dealCommitment);
    assert.notEqual(await readSecret(first.id, { root }), await readSecret(second.id, { root }));
    const listed = await listSessions({ root }); assert.equal(listed.length, 2);
    assert.doesNotMatch(JSON.stringify(listed), /secret|preimage|privateKey|signature/i);

    const executor = new SimulatedExecutor({ submitOutcomes: ['SUBMISSION_UNCERTAIN', 'ACK_RECEIVED'] });
    const engine = new DealEngine({ root, executor }); let session = await engine.inspect(first.id);
    const firstOp = session.operations[0]; await engine.prepare(first.id, firstOp.id); await engine.execute(first.id, firstOp.id);
    await engine.prepare(first.id, firstOp.id); session = await engine.execute(first.id, firstOp.id);
    assert.equal(session.operations[0].state, 'SUBMISSION_UNCERTAIN'); session = await engine.refresh(first.id, firstOp.id);
    assert.equal(session.operations[0].state, 'NOT_OBSERVED'); assert.equal(session.operations[0].recoveryAvailable, true);
    await engine.prepare(first.id, firstOp.id); await engine.execute(first.id, firstOp.id); session = await engine.refresh(first.id, firstOp.id);
    assert.equal(session.operations[0].state, 'VERIFIED'); assert.equal(session.operations[1].state, 'READY');

    for (const operation of session.operations.slice(1)) {
      if (operation.kind === 'signed') { await engine.prepare(first.id, operation.id); await engine.execute(first.id, operation.id); await engine.prepare(first.id, operation.id); await engine.execute(first.id, operation.id); }
      else { await engine.prepare(first.id, operation.id); await engine.execute(first.id, operation.id); }
      session = await engine.refresh(first.id, operation.id); assert.equal(session.operations[operation.ordinal - 1].state, 'VERIFIED');
    }
    session = await engine.finalize(first.id); assert.equal(session.finalized, true); assert.ok(session.operations.every(item => item.state === 'COMPLETE'));
    assert.equal(session.publicCapsule.simulated, true); assert.equal(session.publicCapsule.label, 'SIMULATED / LOCAL TEST');
    assert.doesNotMatch(JSON.stringify(session.publicCapsule), /secret|preimage|privateKey|signature|blackbox[\\/]state/i);
    await assert.rejects(() => engine.execute(first.id, `${first.id}-write-1`), /PREDECESSOR|PREPARE_REQUIRED|ACTION/);
  } finally { await rm(root, { recursive: true, force: true }); }
  const referenceAfter = await readFile(referencePath); assert.deepEqual(referenceAfter, referenceBefore);
  assert.equal(hash(referenceAfter), '8337b483c26bd4cb06c12b3a5e9523d595a0a2d023acd1923eebb263d03ccc02');
});

test('explicit rejection is terminal and never retried automatically', async () => {
  const executor = new SimulatedExecutor({ submitOutcomes: ['REJECTED'] });
  assert.deepEqual(await executor.execute({ operation: { id: 'x' }, action: 'SUBMIT' }), {
    classification: 'REJECTED', httpStatus: 400, diagnostic: 'Sanitized simulated rejection', simulated: true,
  });
});
