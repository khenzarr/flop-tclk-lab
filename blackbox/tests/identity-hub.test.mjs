import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TestVectorSigner } from '../airlock/signer.mjs';
import { CONNECTOR_HOST, createConnector } from '../hub/connector.mjs';
import { IDENTITY_PROVIDERS, IDENTITY_STATUSES, IdentityManager, verifyPublicSignature } from '../hub/identity.mjs';

const origin = 'http://127.0.0.1:4173';
const did = label => new TestVectorSigner(`identity-hub/${label}`).did;

async function install(root, publicDid, { key = true, operator = true } = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'local-install.json'), `${JSON.stringify({ schema: 'technocore-local-install-v1', public_did: publicDid })}\n`);
  if (key) await writeFile(join(root, 'identity.dpapi'), 'protected-test-fixture');
  if (operator) await writeFile(join(root, 'operator.json'), '{}');
}

test('discovery is explicit, stable, deduplicated and never exposes custody material', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'identity-hub-discovery-'));
  const hub = join(sandbox, 'hub'); const store = join(sandbox, 'TechnocoreAgent');
  try {
    const manager = new IdentityManager({ root: hub, identityRoot: store });
    assert.deepEqual(await manager.discover(), { status: IDENTITY_STATUSES.NO_IDENTITY, identityCount: 0, primaryDid: null, identities: [] });
    const stableDid = did('stable'); await install(store, stableDid);
    let state = await manager.discover();
    assert.equal(state.status, IDENTITY_STATUSES.IDENTITY_READY); assert.equal(state.primaryDid, stableDid);
    assert.equal(state.identities[0].provider, IDENTITY_PROVIDERS.EXISTING_TECHNOCORE);
    assert.equal(state.identities[0].signerAvailable, true);
    assert.doesNotMatch(JSON.stringify(state), /identity\.dpapi|operator\.json|protected-test-fixture|passphrase|private|seed|path/i);
    await install(join(store, 'identities', 'same-did'), stableDid);
    state = await manager.discover(); assert.equal(state.identityCount, 1); assert.equal(state.identities[0].providers.length, 2);
    assert.equal((await manager.discover()).primaryDid, stableDid);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test('multiple identities require visible primary selection and signer states do not trigger replacement', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'identity-hub-multiple-'));
  const hub = join(sandbox, 'hub'); const store = join(sandbox, 'TechnocoreAgent'); const first = did('first'); const second = did('second');
  try {
    await install(store, first, { operator: false });
    await install(join(store, 'identities', 'second'), second, { key: false });
    const manager = new IdentityManager({ root: hub, identityRoot: store });
    let state = await manager.discover(); assert.equal(state.status, IDENTITY_STATUSES.MULTIPLE_IDENTITIES_FOUND); assert.equal(state.primaryDid, null);
    assert.equal(state.identities.find(item => item.did === first).status, IDENTITY_STATUSES.IDENTITY_LOCKED);
    assert.equal(state.identities.find(item => item.did === second).status, IDENTITY_STATUSES.SIGNER_UNAVAILABLE);
    state = await manager.selectPrimary(second); assert.equal(state.primaryDid, second); assert.equal(state.status, IDENTITY_STATUSES.SIGNER_UNAVAILABLE);
    assert.equal(typeof manager.prepareCreation, 'undefined');
    assert.equal((await manager.discover()).identityCount, 2);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test('BLACKBOX exposes no native identity creation path', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'identity-hub-create-'));
  const hub = join(sandbox, 'hub'); const store = join(sandbox, 'TechnocoreAgent');
  try {
    const manager = new IdentityManager({ root: hub, identityRoot: store });
    assert.equal(typeof manager.prepareCreation, 'undefined'); assert.equal(typeof manager.executeCreation, 'undefined');
    const state = await manager.discover(); assert.equal(state.status, IDENTITY_STATUSES.NO_IDENTITY);
    assert.match(await readFile('.gitignore', 'utf8'), /blackbox\/state\//);
    assert.doesNotMatch(JSON.stringify(state), /protected-test-fixture|passphrase|private|seed/i);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test('identity connector routes stay authenticated and production origin support is preserved', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'identity-hub-connector-')); const store = join(sandbox, 'TechnocoreAgent');
  try {
    await install(store, did('connector'));
    const identityManager = new IdentityManager({ root: sandbox, identityRoot: store });
    const connector = await createConnector({ root: sandbox, port: 0, origins: [origin, 'https://tclk-blackbox.vercel.app'], mode: 'simulated', identityManager });
    const server = connector.createServer(); await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
    try {
      const base = `http://${CONNECTOR_HOST}:${server.address().port}`;
      assert.equal((await fetch(`${base}/identity`, { headers: { origin } })).status, 401);
      const response = await fetch(`${base}/identity`, { headers: { origin: 'https://tclk-blackbox.vercel.app', authorization: `Bearer ${connector.pairing.record.token}` } });
      assert.equal(response.status, 200); const state = await response.json(); assert.equal(state.identityCount, 1);
      assert.doesNotMatch(JSON.stringify(state), /identity\.dpapi|passphrase|private|seed|pairing|token/i);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test('public signature verification is canonical, local and scoped to key control', () => {
  const signer = new TestVectorSigner('identity-hub/verification'); const message = '{"public":true}';
  const signed = signer.signApprovedChallenge({ requestId: 'verify-1', canonicalPayload: message,
    canonicalHash: createHash('sha256').update(message).digest('hex'), signerDid: signer.did, room: 'identity-hub-test' });
  assert.equal(verifyPublicSignature({ did: signer.did, room: signed.room, nonce: String(signed.nonce), message, signature: signed.signature }), true);
  assert.equal(verifyPublicSignature({ did: signer.did, room: signed.room, nonce: String(signed.nonce), message: '{"public":false}', signature: signed.signature }), false);
});
