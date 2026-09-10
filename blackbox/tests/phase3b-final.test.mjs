import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import s2 from '../../evidence/phase3b-s2-exact-manifest.json' with { type: 'json' };
import finalManifest from '../../evidence/phase3b-final-exact-manifest.json' with { type: 'json' };
import reconciliation from '../../evidence/phase3b-s2-venue-reconciliation.json' with { type: 'json' };
import { FINAL_LINEAGE, FINAL_MANIFEST, FINAL_ORDER, FINAL_ROOTS, FINAL_VENUE_ORIGIN,
  executionUrl, executionVenue, exactRoomMatch, signPreflight } from '../phase3b-s2.mjs';

const RAILWAY = 'https://technocore-chat-production.up.railway.app';

test('final manifest is fresh, isolated, Railway-bound and inert', async () => {
  assert.equal(FINAL_LINEAGE, 'phase3b-final');
  assert.equal(FINAL_MANIFEST.manifestRoot, finalManifest.manifestRoot);
  assert.equal(finalManifest.venueOrigin, RAILWAY);
  assert.equal(finalManifest.supersedesManifestRoot, s2.manifestRoot);
  assert.notEqual(finalManifest.manifestRoot, s2.manifestRoot);
  assert.notEqual(finalManifest.fixtureReplay.dealRoom, s2.fixtureReplay.dealRoom);
  assert.deepEqual(finalManifest.publicOrder, FINAL_ORDER);
  assert.equal(finalManifest.safety.realSignaturePerformed, false);
  assert.equal(finalManifest.safety.realNonceConsumed, false);
  assert.equal(finalManifest.safety.submissionCalls, 0);
  assert.equal(finalManifest.safety.paperRailWrites, 0);
  assert.ok(Object.values(FINAL_ROOTS).every(path => path.includes('phase3b-final')));
  assert.equal(existsSync(FINAL_ROOTS.pending), false);
  assert.equal(existsSync(FINAL_ROOTS.submit), false);
  assert.equal(existsSync(FINAL_ROOTS.rail), false);
  const preflight = await signPreflight('phase3b-final-write-1');
  assert.equal(preflight.venueOrigin, RAILWAY);
  assert.equal(preflight.realSignatures, 0);
  assert.equal(preflight.realNoncesAllocated, 0);
});

test('all final execution URLs resolve only against manifest-bound Railway origin', () => {
  assert.equal(FINAL_VENUE_ORIGIN, RAILWAY);
  for (const id of FINAL_ORDER) {
    assert.equal(executionVenue(id), finalManifest.venueOrigin);
    assert.equal(executionUrl(id, '/r/example/export'), `${RAILWAY}/r/example/export`);
    assert.equal(executionUrl(id, '/kv/ns/key'), `${RAILWAY}/kv/ns/key`);
  }
  const files = ['../../evidence/phase3b-final-exact-manifest.json', '../../evidence/phase3b-final-execution-preview.json',
    '../../docs/PHASE3B_FINAL_EXECUTION.md', '../phase3b-final-cli.mjs'];
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /https:\/\/technocore\.chat/);
});

test('final PaperRail commitments and note are fresh and distinct', () => {
  const [lock, claim] = finalManifest.frameSet.paperRailWrites;
  assert.deepEqual(lock.note, claim.note);
  assert.notDeepEqual(lock.note, s2.frameSet.paperRailWrites[0].note);
  assert.notEqual(lock.valueCommitment, claim.valueCommitment);
  assert.equal(createHash('sha256').update(JSON.stringify({ ...finalManifest, manifestRoot: undefined })).digest('hex'), finalManifest.manifestRoot);
});

test('retained observer still matches from + nonce + canonical text hash', () => {
  const signed = { did: 'did:key:test', nonce: 9, text: 'canonical', room: 'room' };
  const match = exactRoomMatch(signed, [{ from: signed.did, nonce: 9, text: signed.text, sig: 'present', seq: 4, ts: 'now' }]);
  assert.equal(match.match, true); assert.equal(match.signatureSeen, true);
});

test('S2 venue-cap failure is additive provenance, not success', () => {
  assert.equal(reconciliation.lineageId, 'phase3b-s2');
  assert.equal(reconciliation.authoritativeOutcome['phase3b-s2-write-3'], 'REJECTED_HTTP400');
  assert.equal(reconciliation.write3ResponseBodySha256, '405e570a1b50152d8a53283025050b60c4b9af6bf8b6008947082b9a39151a9c');
  assert.equal(reconciliation.historicalRawEvidencePreserved, true);
  assert.equal(reconciliation.successful, false);
});

test('final preimage remains only in ignored local state', () => {
  const local = JSON.parse(readFileSync(FINAL_ROOTS.secret, 'utf8'));
  assert.match(local.secret, /^0x[0-9a-f]{64}$/);
  for (const file of ['../../evidence/phase3b-final-exact-manifest.json', '../../evidence/phase3b-final-execution-preview.json',
    '../../docs/PHASE3B_FINAL_EXECUTION.md']) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), new RegExp(local.secret.slice(2), 'i'));
});
