// PHASE 3B.1 — FREEZE GATE + PROVENANCE ROLE ASSERTIONS.
//
// Phase 3B.1 asked for a byte-exact manifest freeze and did not produce one: the artifact the lab
// executes is not a build of the adopted TCLK pin. This suite pins that outcome so it cannot be
// quietly stepped over, and pins the Part 17 provenance correction so the signing and enrollment
// commits cannot be conflated again.
//
// No custody, no DPAPI, no signing, no nonce, no transport, no network. The pin-build probe is
// read-only static text analysis and never imports the artifact under question.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { probePinBuildIntegrity, freezeAllowed } from '../../lab/pin-build-integrity.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const at = (...parts) => resolve(REPO, ...parts);
const json = (...parts) => JSON.parse(readFileSync(at(...parts), 'utf8'));

const FINDING = json('evidence', 'phase3b1-pin-build-integrity.json');
const IDENTITY = json('evidence', 'phase3b-counterparty-identity.json');
const BLOCKER_DOC = readFileSync(at('docs', 'PHASE3B1_PIN_BUILD_BLOCKER.md'), 'utf8');

const PIN = 'd48e87343200e3115e243df39e8f295f5ce2e645';
const SIGNING_SHA = '124d621dd8c68b04bed79744ab332e8305093d02';
const ENROLLMENT_SHA = '3675aeacdb73656285c4253b6d6d8d937afe25d6';

// ---------------------------------------------------------------- Part 17: provenance roles

test('canonical signing and enrollment commits are distinct provenance roles', () => {
  // The Phase 3B.C1b report text collapsed these onto one SHA. They are different commits with
  // different meanings: one is the reviewed signing baseline, the other added named-profile
  // enrollment. Conflating them misattributes what has actually been reviewed.
  assert.notEqual(SIGNING_SHA, ENROLLMENT_SHA);

  for (const record of [FINDING, IDENTITY]) {
    assert.equal(record.canonicalSigningCommit, SIGNING_SHA);
    assert.equal(record.canonicalEnrollmentCommit, ENROLLMENT_SHA);
    assert.notEqual(record.canonicalEnrollmentCommit, record.canonicalSigningCommit);
  }
});

test('no artifact reintroduces the conflation under an enrollment-role key', () => {
  // Guards the specific defect shape: the signing SHA appearing in an enrollment-named field.
  const enrollmentKey = /enrollment/i;
  for (const record of [FINDING, IDENTITY]) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && enrollmentKey.test(key)) {
        assert.notEqual(value, SIGNING_SHA, `${key} must not carry the signing SHA`);
      }
    }
  }
  assert.equal(FINDING.provenanceCorrection.correctSigningCommit, SIGNING_SHA);
  assert.equal(FINDING.provenanceCorrection.correctEnrollmentCommit, ENROLLMENT_SHA);
  assert.equal(FINDING.provenanceCorrection.historicalCommitsRewritten, false);
});

// ---------------------------------------------------------------- pinned-source reconfirmation

test('pinned-source protocol reconfirmation matches Phase 3B.0', () => {
  const part1 = FINDING.part1Reconfirmation;
  assert.deepEqual(part1.frameSet, [
    'offer', 'accept', 'lock', 'reveal', 'refund', 'cancel', 'receipt', 'heartbeat',
  ]);
  assert.equal(part1.separateClaimFrame, false);
  assert.deepEqual(part1.minimalStateChangingSequence, ['offer', 'accept', 'lock', 'reveal']);
  assert.equal(part1.pinnedSequenceReconfirmed, true);
  // It must be recorded as read from the pinned sources, not from docs and not from dist/.
  assert.match(part1.readFrom, /pinned sources/);
  assert.match(part1.readFrom, /not from the built artifact/);
});

// ---------------------------------------------------------------- the freeze gate itself

test('pin-build probe still reports the executed artifact is not the pin', () => {
  // If a human rebuilds .upstream/tclk from the pin, this test is expected to fail and the
  // recorded finding must be revisited deliberately rather than drifting out of date.
  const report = probePinBuildIntegrity();
  assert.equal(report.pin, PIN);
  assert.equal(report.cloneOnPin, true, 'clone must still be on the adopted pin');
  assert.equal(report.distIsABuildOfThePin, false);
  assert.equal(report.verdict, 'STALE_BUILD__EXECUTED_PROTOCOL_IS_NOT_THE_PIN');
  assert.equal(freezeAllowed(report), false);
  assert.equal(report.verdict, FINDING.finding.verdict);
});

test('probe reproduces the recorded deltas', () => {
  const report = probePinBuildIntegrity();
  const recorded = FINDING.probeObservations;
  assert.equal(report.machineCasesMatch, false);
  assert.deepEqual(report.pinnedSourceMachineCases, recorded.pinnedSourceMachineCases);
  assert.deepEqual(report.builtArtifactMachineCases, recorded.builtArtifactMachineCases);
  assert.deepEqual(report.modulesMissingFromBuiltArtifact, recorded.modulesMissingFromBuiltArtifact);
  assert.equal(report.frameFieldDeltaCount, recorded.frameFieldDeltaCount);
  // heartbeat is dispatched at the pin and absent from the executed artifact.
  assert.ok(report.pinnedSourceMachineCases.includes('heartbeat'));
  assert.ok(!report.builtArtifactMachineCases.includes('heartbeat'));
  assert.equal(report.pinnedSourceExportsMakeHeartbeat, true);
  assert.equal(report.builtArtifactExportsMakeHeartbeat, false);
});

test('the probe is read-only and does not import the artifact under question', () => {
  const source = readFileSync(at('lab', 'pin-build-integrity.mjs'), 'utf8');
  for (const forbidden of [/writeFileSync/, /\bmkdir/, /rmSync/, /child_process/, /\bimport\(/]) {
    assert.ok(!forbidden.test(source), `probe must not use ${forbidden}`);
  }
  assert.ok(!/\.upstream\/tclk\/dist\/index\.js['"]/.test(source));
});

// ---------------------------------------------------------------- no fabricated freeze

test('no frozen manifest artifact was produced while the gate is failing', () => {
  // The whole point of the halt: these must not exist until the pin is actually executable.
  assert.ok(!existsSync(at('evidence', 'phase3b-exact-manifest.json')));
  assert.ok(!existsSync(at('docs', 'PHASE3B_EXACT_MANIFEST.md')));
});

test('the finding claims no canonical hash, template hash, manifest root or execution id', () => {
  const serialised = JSON.stringify(FINDING);
  for (const key of ['manifestRoot', 'canonicalFrameHash', 'templateHash', 'executionId']) {
    assert.ok(!new RegExp(`"${key}"\\s*:`).test(serialised), `${key} must not be minted here`);
  }
  assert.equal(FINDING.outcome, 'FREEZE_GATE_FAILED_BEFORE_ANY_MANIFEST_WAS_FROZEN');
  assert.equal(FINDING.finalStatus, 'BLOCKED');
  assert.equal(FINDING.blockReason, 'PIN_BUILD_PROVENANCE');
  assert.equal(FINDING.readyForPhase3b2Prep, false);
  assert.equal(FINDING.readyForFirstPublicWrite, false);
});

test('DID B signing route is not upgraded and is marked as not re-audited', () => {
  assert.equal(FINDING.didBSigningRoute.classification, 'ENROLLED_BUT_SIGNING_ROUTE_UNPROVEN');
  assert.equal(FINDING.didBSigningRoute.reAuditedInPhase3b1, false);
  assert.equal(IDENTITY.didBSigningProofExists, false);
});

// ---------------------------------------------------------------- phase safety invariants

test('phase safety counters are all zero', () => {
  const s = FINDING.safety;
  assert.equal(s.realCanonicalKeyAccessed, false);
  assert.equal(s.realSignaturePerformed, false);
  assert.equal(s.realNonceConsumed, false);
  assert.equal(s.transportObjects, 0);
  assert.equal(s.networkCalls, 0);
  assert.equal(s.submissionCalls, 0);
  assert.equal(s.liveTechnocoreReads, 'NONE');
  assert.equal(s.liveTechnocoreWrites, 'NONE');
  assert.equal(s.publicActions, 0);
  assert.equal(s.posted, false);
  assert.equal(s.valueMoved, false);
  assert.equal(s.budgetsAcquired, 0);
  assert.equal(s.upstreamCloneModified, false);
  assert.equal(s.canonicalReposModified, false);
  assert.equal(s.phase3aArtifactReuse, false);
});

test('no secret-bearing material appears in the finding', () => {
  const serialised = JSON.stringify(FINDING).toLowerCase();
  for (const banned of ['passphrase', 'private key', 'dpapi material', 'signature":', 'secret":']) {
    assert.ok(!serialised.includes(banned), `finding must not carry ${banned}`);
  }
});

// ---------------------------------------------------------------- human-review document

test('blocker doc states the halt, the reason and the remediation order', () => {
  const prose = BLOCKER_DOC.replace(/\s+/g, ' ');
  assert.match(prose, /FINAL_STATUS = BLOCKED/);
  assert.match(prose, /PIN_BUILD_PROVENANCE/);
  assert.match(prose, /Not `TCLK_PHASE3B1_PROTOCOL_MISMATCH`/);
  assert.match(prose, /no frozen manifest was written/);
  assert.match(prose, /READY_FOR_FIRST_PUBLIC_WRITE=NO/);
  assert.match(prose, /READY_FOR_PHASE3B2_PREP=NO/);
  // Both provenance roles must be spelled out in the human-facing document.
  assert.ok(prose.includes(SIGNING_SHA));
  assert.ok(prose.includes(ENROLLMENT_SHA));
});
