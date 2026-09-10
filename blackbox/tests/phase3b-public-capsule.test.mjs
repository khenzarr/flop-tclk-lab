import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PUBLIC_CAPSULE_PATH,
  PUBLIC_HASH_PATH,
  SOURCE_CAPSULE_PATH,
  SOURCE_MANIFEST_PATH,
  exportPublicCapsule,
} from '../export-public-phase3b-capsule.mjs';

const SOURCE_CAPSULE_SHA256 = '732248a29bd52ad11044e0c315e29fc98a1e9a127ea24d20e583736f38706dbd';
const SOURCE_MANIFEST_SHA256 = '9ab1e673604f747a152055f84aa8a59227ef8faf1326b2af44469ee5ce0414cb';
const MANIFEST_ROOT = '887eb9996c701260e5d78f1798b6577f62575db20a625bcaee7b12523d3ecd2f';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) for (const item of value) collectKeys(item, keys);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    keys.push(key); collectKeys(item, keys);
  }
  return keys;
}

test('final public capsule is deterministic, source-bound, complete and public-safe', async () => {
  const [sourceCapsuleBefore, sourceManifestBefore, trackedBytes, trackedHashFile] = await Promise.all([
    readFile(SOURCE_CAPSULE_PATH), readFile(SOURCE_MANIFEST_PATH), readFile(PUBLIC_CAPSULE_PATH), readFile(PUBLIC_HASH_PATH, 'utf8'),
  ]);
  assert.equal(sha256(sourceCapsuleBefore), SOURCE_CAPSULE_SHA256);
  assert.equal(sha256(sourceManifestBefore), SOURCE_MANIFEST_SHA256);

  const tempRoot = await mkdtemp(join(tmpdir(), 'tclk-public-capsule-'));
  try {
    const first = join(tempRoot, 'first'); const second = join(tempRoot, 'second');
    const options = directory => ({
      outputPath: join(directory, 'phase3b-final-public-capsule.json'),
      hashPath: join(directory, 'phase3b-final-public-capsule.sha256'),
      readmePath: join(directory, 'README.md'),
    });
    const firstResult = await exportPublicCapsule(options(first));
    const secondResult = await exportPublicCapsule(options(second));
    const [firstBytes, secondBytes, firstReadme, secondReadme] = await Promise.all([
      readFile(options(first).outputPath), readFile(options(second).outputPath),
      readFile(options(first).readmePath), readFile(options(second).readmePath),
    ]);
    assert.deepEqual(firstBytes, secondBytes);
    assert.deepEqual(firstReadme, secondReadme);
    assert.equal(firstResult.publicCapsuleSha256, secondResult.publicCapsuleSha256);
    assert.equal(firstResult.secretScan, 'PASS');
    assert.deepEqual(firstBytes, trackedBytes);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const publicCapsule = JSON.parse(trackedBytes.toString('utf8'));
  const localSource = JSON.parse(sourceCapsuleBefore.toString('utf8'));
  assert.equal(publicCapsule.deal.manifestRoot, MANIFEST_ROOT);
  assert.deepEqual(publicCapsule.summary, { flightRecordComplete: true, totalSteps: 6, verifiedSteps: 6, unresolvedSteps: 0 });
  assert.deepEqual(publicCapsule.flightRecord.map(item => item.step), ['OFFER', 'ACCEPT', 'LOCK', 'RAIL_LOCK', 'REVEAL', 'RAIL_CLAIM']);
  assert.deepEqual(publicCapsule.flightRecord.map(item => item.status), [
    'PUBLICLY_VERIFIED', 'PUBLICLY_VERIFIED', 'PUBLICLY_VERIFIED',
    'RECEIPT_AND_PUBLIC_OBSERVATION_VERIFIED', 'PUBLICLY_VERIFIED', 'RECEIPT_AND_PUBLIC_OBSERVATION_VERIFIED',
  ]);

  for (const index of [0, 1, 2, 4]) {
    const evidence = publicCapsule.flightRecord[index].evidence;
    const source = localSource.observations.find(item => item.operationId === publicCapsule.flightRecord[index].operationId);
    assert.deepEqual(evidence, {
      did: source.did, room: source.room, signedNonce: source.signedNonce,
      canonicalTextSha256: source.canonicalTextSha256, publicSeq: source.publicSeq,
      publicTimestamp: source.publicTimestamp, signatureSeen: source.signatureSeen,
      classification: source.classification, observationSource: source.observationSource,
    });
  }
  for (const index of [3, 5]) {
    const evidence = publicCapsule.flightRecord[index].evidence;
    assert.equal(evidence.signed, false); assert.equal(evidence.worldWritable, true);
    assert.equal(evidence.authorshipProof, 'NONE'); assert.equal(evidence.valueMoved, false);
    assert.equal(evidence.evidenceClass, 'UNSIGNED_RAIL_OBSERVATION');
    assert.equal(evidence.exactValueMatch, true); assert.equal(evidence.expectedValueSha256, evidence.observedValueSha256);
    assert.match(evidence.receiptSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(publicCapsule.trustModel.operatorModel, 'ONE_HUMAN_OPERATOR_TWO_DISTINCT_CRYPTOGRAPHIC_DIDS');
  assert.equal(publicCapsule.trustModel.sameHumanOperator, true);
  assert.equal(publicCapsule.trustModel.independentHumanCounterparty, false);
  assert.equal(publicCapsule.evidencePolicy.paperRail.isPaymentRail, false);
  assert.equal(publicCapsule.evidencePolicy.paperRail.provesHumanIdentity, false);
  assert.equal(publicCapsule.integrity.sourceProductionCapsuleSha256, SOURCE_CAPSULE_SHA256);
  assert.equal(publicCapsule.integrity.sourceManifestSha256, SOURCE_MANIFEST_SHA256);
  assert.equal(publicCapsule.integrity.manifestRoot, MANIFEST_ROOT);
  assert.equal(trackedHashFile, `${sha256(trackedBytes)}  phase3b-final-public-capsule.json\n`);

  const publicText = trackedBytes.toString('utf8');
  const forbiddenKeys = /^(?:sig|signature|secret|preimage|privateKey|private_key|seed|mnemonic|passphrase|dpapi|pendingPath|resultPath|evidencePath|observationPath|reconciliationPath|receiptPath)$/i;
  assert.equal(collectKeys(publicCapsule).some(key => forbiddenKeys.test(key)), false);
  assert.doesNotMatch(publicText, /(?:[A-Za-z]:\\\\|[A-Za-z]:\/(?!\/)|C:\\\\Users|C:\/Users|blackbox[\\/]state[\\/])/i);
  const localSecret = localSource.secret ?? localSource.preimage;
  if (typeof localSecret === 'string' && localSecret.length > 0) assert.doesNotMatch(publicText, new RegExp(localSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

  const [sourceCapsuleAfter, sourceManifestAfter] = await Promise.all([readFile(SOURCE_CAPSULE_PATH), readFile(SOURCE_MANIFEST_PATH)]);
  assert.deepEqual(sourceCapsuleAfter, sourceCapsuleBefore);
  assert.deepEqual(sourceManifestAfter, sourceManifestBefore);
});
