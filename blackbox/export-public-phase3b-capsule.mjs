// SPDX-License-Identifier: Apache-2.0
// Deterministic, public-safe projection of the authoritative final Phase 3B evidence.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_CAPSULE_PATH = resolve('evidence/local-phase3b-final-production-capsule.json');
export const SOURCE_MANIFEST_PATH = resolve('evidence/phase3b-final-exact-manifest.json');
export const PUBLIC_CAPSULE_PATH = resolve('evidence/public/phase3b-final-public-capsule.json');
export const PUBLIC_HASH_PATH = resolve('evidence/public/phase3b-final-public-capsule.sha256');
export const PUBLIC_README_PATH = resolve('evidence/public/README.md');
const EXPECTED_ROOT = '887eb9996c701260e5d78f1798b6577f62575db20a625bcaee7b12523d3ecd2f';
const ORDER = Object.freeze(['phase3b-final-write-1', 'phase3b-final-write-2', 'phase3b-final-write-3', 'phase3b-final-write-5', 'phase3b-final-write-4', 'phase3b-final-write-6']);
const STEPS = Object.freeze(['OFFER', 'ACCEPT', 'LOCK', 'RAIL_LOCK', 'REVEAL', 'RAIL_CLAIM']);
const LABELS = Object.freeze(['Offer', 'Accept', 'Lock', 'PaperRail lock', 'Reveal', 'PaperRail claim']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function requireSources(capsule, manifest) {
  if (capsule.schema !== 'tclk/phase3b-production-evidence-capsule/v1' || capsule.production !== true
    || capsule.lineageId !== 'phase3b-final' || manifest.lineageId !== 'phase3b-final'
    || capsule.manifestRoot !== EXPECTED_ROOT || manifest.manifestRoot !== EXPECTED_ROOT
    || capsule.manifestRoot !== manifest.manifestRoot || capsule.venueOrigin !== manifest.venueOrigin
    || capsule.acceptance !== 'PHASE3B_FINAL_PUBLIC_TRANSCRIPT_COMPLETE'
    || capsule.PUBLIC_TRANSCRIPT_EVIDENCE_COMPLETE !== 'YES' || capsule.CURRENT_PUBLIC_RETENTION_COMPLETE !== 'YES'
    || capsule.RETENTION_GAP_COUNT !== 0 || JSON.stringify(capsule.order) !== JSON.stringify(ORDER)
    || JSON.stringify(manifest.publicOrder) !== JSON.stringify(ORDER) || capsule.observations?.length !== 6) {
    throw new Error('PUBLIC_EXPORT_SOURCE_BINDING_REFUSED');
  }
}

function signedEvidence(observation) {
  if (observation.production !== true || observation.classification !== 'OBSERVED_PUBLIC'
    || observation.exactMatchCount !== 1 || observation.signatureSeen !== true
    || !Number.isSafeInteger(observation.signedNonce) || !Number.isSafeInteger(observation.publicSeq)
    || typeof observation.canonicalTextSha256 !== 'string' || typeof observation.publicTimestamp !== 'string') {
    throw new Error(`PUBLIC_EXPORT_SIGNED_EVIDENCE_REFUSED:${observation.operationId}`);
  }
  return {
    did: observation.did,
    room: observation.room,
    signedNonce: observation.signedNonce,
    canonicalTextSha256: observation.canonicalTextSha256,
    publicSeq: observation.publicSeq,
    publicTimestamp: observation.publicTimestamp,
    signatureSeen: observation.signatureSeen,
    classification: observation.classification,
    observationSource: observation.observationSource,
  };
}

function railEvidence(observation, manifestOperation) {
  if (observation.production !== true || observation.classification !== 'OBSERVED_PUBLIC'
    || observation.signed !== false || observation.worldWritable !== true || observation.authorshipProof !== 'NONE'
    || observation.evidenceClass !== 'UNSIGNED_RAIL_OBSERVATION' || observation.valueMoved !== false
    || observation.exactValueMatch !== true || observation.expectedValueSha256 !== observation.observedValueSha256
    || observation.valueCommitment !== manifestOperation.valueCommitment || !observation.receiptSha256
    || !observation.receiptWrittenAt || !observation.observedAt) {
    throw new Error(`PUBLIC_EXPORT_RAIL_EVIDENCE_REFUSED:${observation.operationId}`);
  }
  return {
    namespace: observation.key.ns,
    key: observation.key.key,
    classification: observation.classification,
    valueCommitment: observation.valueCommitment,
    expectedValueSha256: observation.expectedValueSha256,
    observedValueSha256: observation.observedValueSha256,
    exactValueMatch: observation.exactValueMatch,
    receiptSha256: observation.receiptSha256,
    receiptWrittenAt: observation.receiptWrittenAt,
    observedAt: observation.observedAt,
    signed: observation.signed,
    worldWritable: observation.worldWritable,
    authorshipProof: observation.authorshipProof,
    valueMoved: observation.valueMoved,
    evidenceClass: observation.evidenceClass,
  };
}

function assertPublicSafe(value) {
  const json = JSON.stringify(value);
  const unsafePath = /(?:[A-Za-z]:\\\\|[A-Za-z]:\/(?!\/)|C:\\\\Users|C:\/Users|Users[\\/]|blackbox[\\/]state[\\/])/i;
  const unsafeKey = /"(?:secret|preimage|privateKey|private_key|seed|mnemonic|passphrase|dpapi|pendingPath|resultPath|evidencePath|observationPath|reconciliationPath|receiptPath)"\s*:/i;
  const privateMaterial = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bxprv[A-Za-z0-9]{20,}\b|AQAAA[A-Za-z0-9+/=]{40,}/i;
  if (unsafePath.test(json)) throw new Error('PUBLIC_EXPORT_LOCAL_PATH_REFUSED');
  if (unsafeKey.test(json) || privateMaterial.test(json)) throw new Error('PUBLIC_EXPORT_PRIVATE_MATERIAL_REFUSED');
  return true;
}

export function buildPublicCapsule({ capsule, manifest, sourceProductionCapsuleSha256, sourceManifestSha256 }) {
  requireSources(capsule, manifest);
  const observations = new Map(capsule.observations.map(item => [item.operationId, item]));
  const railOperations = new Map(manifest.frameSet.paperRailWrites.map(item => [item.operationId, item]));
  const flightRecord = ORDER.map((operationId, index) => {
    const observation = observations.get(operationId);
    if (!observation || observation.manifestRoot !== EXPECTED_ROOT || observation.venueOrigin !== manifest.venueOrigin) throw new Error(`PUBLIC_EXPORT_OBSERVATION_BINDING_REFUSED:${operationId}`);
    const rail = railOperations.get(operationId);
    const status = rail ? 'RECEIPT_AND_PUBLIC_OBSERVATION_VERIFIED' : 'PUBLICLY_VERIFIED';
    return {
      operationId,
      step: STEPS[index],
      status,
      display: { label: LABELS[index], verification: rail ? 'Receipt and public observation verified' : 'Publicly verified' },
      evidence: rail ? railEvidence(observation, rail) : signedEvidence(observation),
    };
  });
  const projection = {
    schema: 'tclk-blackbox/public-evidence-capsule/v1',
    product: 'TCLK BLACKBOX',
    artifactType: 'PUBLIC_EVIDENCE_CAPSULE',
    lineageId: 'phase3b-final',
    status: {
      acceptance: capsule.acceptance,
      complete: true,
      publicTranscriptEvidenceComplete: true,
      currentPublicRetentionComplete: true,
      retentionGapCount: 0,
    },
    summary: { flightRecordComplete: true, totalSteps: 6, verifiedSteps: 6, unresolvedSteps: 0 },
    deal: {
      lineageId: 'phase3b-final',
      manifestRoot: manifest.manifestRoot,
      venueOrigin: manifest.venueOrigin,
      contractId: manifest.fixtureReplay.contractId,
      dealRoom: manifest.fixtureReplay.dealRoom,
      dealCommitment: manifest.execution.secretCommitment,
    },
    trustModel: {
      operatorModel: 'ONE_HUMAN_OPERATOR_TWO_DISTINCT_CRYPTOGRAPHIC_DIDS',
      sameHumanOperator: true,
      independentHumanCounterparty: false,
      didA: manifest.partyModel.didA,
      didB: manifest.partyModel.didB,
      signaturesDoNotProve: ['HUMAN_IDENTITY', 'WALLET_OWNERSHIP', 'REPUTATION', 'ELIGIBILITY', 'FLOP_IDENTITY'],
    },
    flightRecord,
    evidencePolicy: {
      signedDoesNotMeanSubmitted: true,
      ackDoesNotMeanPubliclyObserved: true,
      publicObservationDoesNotByItselfMeanComplete: true,
      paperRail: {
        isPaymentRail: false,
        provesHumanIdentity: false,
        provesWalletOwnership: false,
        worldWritable: true,
        requiresLocalWriteReceiptForCompletion: true,
        requiresSubsequentExactPublicObservation: true,
      },
    },
  };
  const canonicalProjectionSha256 = sha256(Buffer.from(JSON.stringify(projection), 'utf8'));
  const result = { ...projection, integrity: { sourceProductionCapsuleSha256, sourceManifestSha256,
    manifestRoot: manifest.manifestRoot, canonicalProjectionSha256, canonicalization: 'SHA-256 of compact JSON UTF-8 before integrity block' } };
  assertPublicSafe(result);
  return result;
}

export async function exportPublicCapsule({ sourceCapsulePath = SOURCE_CAPSULE_PATH, sourceManifestPath = SOURCE_MANIFEST_PATH,
  outputPath = PUBLIC_CAPSULE_PATH, hashPath = PUBLIC_HASH_PATH, readmePath = PUBLIC_README_PATH } = {}) {
  const [capsuleBytes, manifestBytes] = await Promise.all([readFile(sourceCapsulePath), readFile(sourceManifestPath)]);
  const sourceProductionCapsuleSha256 = sha256(capsuleBytes); const sourceManifestSha256 = sha256(manifestBytes);
  const publicCapsule = buildPublicCapsule({ capsule: JSON.parse(capsuleBytes.toString('utf8')), manifest: JSON.parse(manifestBytes.toString('utf8')), sourceProductionCapsuleSha256, sourceManifestSha256 });
  const bytes = Buffer.from(`${JSON.stringify(publicCapsule, null, 2)}\n`, 'utf8'); const publicCapsuleSha256 = sha256(bytes);
  const readme = `# Phase 3B final public evidence\n\nThis directory contains a deterministic, public-safe projection of the authoritative machine-local Phase 3B production evidence.\n\nIt proves that the six manifest-bound operations have the receipt and public-observation evidence stated in the capsule. It does not prove human identity, wallet ownership, independent counterparties, payment, reputation, eligibility, or FLOP identity.\n\n- Source manifest root: \`${publicCapsule.deal.manifestRoot}\`\n- Regenerate: \`pnpm evidence:public:final\`\n- Verify: compute SHA-256 over \`phase3b-final-public-capsule.json\` and compare it with \`phase3b-final-public-capsule.sha256\`.\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([writeFile(outputPath, bytes), writeFile(hashPath, `${publicCapsuleSha256}  ${outputPath.split(/[\\/]/).at(-1)}\n`), writeFile(readmePath, readme)]);
  return Object.freeze({ sourceProductionCapsuleSha256, sourceManifestSha256, publicCapsuleSha256, secretScan: 'PASS' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await exportPublicCapsule())}\n`); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
