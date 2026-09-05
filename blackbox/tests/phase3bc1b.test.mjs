// PHASE 3B.C1b — VERIFIED DID B ENROLLMENT (CLOSURE ASSERTIONS).
//
// The enrollment itself was performed by the human operator in a normal terminal. Verification was
// performed read-only against public metadata by lab/identity-fingerprint.mjs. This suite pins the
// resulting claims so a later edit cannot widen them, and re-derives every fingerprint locally
// instead of trusting the operator-reported value.
//
// No custody read, no DPAPI, no enrollment, no signing, no nonce, no transport, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PROFILE_PARENT_DIRNAME, SIGNING_ARTIFACT_FILES, compareIdentities, profileStateRoot, sha256Hex,
} from '../../lab/identity-fingerprint.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const MANIFEST_PATH = resolve(REPO, 'evidence', 'phase3b-counterparty-identity.json');
const TRUST_DOC_PATH = resolve(REPO, 'docs', 'PHASE3B_COUNTERPARTY_IDENTITY.md');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const trustDoc = readFileSync(TRUST_DOC_PATH, 'utf8');
const trustProse = trustDoc.replace(/\s+/g, ' ');

const DID_A = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';
const DID_B = 'did:key:z6MkoetPhd5Aa1pKFCR2a8SinCWaL64U7ytcPP6zg5pnnDoW';
const FINGERPRINT_B = 'a177dcc27339c364b84844997ec1222ba928f7933d895c83736ec861cb98ee7e';
const PROFILE = 'phase3b-counterparty-b';

test('operator-reported DID B fingerprint is reproducible locally', () => {
  // The human-reported value is checked, never trusted: sha256 of the public did:key must match.
  assert.equal(sha256Hex(DID_B), FINGERPRINT_B);
  assert.equal(manifest.didB, DID_B);
  assert.equal(manifest.didBKeyFingerprint, FINGERPRINT_B);
  assert.equal(manifest.didBKeyFingerprintAlgorithm, 'sha256(did:key string)');
  assert.equal(manifest.didBExists, true);
  assert.equal(manifest.didBMatch, true);
  assert.equal(manifest.publicFingerprintMatch, true);
  assert.equal(manifest.realIdentityVerificationResult, 'PASS');
  assert.match(manifest.realIdentityVerificationTool, /^lab\/identity-fingerprint\.mjs /);
});

test('verification stayed on public metadata and opaque ciphertext', () => {
  assert.match(manifest.didBVerificationMethod, /public metadata only/);
  assert.match(manifest.didBVerificationMethod, /opaque sha256 of identity\.dpapi/);
  assert.equal(manifest.didBProtectedBlobDecrypted, false);
  assert.equal(manifest.didBPrivateKeyAccessed, false);
  assert.equal(manifest.didAPrivateKeyAccessed, false);
  assert.equal(manifest.didADecryptedForComparison, false);
  assert.equal(manifest.dpapiPlaintextRead, false);
  assert.equal(manifest.privateKeyBytesCompared, false);
  assert.match(manifest.didBProtectedBlobSha256, /^[0-9a-f]{64}$/);
});

test('DID B was enrolled by the human operator, never by Cline', () => {
  assert.equal(manifest.didBCreated, true);
  assert.equal(manifest.didBEnrolledByCline, false);
  assert.match(manifest.didBEnrolledBy, /HUMAN_OPERATOR/);
  assert.match(manifest.didBEnrolledBy, /POWERSHELL/i);
  assert.equal(manifest.didBEnrollmentEntrypoint,
    `technocore-agent-profile-init --profile ${PROFILE}`);
  assert.equal(manifest.didBProfile, PROFILE);
  assert.equal(manifest.credentialVisibleToCline, false);
  assert.equal(manifest.credentialVisibleToNode, false);
});

test('DID A and DID B are distinct on public material alone', () => {
  assert.notEqual(DID_A, DID_B);
  assert.notEqual(sha256Hex(DID_A), sha256Hex(DID_B));
  assert.equal(manifest.didAKeyFingerprint, sha256Hex(DID_A));
  assert.notEqual(manifest.didAKeyFingerprint, manifest.didBKeyFingerprint);
  assert.equal(manifest.distinctDid, true);
  assert.equal(manifest.distinctDidCheck, 'PASS');
  assert.equal(manifest.publicKeyFingerprintDistinct, 'PASS');
  // Distinctness must rest on the public DIDs, not on randomized ciphertext.
  assert.match(manifest.distinctnessBasis, /distinct public did:key values/);
  assert.match(manifest.distinctnessBasis, /public-key material/);
  assert.ok(manifest.limitations.some(line => /corroborate/.test(line)),
    'a limitation must state that ciphertext digests only corroborate');
  assert.notEqual(manifest.didAIdentityBlobSha256, manifest.didBProtectedBlobSha256);
});

test('DID A is recorded unchanged against the pre-enrollment digest', () => {
  assert.equal(manifest.didA, DID_A);
  assert.equal(manifest.didAUnchanged, true);
  assert.equal(manifest.didAIdentityBlobSha256MatchesPhase3bC1a, true);
  assert.equal(manifest.didAFilesUntouched, true);
  assert.match(manifest.didAIdentityBlobSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.didAUnchangedMethod, /randomized/);
  assert.ok(trustDoc.includes(manifest.didAIdentityBlobSha256.slice(0, 8)));
});

test('storage separation is contained, non-overlapping and nonce-free for DID B', () => {
  assert.equal(manifest.didACustodyNamespace, '%LOCALAPPDATA%\\TechnocoreAgent');
  assert.equal(manifest.didBCustodyNamespace,
    `%LOCALAPPDATA%\\TechnocoreAgent\\${PROFILE_PARENT_DIRNAME}\\${PROFILE}`);
  assert.ok(manifest.didBCustodyNamespace.startsWith(`${manifest.didACustodyNamespace}\\`));
  assert.notEqual(manifest.didBCustodyNamespace, manifest.didACustodyNamespace);
  assert.equal(manifest.storageSeparated, true);
  assert.equal(manifest.storageSeparationCheck, 'PASS');
  assert.equal(manifest.overlappingCustodyFiles, 0);
  assert.equal(manifest.separateNonceLedgers, true);
  assert.equal(manifest.didBNonceLedger, 'ABSENT');
  assert.equal(manifest.didBNonceReservationsFromEnrollment, 0);
  assert.deepEqual(manifest.didBSigningArtifacts, []);
  assert.equal(manifest.didBIdentityFileEntries.includes('identity.dpapi'), true);
  for (const artifact of SIGNING_ARTIFACT_FILES) {
    assert.equal(manifest.didBIdentityFileEntries.includes(artifact), false,
      `DID B must have no ${artifact}`);
  }
});

test('the profile namespace derivation matches the recorded namespace', () => {
  // Derived from a throwaway prefix; nothing under %LOCALAPPDATA% is read here.
  const root = profileStateRoot(PROFILE, resolve('/', 'fixture-localappdata', 'TechnocoreAgent'));
  assert.match(root, new RegExp(`${PROFILE_PARENT_DIRNAME}[\\\\/]${PROFILE}$`));
  // Traversal, separators, uppercase and sub-minimal names are all refused before any path use.
  for (const rejected of ['..', '../evil', 'a/b', 'a\\b', 'Phase3B', 'ab', '']) {
    assert.throws(() => profileStateRoot(rejected), /REFUSE/, `must refuse profile ${rejected}`);
  }
});

test('identity comparison helper refuses to call identical roots separated', () => {
  const shared = { root: resolve('/', 'fixture-same'), present: true, publicDid: DID_A };
  const verdict = compareIdentities(shared, shared);
  assert.equal(verdict.distinctDid, false);
  assert.equal(verdict.storageSeparated, false);
});

test('role binding is frozen without upgrading the trust claim', () => {
  assert.equal(manifest.roleA, 'offer.from / payer / lock / refund');
  assert.equal(manifest.roleB, 'accept.from / payee / reveal');
  assert.equal(manifest.roleAssignmentStatus, 'FROZEN_PROTOCOL_ROLE_BINDING');
  assert.equal(manifest.roleBindingFrozen, true);
  assert.equal(manifest.roleBindingProvesEconomicIndependence, false);
  assert.match(manifest.roleBasis, /accept\.from != offer\.from/);
  assert.match(trustProse, /ROLE_BINDING_FROZEN=YES/);
  assert.match(trustProse, /protocol role assignment/i);
});

test('no DID B signing proof is claimed or required', () => {
  assert.equal(manifest.didBSigningProofExists, false);
  assert.equal(manifest.didBOfflineSignatureRequired, false);
  assert.equal(manifest.realSignaturesDuringEnrollment, 0);
  assert.equal(manifest.realNoncesConsumedDuringEnrollment, 0);
  assert.match(trustProse, /DID_B_OFFLINE_SIGNATURE_REQUIRED=NO/);
  assert.match(trustProse, /signing\*{0,2} path is unproven/i);
});

test('the safety envelope stays at zero for this phase', () => {
  for (const key of ['technocoreReads', 'technocoreWrites', 'realSignatures', 'realNoncesConsumed',
    'transportCalls', 'networkCalls', 'submissionCalls', 'publicActions']) {
    assert.equal(manifest[key], 0, `${key} must be 0`);
  }
  assert.equal(manifest.privateKeyExported, false);
  assert.equal(manifest.privateKeyPrinted, false);
});

test('PaperRail stays an unsigned observation and untouched by enrollment', () => {
  assert.equal(manifest.paperRailClassification, 'UNSIGNED_RAIL_OBSERVATION');
  assert.equal(manifest.paperRailChangedThisPhase, false);
  assert.match(trustProse, /never\*{0,2} be used as proof of authorship/i);
});

test('trust doc records the verified state without overclaiming', () => {
  assert.match(trustProse, /ONE HUMAN OPERATOR — TWO DISTINCT CRYPTOGRAPHIC DIDS/);
  assert.match(trustProse, /DID B is enrolled and verified/i);
  assert.ok(trustDoc.includes(DID_B), 'trust doc must record the exact public DID B');
  assert.ok(trustDoc.includes(FINGERPRINT_B), 'trust doc must record the exact public fingerprint');
  assert.doesNotMatch(trustProse, /DID B does not exist/i);
  assert.doesNotMatch(trustProse, /independent counterpart(y|ies)\*{0,2} (is|are) (now )?proven/i);
  assert.equal(manifest.sameHumanOperator, true);
  assert.equal(manifest.independentHumanCounterparty, false);
  assert.match(trustProse, /not a counterparty fact/i);
});

test('phase closes and hands off to the Phase 3B.1 manifest freeze', () => {
  assert.equal(manifest.phase, '3B.C1b');
  assert.equal(manifest.phase3bC1Closed, true);
  assert.equal(manifest.readyForPhase3b1ManifestFreeze, true);
  assert.equal(manifest.humanActionRequired, false);
  assert.equal(manifest.finalStatus, 'TCLK_PHASE3BC1_COUNTERPARTY_VERIFIED');
  assert.match(manifest.nextRecommendedAction, /Phase 3B\.1/);
  assert.equal(manifest.blackboxBaselineCommit, 'a38b7bcadba3127b3ea0e6c5a5fe51d72303f7b4');
  assert.equal(manifest.canonicalCheckoutBranch, 'feat/reviewed-human-detached-execution');
  assert.ok(manifest.limitations.length >= 5);
  const limitations = manifest.limitations.join(' ');
  assert.match(limitations, /ONE human operator/);
  assert.match(limitations, /not FLOP eligibility/);
  assert.match(limitations, /not a live tamper guarantee/);
});
