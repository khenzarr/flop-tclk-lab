import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import oldManifest from '../../evidence/phase3b-exact-manifest.json' with { type: 'json' };
import manifest from '../../evidence/phase3b-s2-exact-manifest.json' with { type: 'json' };
import supersession from '../../evidence/phase3b-supersession.json' with { type: 'json' };
import { LINEAGE, ORDER, ROOTS, MANIFEST, MAX_HTTP_POST_ATTEMPTS, AUTOMATIC_RETRY } from '../phase3b-s2.mjs';

const OLD_ROOT = 'd452f8fcc877f9bb5ba199c20a0d96d3b220075be48d3ffd8aa625bb10ece694';
const OLD_ROOM = 'mb-p-tclk-62b08bcfe4331e3a';

test('s2 manifest is fresh, isolated, unsigned and supersedes immutable history', () => {
  assert.equal(oldManifest.manifestRoot, OLD_ROOT);
  assert.equal(manifest.supersedesManifestRoot, OLD_ROOT);
  assert.notEqual(manifest.manifestRoot, OLD_ROOT);
  assert.notEqual(manifest.fixtureReplay.dealRoom, OLD_ROOM);
  assert.equal(LINEAGE, 'phase3b-s2');
  assert.deepEqual(manifest.publicOrder, ORDER);
  assert.equal(MANIFEST.manifestRoot, manifest.manifestRoot);
  assert.equal(manifest.safety.realSignaturePerformed, false);
  assert.equal(manifest.safety.realNonceConsumed, false);
  assert.equal(manifest.safety.submissionCalls, 0);
  assert.equal(manifest.safety.paperRailWrites, 0);
  assert.equal(manifest.partyModel.sameHumanOperator, true);
  assert.equal(manifest.partyModel.independentHumanCounterparty, false);
  assert.match(ROOTS.pending, /phase3b-s2[\\/]pending-signed$/);
  assert.match(ROOTS.submit, /phase3b-s2[\\/]submit$/);
  assert.match(ROOTS.rail, /phase3b-s2[\\/]paper-rail$/);
  assert.match(ROOTS.budget, /phase3b-s2[\\/]attempt-budget$/);
  const root = createHash('sha256').update(JSON.stringify({ ...manifest, manifestRoot: undefined })).digest('hex');
  assert.equal(root, manifest.manifestRoot);
});

test('s2 PaperRail lock and claim commitments are distinct and canonical', () => {
  const [lock, claim] = manifest.frameSet.paperRailWrites;
  assert.equal(lock.operationId, 'phase3b-s2-write-5');
  assert.equal(claim.operationId, 'phase3b-s2-write-6');
  assert.deepEqual(lock.note, claim.note);
  assert.notDeepEqual(lock.note, oldManifest.frameSet.paperRailWrites[0].note);
  assert.notEqual(lock.valueCommitment, claim.valueCommitment);
});

test('s2 cannot inherit historical success or spent budgets', () => {
  assert.equal(supersession.classification, 'SUPERSEDED_EXECUTION_LINEAGE');
  assert.equal(supersession.historicalOutcome, 'NOT_SUCCESSFUL');
  assert.equal(supersession.reason, 'WRITE3_PRODUCTION_REJECTION_ROOT_CAUSE_UNAVAILABLE');
  assert.ok(Object.values(ROOTS).every(path => !path.includes('phase3b-submit\\') && !path.includes('phase3b-paper-rail\\')));
  assert.equal(MAX_HTTP_POST_ATTEMPTS, 1);
  assert.equal(AUTOMATIC_RETRY, 'NO');
});

test('human sequence contains only s2 operation selectors and immediate observations', () => {
  const text = readFileSync(new URL('../../docs/PHASE3B_S2_EXECUTION.md', import.meta.url), 'utf8');
  const selectors = [...text.matchAll(/--operation\s+(\S+)/g)].map(match => match[1]);
  assert.ok(selectors.length > 0);
  assert.ok(selectors.every(id => /^phase3b-s2-write-[1-6]$/.test(id)));
  assert.deepEqual(selectors, [
    'phase3b-s2-write-1', 'phase3b-s2-write-1', 'phase3b-s2-write-1',
    'phase3b-s2-write-2', 'phase3b-s2-write-2', 'phase3b-s2-write-2',
    'phase3b-s2-write-3', 'phase3b-s2-write-3', 'phase3b-s2-write-3',
    'phase3b-s2-write-5', 'phase3b-s2-write-5', 'phase3b-s2-write-5',
    'phase3b-s2-write-4', 'phase3b-s2-write-4', 'phase3b-s2-write-4',
    'phase3b-s2-write-6', 'phase3b-s2-write-6', 'phase3b-s2-write-6',
  ]);
});

test('fresh preimage remains only in ignored local state', () => {
  const local = JSON.parse(readFileSync(ROOTS.secret, 'utf8'));
  assert.match(local.secret, /^0x[0-9a-f]{64}$/);
  for (const path of ['../../evidence/phase3b-s2-exact-manifest.json', '../../evidence/phase3b-s2-execution-preview.json', '../../evidence/phase3b-supersession.json', '../../docs/PHASE3B_S2_EXECUTION.md']) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), new RegExp(local.secret.slice(2), 'i'));
  }
});
