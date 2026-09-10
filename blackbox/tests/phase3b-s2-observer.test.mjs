import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { MANIFEST, exactRoomMatch, parseExportJsonl, reconcileRoomObservation,
  effectiveRoomObservationPath, requirePredecessor } from '../phase3b-s2.mjs';
import { prepareFrame } from '../airlock/prepare.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(resolve(tmpdir(), 'phase3b-s2-observer-')); roots.push(path); return path; };
const signed = { room: 'tclk-offers', did: 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi', nonce: 2,
  text: prepareFrame(MANIFEST.frameSet.frames.find(frame => frame.operationId === 'phase3b-s2-write-1').canonicalFrame).canonicalPayload };

test('exact retained-ring JSONL matches from + nonce + canonical text hash', async () => {
  const text = signed.text;
  const jsonl = [
    JSON.stringify({ seq: 1, ts: 'earlier', from: signed.did, text, nonce: 1, sig: 'wrong-nonce' }),
    JSON.stringify({ seq: 2394976, ts: '2026-09-10T13:13:43.038225Z', from: signed.did, text, nonce: 2, sig: 'seen' }),
    '',
  ].join('\r\n');
  const match = exactRoomMatch({ ...signed, text }, parseExportJsonl(jsonl));
  assert.equal(match.match, true);
  assert.equal(match.exactMatchCount, 1);
  assert.equal(match.canonicalTextSha256, 'c1491c2ee0f4ce1d00b0fe8be478174c02e497231d3ebf5c727adec05762f2ee');
  assert.equal(match.publicSeq, 2394976);
  assert.equal(match.publicTimestamp, '2026-09-10T13:13:43.038225Z');
  assert.equal(match.signatureSeen, true);
});

test('DID, nonce and text hash are all required', () => {
  const text = signed.text; const base = { from: signed.did, nonce: 2, text, sig: 'seen' };
  assert.equal(exactRoomMatch({ ...signed, text }, [{ ...base, from: 'did:key:wrong' }]).match, false);
  assert.equal(exactRoomMatch({ ...signed, text }, [{ ...base, nonce: 3 }]).match, false);
  assert.equal(exactRoomMatch({ ...signed, text }, [{ ...base, text: `${text} ` }]).match, false);
});

test('historical false negative is preserved and corrected observation satisfies dependency', () => {
  const stateRoot = root(); const id = 'phase3b-s2-write-1';
  const historicalPath = resolve(stateRoot, `${id}-observation.json`);
  const historical = { schema: 'tclk/phase3b-s2-room-observation/v1', lineageId: 'phase3b-s2', manifestRoot: MANIFEST.manifestRoot,
    operationId: id, classification: 'PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW', observationSource: 'NOT_FOUND_IN_RETAINED_RING' };
  writeFileSync(historicalPath, `${JSON.stringify(historical, null, 2)}\n`);
  const before = readFileSync(historicalPath, 'utf8');
  const corrected = { ...historical, classification: 'OBSERVED_PUBLIC', observationSource: 'https://technocore.chat/r/tclk-offers/export',
    exactMatchCount: 1, publicSeq: 2394976, publicTimestamp: '2026-09-10T13:13:43.038225Z', signatureSeen: true };
  const result = reconcileRoomObservation(id, corrected, { stateRoot });
  assert.equal(readFileSync(historicalPath, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(result.reconciliationPath, 'utf8')).classification, 'FALSE_NEGATIVE_OBSERVER_HISTORICAL');
  assert.equal(effectiveRoomObservationPath(id, stateRoot), result.evidencePath);
  assert.equal(requirePredecessor('phase3b-s2-write-2', { submitStateRoot: stateRoot }).classification, 'OBSERVED_PUBLIC');
});
