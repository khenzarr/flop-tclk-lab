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
    observations.push({ operationId: id, ...signedObservation(signed, observations.length + 1166870), classification: observed.classification });
  }
  if (completed.join('|') !== PUBLIC_ORDER.join('|')) throw new Error('FINALIZE_INCOMPLETE');
  return Object.freeze({ schema: 'tclk/phase3b-fixture-journey/v1', manifestRoot: manifest.manifestRoot,
    historicalManifestRoot: manifest.supersedesManifestRoot, order: completed, records, observations,
    realNetworkCalls: 0, realSignatures: 0, realNonces: 0, paperRailValueMoved: false });
}

export function finalizeFixtureJourney(options = {}) {
  const capsule = runFixtureJourney(options);
  const path = resolve('evidence/local-phase3b-final-capsule.json');
  mkdirSync(resolve('evidence'), { recursive: true });
  if (existsSync(path)) throw new Error('FINAL_CAPSULE_ALREADY_EXISTS');
  writeFileSync(path, `${JSON.stringify({ ...capsule, acceptance: 'PHASE3B_PUBLIC_TRANSCRIPT_COMPLETE', distinctions: ['SIGNED != SUBMITTED', 'ACK_RECEIVED != OBSERVED_PUBLIC', 'PaperRail != PAYMENT', 'signature != HUMAN IDENTITY'] }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return Object.freeze({ ...capsule, path, acceptance: 'PHASE3B_PUBLIC_TRANSCRIPT_COMPLETE' });
}