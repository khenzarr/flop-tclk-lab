// PHASE 3B.C1a — REVIEWED NAMED-PROFILE ENROLLMENT ENTRYPOINT (PROVENANCE ASSERTIONS).
//
// The entrypoint itself lives in canonical Python. Blackbox only records provenance and
// re-checks the documented profile allowlist and namespace containment arithmetic here, so a
// future edit cannot quietly widen either claim.
//
// No custody read, no DPAPI, no enrollment, no signing, no nonce, no transport, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { sha256Hex } from '../../lab/identity-fingerprint.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const MANIFEST_PATH = resolve(REPO, 'evidence', 'phase3bc1a-enrollment-entrypoint.json');
const RUNBOOK_PATH = resolve(REPO, 'docs', 'PHASE3BC1B_HUMAN_ENROLLMENT.md');
const C1_MANIFEST_PATH = resolve(REPO, 'evidence', 'phase3b-counterparty-identity.json');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const c1 = JSON.parse(readFileSync(C1_MANIFEST_PATH, 'utf8'));
const runbook = readFileSync(RUNBOOK_PATH, 'utf8');
const runbookProse = runbook.replace(/\s+/g, ' ');

const DID_A = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';
const OLD_CANONICAL = '124d621dd8c68b04bed79744ab332e8305093d02';
const NEW_CANONICAL = '3675aeacdb73656285c4253b6d6d8d937afe25d6';

// The allowlist is re-derived from the manifest text, so the manifest cannot drift from the rule
// this suite enforces.
const PATTERN_TEXT = manifest.profileValidation.match(/\^\S+\$/)?.[0];
const PROFILE_RE = new RegExp(PATTERN_TEXT ?? '$^');
const RESERVED = new Set(manifest.reservedProfileNames);
const accepted = (name) => PROFILE_RE.test(name) && !RESERVED.has(name);

test('manifest pins both canonical SHAs and the blackbox baseline', () => {
  assert.equal(manifest.schema, 'tclk-blackbox/phase3bc1a-enrollment-entrypoint/v1');
  assert.equal(manifest.phase, '3B.C1a');
  assert.equal(manifest.canonicalOldSha, OLD_CANONICAL);
  assert.equal(manifest.canonicalNewSha, NEW_CANONICAL);
  assert.notEqual(manifest.canonicalNewSha, manifest.canonicalOldSha);
  assert.match(manifest.canonicalNewSha, /^[0-9a-f]{40}$/);
  assert.equal(manifest.canonicalBranch, 'feat/named-local-identities');
  assert.equal(manifest.blackboxBaselineCommit, '71f2b1d7c7d221eb595d5c3bbe768e6354d889aa');
  // The reviewed Phase 3B.C1 baseline is the parent of this phase's canonical work.
  assert.equal(c1.canonicalSigningCommit, OLD_CANONICAL);
});

test('the default identity path and its root guard are recorded unchanged', () => {
  assert.equal(manifest.defaultIdentityPathChanged, false);
  assert.equal(manifest.defaultRootGuardChanged, false);
  assert.equal(manifest.defaultIdentityPath, '%LOCALAPPDATA%\\TechnocoreAgent');
  assert.equal(manifest.defaultIdentityPath, c1.didACustodyNamespace);
  for (const surface of ['service/local_init.py default root logic and single-root guard',
    'DPAPI storage format', 'private-key representation', 'signing preimage', 'SignedOperation',
    'NonceStore semantics', 'sign_room_detached', 'execute_room', 'Technocore transport',
    'submission behavior']) {
    assert.ok(manifest.canonicalUnchangedSurfaces.includes(surface), `missing unchanged surface: ${surface}`);
  }
  assert.equal(manifest.canonicalEnrollmentDiffReview, 'PASS');
  assert.equal(manifest.canonicalScopeReviewed.length, 3);
});

test('the entrypoint takes a profile name and nothing path-shaped', () => {
  assert.equal(manifest.namedProfileEntrypoint, 'technocore_agent.service.profile_init:main');
  assert.equal(manifest.consoleScript, 'technocore-agent-profile-init');
  assert.equal(manifest.profileArgument, '--profile <name>');
  assert.equal(manifest.arbitraryRootAllowed, false);
  assert.equal(manifest.pathTraversalAllowed, false);
  assert.equal(manifest.pathSuppliedByHuman, false);
  assert.equal(manifest.defaultRootCollision, 'REFUSED');
  assert.equal(manifest.profileRootContainment, 'PASS');
});

test('custody primitives are reused rather than reimplemented', () => {
  assert.equal(manifest.secondCustodyImplementation, false);
  assert.equal(manifest.existingDpapiProviderReused, true);
  assert.equal(manifest.initializeLocalIdentityReused, true);
  assert.equal(manifest.trustedPathsReused, true);
  assert.equal(manifest.canonicalDidReused, true);
  assert.equal(c1.secondCustodyImplementationRequired, false);
});

test('documented allowlist accepts only reviewed profile names', () => {
  assert.equal(PATTERN_TEXT, '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$');
  for (const good of ['phase3b-counterparty-b', 'abc', 'a-b_c9', '0a0', 'a'.repeat(64)]) {
    assert.equal(accepted(good), true, `should accept: ${good}`);
  }
  for (const bad of ['a'.repeat(65), 'ab', 'a', '-abc', 'abc-', '_abc', 'abc_']) {
    assert.equal(accepted(bad), false, `should reject: ${bad}`);
  }
});

test('allowlist rejects every Windows path edge case in the negative matrix', () => {
  const rejected = [
    '', ' ', '.', '..', '...', '../x', '..\\x', '../../x', '/x', '\\x', './x', '.\\x',
    'C:\\x', 'c:x', 'C:/x', '\\\\server\\share', '//server/share', '\\\\?\\C:\\x', 'file://x',
    '%LOCALAPPDATA%', '%TEMP%\\x', '$env:TEMP', '${HOME}', '~', 'a:b', 'a|b', 'a*b', 'a?b',
    'a"b', 'a<b', 'a>b', 'a;b', 'a b', ' phase3b', 'phase3b ', '\tphase3b', 'phase3b\n',
    'Phase3B', 'PHASE3B', 'phase3b.b', 'phase3b/counterparty', 'phase3b\\counterparty',
    'phase3b\u0000', 'phase3bé', 'phase\u200bb', 'phase3b:stream',
  ];
  for (const bad of rejected) assert.equal(accepted(bad), false, `should reject: ${JSON.stringify(bad)}`);
});

test('reserved names are refused even though their shape is legal', () => {
  for (const name of ['default', 'primary', 'identity', 'identities', 'technocoreagent',
    'con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
    assert.equal(PROFILE_RE.test(name), true, `shape should be legal: ${name}`);
    assert.equal(accepted(name), false, `reserved name must be refused: ${name}`);
    assert.ok(RESERVED.has(name), `denylist must contain: ${name}`);
  }
});

test('namespace derivation stays contained and can never reach the default root', () => {
  assert.equal(manifest.additionalIdentityParent, '%LOCALAPPDATA%\\TechnocoreAgent\\identities');
  assert.equal(manifest.additionalIdentityRoot, '%LOCALAPPDATA%\\TechnocoreAgent\\identities\\<profile>');
  assert.ok(manifest.additionalIdentityParent.startsWith(`${manifest.defaultIdentityPath}\\`));

  // Fixture arithmetic over a throwaway prefix: accepted names land one level below the parent,
  // and traversal candidates would escape it, which is exactly why they are rejected upstream.
  const localAppData = resolve(sep, 'fixture-localappdata');
  const defaultRoot = join(localAppData, 'TechnocoreAgent');
  const parent = join(defaultRoot, 'identities');
  for (const good of ['phase3b-counterparty-b', 'abc', 'a-b_c9']) {
    const root = resolve(parent, good);
    assert.ok(root.startsWith(parent + sep), `must stay inside the namespace: ${good}`);
    assert.equal(resolve(root, '..'), parent);
    assert.notEqual(root, defaultRoot);
    assert.notEqual(root, parent);
    assert.ok(!defaultRoot.startsWith(root + sep));
  }
  for (const traversal of ['..', '../..', '..\\..', '.']) {
    const escaped = resolve(parent, traversal);
    const contained = escaped.startsWith(parent + sep);
    assert.equal(contained, false, `traversal must not be normalized into the namespace: ${traversal}`);
    assert.equal(accepted(traversal), false);
  }
  assert.equal(resolve(parent, '..'), defaultRoot); // '..' would hit DID A: rejected by the allowlist.
});

test('existing profiles are reported, never overwritten or rotated', () => {
  assert.equal(manifest.existingProfileSemantics, 'ALREADY_ENROLLED');
  assert.equal(manifest.existingProfileOverwritten, false);
  assert.equal(manifest.existingProfileRotated, false);
  assert.equal(manifest.keyRotationFeature, 'OUT_OF_SCOPE');
});

test('real enrollment requires a human terminal with no bypass', () => {
  assert.equal(manifest.ttyRequired, true);
  assert.match(manifest.ttyCheck, /stdin\.isatty\(\) and stdout\.isatty\(\)/);
  assert.match(manifest.ttyCheck, /before any custody construction/);
  assert.equal(manifest.cliApprovalBypass, 'NONE');
  assert.equal(manifest.envApprovalBypass, 'NONE');
  assert.match(manifest.manualConfirmation, /^CREATE IDENTITY <CODE>/);
  assert.match(manifest.manualConfirmation, /non-secret/);
  assert.equal(manifest.confirmationIsAuthentication, false);
});

test('the credential never leaves the canonical process', () => {
  assert.equal(manifest.credentialVisibleToNode, false);
  assert.equal(manifest.credentialVisibleToCline, false);
  assert.equal(manifest.credentialInArgv, false);
  assert.equal(manifest.credentialInEnv, false);
  assert.match(manifest.credentialSource, /in-process prompt inside the canonical Python process/);
  assert.equal(manifest.clineRanRealEnrollment, false);
});

test('fixture E2E proves storage and DID separation without real enrollment', () => {
  assert.equal(manifest.multiIdentityEnrollmentFixtureE2E, 'PASS');
  assert.equal(manifest.fixtureDistinctDids, true);
  assert.equal(manifest.fixtureStorageSeparation, true);
  assert.equal(manifest.fixtureStorageOverlap, false);
  assert.match(manifest.fixtureRoots, /throwaway/i);
  assert.match(manifest.fixtureCredential, /fixture/i);
  assert.equal(manifest.realDidBCreated, false);
  // Phase 3B.C1a itself never enrolled DID B. The human operator did that afterwards, in a normal
  // terminal, using the reviewed entrypoint — which is what Phase 3B.C1b verified.
  assert.equal(c1.didBEnrolledByCline, false, 'DID B must never be recorded as enrolled by Cline');
  assert.match(c1.didBEnrolledBy, /HUMAN_OPERATOR/);
});

test('enrollment has no signing, nonce, transport or network side effect', () => {
  for (const field of ['signingCalls', 'nonceReservations', 'transportObjects', 'networkCalls',
    'submissionCalls', 'technocoreReads', 'technocoreWrites', 'publicActions']) {
    assert.equal(manifest[field], 0, `${field} must be 0`);
  }
  assert.equal(manifest.realSignaturePerformed, false);
  assert.equal(manifest.realNonceConsumed, false);
  assert.equal(manifest.nonceLedgerAfterFixtureEnrollment, 'ABSENT');
});

test('DID A is proved untouched from public metadata only', () => {
  assert.equal(manifest.didA, DID_A);
  assert.equal(manifest.didA, c1.didA);
  assert.equal(manifest.didAUnchanged, true);
  assert.equal(manifest.didAPrivateKeyAccessed, false);
  assert.equal(manifest.didADecryptedForComparison, false);
  assert.match(manifest.didAIdentityBlobSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.didAUnchangedMethod, /opaque identity\.dpapi ciphertext/);
  assert.match(manifest.didAUnchangedMethod, /randomized/);
});

test('only public results are published and no secret-shaped value appears', () => {
  assert.deepEqual(manifest.successOutputFields,
    ['PROFILE', 'PUBLIC DID', 'PUBLIC KEY FINGERPRINT', 'CUSTODY ROOT', 'ENROLLED']);
  assert.equal(manifest.privateKeyExported, false);
  assert.equal(manifest.privateKeyPrinted, false);

  const strings = [];
  const walk = (node) => {
    if (typeof node === 'string') strings.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(manifest);
  const allowedLongTokens = new Set([manifest.didAIdentityBlobSha256]);
  for (const value of strings) {
    assert.doesNotMatch(value, /BEGIN [A-Z ]*PRIVATE KEY/);
    assert.doesNotMatch(value, /passphrase\s*[:=]\s*\S/i);
    for (const token of value.match(/[A-Za-z0-9+/=]{60,}/g) ?? []) {
      assert.ok(allowedLongTokens.has(token), `unexpected long token: ${token.slice(0, 12)}…`);
    }
  }
  assert.equal(Object.hasOwn(manifest, 'signature'), false);
  assert.equal(Object.hasOwn(manifest, 'didB'), false, 'DID B must not be invented here');
});

test('runbook carries the four mandatory warnings prominently', () => {
  const head = runbook.slice(0, 700);
  assert.match(head, /DO NOT RUN THROUGH CLINE\./);
  assert.match(head, /NO SIGNATURE WILL BE CREATED\./);
  assert.match(head, /NO NONCE WILL BE RESERVED\./);
  assert.match(head, /NO TECHNOCORE NETWORK ACTIVITY WILL OCCUR\./);
});

test('runbook states the exact future command and pins the canonical commit', () => {
  assert.equal(manifest.humanEnrollmentRunbook, 'docs/PHASE3BC1B_HUMAN_ENROLLMENT.md');
  assert.equal(manifest.futureHumanCommand,
    'technocore-agent-profile-init --profile phase3b-counterparty-b');
  assert.equal(manifest.futureHumanCommandExecuted, false);
  assert.ok(runbook.includes(manifest.futureHumanCommand));
  assert.ok(runbook.includes('-m technocore_agent.service.profile_init --profile phase3b-counterparty-b'));
  assert.ok(runbook.includes(NEW_CANONICAL));
  assert.match(runbookProse, /normal PowerShell/);
  assert.match(runbookProse, /DID B does not exist\s*yet/i);
});

test('runbook never hardcodes a confirmation code and advertises no bypass flag', () => {
  const codes = runbook.match(/CREATE IDENTITY\s+(\S+)/g) ?? [];
  assert.ok(codes.length > 0);
  for (const phrase of codes) {
    assert.match(phrase, /CREATE IDENTITY\s+<CODE>/, `runbook must keep the code a placeholder: ${phrase}`);
  }
  assert.match(runbookProse, /read it from your own screen/i);
  // Bypass flags may only appear as documented refusals, never as usable options.
  for (const flag of ['--yes', '--force', '--non-interactive']) {
    const index = runbook.indexOf(flag);
    assert.notEqual(index, -1, `runbook should document the refusal of ${flag}`);
    assert.match(runbook.slice(Math.max(0, index - 260), index + 260), /NO —|Anything else|refus/i);
  }
});

test('runbook keeps the one-operator trust language and secret hygiene', () => {
  assert.match(runbookProse, /one human operator/i);
  assert.match(runbookProse, /not FLOP eligibility/i);
  assert.match(runbookProse, /Never paste the passphrase/i);
  assert.ok(runbook.includes('docs/PHASE3B_COUNTERPARTY_IDENTITY.md'));
  assert.equal(c1.sameHumanOperator, true);
  assert.equal(c1.independentHumanCounterparty, false);
});

test('phase verdict is honest about what is and is not proved', () => {
  assert.equal(manifest.readyForHumanDidBEnrollment, true);
  assert.equal(manifest.finalStatus, 'TCLK_PHASE3BC1A_ENROLLMENT_ENTRYPOINT_READY');
  assert.ok(manifest.limitations.length >= 5);
  const limitations = manifest.limitations.join(' ');
  assert.match(limitations, /DID B still does not exist/);
  assert.match(limitations, /ONE human operator/);
  assert.match(limitations, /authenticates nobody/);
  assert.match(manifest.nextRecommendedAction, /docs\/PHASE3BC1B_HUMAN_ENROLLMENT\.md/);
  // The fingerprint algorithm recorded in Phase 3B.C1 still holds for the public DID.
  assert.equal(c1.didAKeyFingerprint, sha256Hex(DID_A));
});
