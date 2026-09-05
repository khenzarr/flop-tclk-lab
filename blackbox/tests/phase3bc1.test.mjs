// PHASE 3B.C1 — COUNTERPARTY IDENTITY MANIFEST + SAFE FINGERPRINT TOOL.
//
// Pure metadata assertions over the committed manifest, plus fixture-only exercises of the
// fingerprint helper against throwaway directories under the OS temporary directory.
//
// No custody read, no DPAPI, no signing, no nonce, no transport, no network, no submission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareSnapshots, fingerprintRoot, sha256Hex, TRACKED_FILES } from '../../lab/identity-fingerprint.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const MANIFEST_PATH = resolve(REPO, 'evidence', 'phase3b-counterparty-identity.json');
const TRUST_DOC_PATH = resolve(REPO, 'docs', 'PHASE3B_COUNTERPARTY_IDENTITY.md');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const trustDoc = readFileSync(TRUST_DOC_PATH, 'utf8');
// Markdown hard-wraps prose, so phrase assertions run against a whitespace-collapsed view.
const trustProse = trustDoc.replace(/\s+/g, ' ');

const DID_A = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';

const ROOTS = [];
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tclk-phase3bc1-'));
  ROOTS.push(root);
  return root;
}
process.on('exit', () => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

test('manifest pins the reviewed baselines and phase', () => {
  assert.equal(manifest.schema, 'tclk-blackbox/phase3b-counterparty-identity/v1');
  assert.equal(manifest.phase, '3B.C1');
  assert.equal(manifest.canonicalCustodyCommit, '124d621dd8c68b04bed79744ab332e8305093d02');
  assert.equal(manifest.adoptedTclkCommit, 'd48e87343200e3115e243df39e8f295f5ce2e645');
  assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('DID A is recorded unchanged and its fingerprint is derived from public metadata', () => {
  assert.equal(manifest.didA, DID_A);
  assert.equal(manifest.didAKeyFingerprint, sha256Hex(DID_A));
  assert.equal(manifest.didAUnchanged, true);
  assert.equal(manifest.didAPrivateKeyAccessed, false);
  assert.equal(manifest.didACustodyNamespace, '%LOCALAPPDATA%\\TechnocoreAgent');
});

test('DID B is honestly recorded as not created', () => {
  assert.equal(manifest.didBCreated, false);
  assert.equal(manifest.didB, null);
  assert.equal(manifest.didBKeyFingerprint, null);
  assert.equal(manifest.didBCustodyNamespace, null);
  assert.equal(manifest.distinctDid, false);
  assert.equal(manifest.distinctDidCheck, 'NOT_APPLICABLE_DID_B_NOT_CREATED');
  assert.equal(manifest.finalStatus, 'TCLK_PHASE3BC1_HUMAN_ENROLLMENT_REQUIRED');
  assert.equal(manifest.humanActionRequired, true);
});

test('custody capability is separated from a reviewed production enrollment path', () => {
  assert.equal(manifest.multiIdentitySupported, 'YES_AT_CUSTODY_PRIMITIVE_LEVEL');
  assert.equal(manifest.identitySelectionModel, 'ROOT_SCOPED_INTERNAL_PRIMITIVE');
  assert.equal(manifest.productionMultiIdentityEnrollmentPath, 'NOT_REVIEWED');
  assert.equal(manifest.secondCustodyImplementationRequired, false);
  assert.equal(manifest.custodyIsolationProbe.result, 'PASS');
  assert.equal(manifest.custodyIsolationProbe.namespaceIsolated, true);
  assert.equal(manifest.custodyIsolationProbe.nonceLedgerCreated, false);
});

test('frozen roles are complementary and match the pinned TCLK guards', () => {
  assert.match(manifest.roleA, /offer\.from/);
  assert.match(manifest.roleA, /payer/);
  assert.match(manifest.roleB, /accept\.from/);
  assert.match(manifest.roleB, /payee/);
  assert.notEqual(manifest.roleA, manifest.roleB);
  // The payer locks and refunds; the payee reveals. Roles must not both carry a lock.
  assert.match(manifest.roleA, /lock/);
  assert.ok(!/lock/.test(manifest.roleB));
  assert.match(manifest.roleB, /reveal/);
  assert.ok(!/reveal/.test(manifest.roleA));
  assert.equal(manifest.roleAssignmentStatus, 'FROZEN_DESIGN_UNBOUND_IDENTITY');
});

test('trust model refuses to overclaim independence', () => {
  assert.equal(manifest.sameHumanOperator, true);
  assert.equal(manifest.independentHumanCounterparty, false);
  assert.ok(manifest.limitations.length >= 5);
  assert.ok(manifest.limitations.some(line => /ONE human operator/i.test(line)));
  assert.ok(manifest.limitations.some(line => /FLOP eligibility/i.test(line)));
});

test('all public-action and secret-exposure counters are zero or false', () => {
  for (const key of ['technocoreWrites', 'technocoreReads', 'realSignatures', 'realNoncesConsumed',
    'transportCalls', 'networkCalls', 'submissionCalls', 'publicActions']) {
    assert.equal(manifest[key], 0, `${key} must be 0`);
  }
  for (const key of ['privateKeyExported', 'privateKeyPrinted', 'credentialVisibleToCline',
    'credentialVisibleToNode']) {
    assert.equal(manifest[key], false, `${key} must be false`);
  }
});

test('manifest carries no secret-bearing fields', () => {
  // Keys that merely assert a secret was NOT handled are safe; keys that could carry one are not.
  const NEGATIVE_ASSERTIONS = new Set([
    'privateKeyExported', 'privateKeyPrinted', 'didAPrivateKeyAccessed',
    'credentialVisibleToCline', 'credentialVisibleToNode', 'realSignatures',
  ]);
  const secretish = /private_?key|passphrase|\bseeds?\b|plaintext|unprotected|keyBlob|signature|secret|credential/i;
  const strings = [];
  const walk = value => {
    if (typeof value === 'string') { strings.push(value); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(NEGATIVE_ASSERTIONS.has(key) || !secretish.test(key), `forbidden manifest key: ${key}`);
      walk(nested);
    }
  };
  walk(manifest);
  assert.equal(Object.hasOwn(manifest, 'signature'), false);

  // No value may carry key-shaped material. The only long token allowed is the public fingerprint.
  const allowedLongTokens = new Set([manifest.didAKeyFingerprint]);
  for (const value of strings) {
    for (const token of value.match(/[A-Za-z0-9+/=]{60,}/g) ?? []) {
      assert.ok(allowedLongTokens.has(token), `unexpected long token in manifest: ${token.slice(0, 12)}…`);
    }
  }
});

test('PaperRail notes stay classified as unsigned observations', () => {
  assert.equal(manifest.paperRailClassification, 'UNSIGNED_RAIL_OBSERVATION');
  assert.match(trustDoc, /UNSIGNED_RAIL_OBSERVATION/);
  assert.match(trustDoc, /WORLD[_ ]WRITABLE/i);
});

test('trust doc states the one-operator truth prominently', () => {
  const head = trustProse.slice(0, 1200);
  assert.match(head, /two distinct cryptographic DIDs/i);
  assert.match(head, /one human operator/i);
  assert.match(trustProse, /does NOT demonstrate\*{0,2} two independent humans/i);
  assert.match(trustProse, /FLOP eligibility/i);
});

test('fingerprint helper reports absent roots without inventing state', () => {
  const missing = resolve(freshRoot(), 'nope');
  const snapshot = fingerprintRoot(missing, 'ABSENT');
  assert.equal(snapshot.present, false);
  assert.equal(snapshot.publicDid, null);
  assert.deepEqual(snapshot.entries, []);
});

test('fingerprint helper detects any mutation of tracked custody files', () => {
  const root = freshRoot();
  const blob = join(root, 'identity.dpapi');
  writeFileSync(blob, Buffer.from('opaque-ciphertext-fixture'));
  writeFileSync(join(root, 'local-install.json'),
    JSON.stringify({ schema: 'technocore-local-install-v1', public_did: 'did:key:zFixtureAAA' }));
  writeFileSync(join(root, 'nonces.json'), '{}');

  const before = fingerprintRoot(root, 'FIXTURE');
  assert.equal(before.present, true);
  assert.equal(before.publicDid, 'did:key:zFixtureAAA');
  assert.equal(before.publicDidSha256, sha256Hex('did:key:zFixtureAAA'));
  assert.equal(before.files['operator.json'], null);
  assert.deepEqual(Object.keys(before.files).sort(), [...TRACKED_FILES].sort());

  const idle = compareSnapshots(before, fingerprintRoot(root, 'FIXTURE'));
  assert.equal(idle.unchanged, true);
  assert.deepEqual(idle.changedFiles, []);

  writeFileSync(blob, Buffer.from('rewritten-ciphertext-fixture'));
  const mutated = compareSnapshots(before, fingerprintRoot(root, 'FIXTURE'));
  assert.equal(mutated.unchanged, false);
  assert.ok(mutated.changedFiles.includes('identity.dpapi'));
  assert.equal(mutated.didStable, true);
});

test('fingerprint helper flags a rotated public DID', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'local-install.json'), JSON.stringify({ public_did: 'did:key:zOne' }));
  const before = fingerprintRoot(root);
  writeFileSync(join(root, 'local-install.json'), JSON.stringify({ public_did: 'did:key:zTwo' }));
  const verdict = compareSnapshots(before, fingerprintRoot(root));
  assert.equal(verdict.didStable, false);
  assert.equal(verdict.unchanged, false);
});

test('added sibling files do not falsely trip the unchanged check', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'identity.dpapi'), Buffer.from('fixture'));
  const before = fingerprintRoot(root);
  mkdirSync(join(root, 'unrelated'), { recursive: true });
  writeFileSync(join(root, 'unrelated', 'note.txt'), 'not custody state');
  const verdict = compareSnapshots(before, fingerprintRoot(root));
  assert.equal(verdict.unchanged, true);
});
