// Offline Phase 3B journey. This controller deliberately has no live transport or custody path.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../evidence/phase3b-exact-manifest.json' with { type: 'json' };
import { tclk } from '../lab/upstream.mjs';
import { PUBLIC_ORDER, assertExecutionOrder, fixtureSignManifestOperation, fixtureObserve, manifestOperation } from './phase3b2.mjs';

const SECRET_PATH = resolve('blackbox/state/phase3b-deal-secret/phase3b-deal.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function loadDealSecret(path = SECRET_PATH) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^0x[0-9a-f]{64}$/.test(value.secret)) throw new Error('SECRET_STATE_CONFLICT');
  return value.secret;
}

export function verifyDealSecret(secret) {
  const expected = manifest.execution.secretCommitment;
  const actual = tclk.hashLockFromPreimage(secret).hash;
  if (actual !== expected) throw new Error('REVEAL_SECRET_COMMITMENT_MISMATCH');
  return true;
}

function signedObservation(record, seq) {
  return { room: record.room, did: record.did, nonce: record.nonce, canonicalTextSha256: sha256(record.text),
    payloadBytes: Buffer.byteLength(record.text), seq, timestamp: `2026-09-08T12:42:44.${String(seq).padStart(6, '0')}Z`, source: 'FIXTURE_ROOM' };
}

export function runFixtureJourney({ secret = loadDealSecret(), includeWrite1 = true } = {}) {
  verifyDealSecret(secret);
  const completed = includeWrite1 ? ['phase3b-write-1'] : [];
  const records = [];
  const observations = includeWrite1 ? [{ operationId: 'phase3b-write-1', seq: 1166871, timestamp: '2026-09-08T12:42:44.422919Z', source: 'RETAINED_RING_EXPORT', classification: 'OBSERVED_PUBLIC' }] : [];
  for (const id of PUBLIC_ORDER.slice(includeWrite1 ? 1 : 0)) {
    assertExecutionOrder(completed, id);
    const spec = manifestOperation(id);
    if (spec.actionClass === 'PaperRail') {
      completed.push(id);
      observations.push({ operationId: id, classification: 'OBSERVED_PUBLIC', source: 'FIXTURE_PAPER_RAIL', note: spec.note });
      continue;
    }
    const signed = fixtureSignManifestOperation(id, { nonce: 1, secret: id === 'phase3b-write-4' ? secret : undefined });
    if (id === 'phase3b-write-4') verifyDealSecret(secret);
    const observed = fixtureObserve(signed, [signed]);
    if (observed.classification !== 'OBSERVED_PUBLIC') throw new Error(`FIXTURE_OBSERVATION_FAILED:${id}`);
    completed.push(id); records.push(signed);
    const observation = id === 'phase3b-write-2'
      ? { operationId: id, classification: 'SERVER_APPENDED_THEN_NOT_RETAINED', originalSubmitClassification: 'ACK_RECEIVED',
        httpStatus: 200, postCalls: 1, room: 'tclk-offers', did: 'did:key:z6Mkk9tS1bieLjbRmh7fa4hy7BQRapTG9rp7q8En9o4GvmfK', nonce: 1,
        requestBodySha256: '64e2a38c38b6249b2655e9c17c7b02025706d0b64fff883d97025bf06e70fc3b',
        responseBodySha256: '26fcf45898a3c7fb037a74552afe968de49df36832c9f776279da9eb42bcbbb6',
        submitTimestamp: '2026-09-08T23:51:00.618Z', canonicalTextSha256: sha256(signed.text), signedNonce: signed.nonce,
        retentionObservation: 'NOT_FOUND_IN_RETAINED_RING', publicSeq: 'UNKNOWN', publicTimestamp: 'UNKNOWN',
        evidenceLimitation: 'PUBLIC_RECORD_NO_LONGER_RETAINED' }
      : { operationId: id, ...signedObservation(signed, observations.length + 1166870), classification: observed.classification };
    observations.push(observation);
  }
  if (completed.join('|') !== PUBLIC_ORDER.join('|')) throw new Error('FINALIZE_INCOMPLETE');
  return Object.freeze({ schema: 'tclk/phase3b-fixture-journey/v1', manifestRoot: manifest.manifestRoot,
    historicalManifestRoot: manifest.supersedesManifestRoot, order: completed, records, observations,
    realNetworkCalls: 0, realSignatures: 0, realNonces: 0, paperRailValueMoved: false });
}

export function finalizeFixtureJourney(options = {}) {
  const capsule = runFixtureJourney(options);
  const retentionGaps = capsule.observations.filter(observation => observation.classification === 'SERVER_APPENDED_THEN_NOT_RETAINED');
  const path = resolve('evidence/local-phase3b-final-capsule.json');
  mkdirSync(resolve('evidence'), { recursive: true });
  if (existsSync(path)) throw new Error('FINAL_CAPSULE_ALREADY_EXISTS');
  const final = { ...capsule, acceptance: 'PHASE3B_PUBLIC_TRANSCRIPT_COMPLETE',
    PUBLIC_TRANSCRIPT_EVIDENCE_COMPLETE: 'YES', CURRENT_PUBLIC_RETENTION_COMPLETE: retentionGaps.length === 0 ? 'YES' : 'NO',
    RETENTION_GAP_COUNT: retentionGaps.length,
    RETENTION_GAP_OPERATION: retentionGaps.length === 1 ? retentionGaps[0].operationId : retentionGaps.map(item => item.operationId),
    distinctions: ['SIGNED != SUBMITTED', 'ACK_RECEIVED != OBSERVED_PUBLIC', 'SERVER_APPENDED_THEN_NOT_RETAINED != OBSERVED_PUBLIC', 'PaperRail != PAYMENT', 'signature != HUMAN IDENTITY'] };
  writeFileSync(path, `${JSON.stringify(final, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return Object.freeze({ ...final, path });
}