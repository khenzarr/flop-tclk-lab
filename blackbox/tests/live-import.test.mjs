// SPDX-License-Identifier: Apache-2.0
//
// Future live-transcript import adapter — verification suite.
//
// The adapter is prepared, not activated, so the tests that matter most are the ones proving it
// stays inert and refuses to overclaim. No live read produces any input here; every fixture is a
// hand-written sanitized export.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  importLiveTranscript,
  liveLinesForReplay,
  COMPLETENESS_LIMITATIONS,
  LIVE_SCHEMA,
  liveTextHash,
} from '../core/live-import.mjs';

const line = n => `tclk/1 ${n}`;

const exportDoc = (overrides = {}) =>
  JSON.stringify({
    schema: LIVE_SCHEMA,
    room: 'tclk-deal-abc123',
    generation: 7,
    records: [
      { seq: 1, text: line('offer'), verified: true },
      { seq: 2, text: line('accept'), verified: true },
    ],
    ...overrides,
  });

test('live import preserves room, generation, seq, exact text and the exporter claim', () => {
  const doc = importLiveTranscript(exportDoc());

  assert.equal(doc.room, 'tclk-deal-abc123');
  assert.equal(doc.generation, 7);
  assert.equal(doc.generationKnown, true);
  assert.equal(doc.recordCount, 2);
  assert.deepEqual({ ...doc.observedSeqRange }, { first: 1, last: 2 });

  const [first] = doc.records;
  assert.equal(first.text, line('offer'), 'frame text must survive byte for byte');
  assert.equal(first.textHash, liveTextHash(line('offer')));
  assert.equal(first.observationSeq, 1);
  assert.equal(first.verification.reported, true, 'the exporter claim is preserved');
  assert.equal(first.verification.locallyVerified, false, 'and is never mistaken for verification');
});

test('a missing generation is null and flagged unknown, never inferred', () => {
  const doc = importLiveTranscript(exportDoc({ generation: undefined }));
  assert.equal(doc.generation, null);
  assert.equal(doc.generationKnown, false);
  assert.equal(doc.records[0].generationKnown, false);
});

test('OBSERVED != COMPLETE: no input yields a completeness claim', () => {
  const doc = importLiveTranscript(exportDoc());
  assert.equal(doc.completeness, 'OBSERVED_NO_GAPS_SEEN');
  assert.equal(doc.complete, undefined, 'there must be no boolean anyone can read as "complete"');
  assert.ok(COMPLETENESS_LIMITATIONS.some(l => l.startsWith('OBSERVED != COMPLETE')));
  assert.ok(doc.completenessLimitations.length >= 4);
});

test('a seq gap is reported as observed gaps, not smoothed over', () => {
  const doc = importLiveTranscript(
    exportDoc({ records: [{ seq: 1, text: line('offer') }, { seq: 5, text: line('accept') }] }),
  );
  assert.equal(doc.gapsObserved, true);
  assert.equal(doc.completeness, 'OBSERVED_WITH_GAPS');
});

test('the adapter is inert until deliberately activated', () => {
  const doc = importLiveTranscript(exportDoc());
  assert.equal(doc.activated, false);
  assert.throws(() => liveLinesForReplay(doc), /prepared but not activated/);

  const armed = importLiveTranscript(exportDoc(), { activated: true });
  assert.deepEqual(liveLinesForReplay(armed), [line('offer'), line('accept')]);
});

test('unsafe field sentinel fires before anything is parsed', () => {
  const poisoned = JSON.stringify({
    schema: LIVE_SCHEMA,
    room: 'tclk-deal-abc123',
    records: [{ seq: 1, text: line('offer'), preimage: 'deadbeef' }],
  });
  assert.throws(() => importLiveTranscript(poisoned), /unsafe field detected/);
});

for (const [name, mutation, expected] of [
  ['a foreign schema', { schema: 'tclk-transcript/v1' }, /unsupported live transcript schema/],
  ['an empty record set', { records: [] }, /no records/],
  ['an unnamed room', { room: '   ' }, /must name the room observed/],
  ['a fractional generation', { generation: 1.5 }, /generation must be an integer/],
  ['a record that is not an object', { records: ['tclk/1 offer'] }, /is not an object/],
  ['a record with no text', { records: [{ seq: 1, text: '' }] }, /has no frame text/],
  ['a non-integer seq', { records: [{ seq: '1', text: line('offer') }] }, /non-integer seq/],
  [
    'a record from another room',
    { records: [{ seq: 1, text: line('offer'), room: 'tclk-offers' }] },
    /names room tclk-offers/,
  ],
  [
    'a non-advancing seq',
    { records: [{ seq: 2, text: line('offer') }, { seq: 2, text: line('accept') }] },
    /does not advance past/,
  ],
  [
    'a non-boolean verified claim',
    { records: [{ seq: 1, text: line('offer'), verified: 'yes' }] },
    /non-boolean verified claim/,
  ],
]) {
  test(`live import fails closed on ${name}`, () => {
    assert.throws(() => importLiveTranscript(exportDoc(mutation)), expected);
  });
}

test('live import fails closed on malformed and oversized input', () => {
  assert.throws(() => importLiveTranscript('{'), /invalid JSON/);
  assert.throws(() => importLiveTranscript(null), /exceeds 1 MiB/);
  assert.throws(() => importLiveTranscript('x'.repeat(1024 * 1024 + 1)), /exceeds 1 MiB/);
  assert.throws(() => liveLinesForReplay({ schema: 'nope' }), /not a live transcript document/);
});

test('the parsed document is frozen, so an importer cannot be edited into evidence', () => {
  const doc = importLiveTranscript(exportDoc());
  assert.throws(() => {
    'use strict';
    doc.completeness = 'COMPLETE';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    doc.records[0].text = line('tampered');
  }, TypeError);
});
