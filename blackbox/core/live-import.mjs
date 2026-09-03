// SPDX-License-Identifier: Apache-2.0
//
// Future live-transcript import adapter — PREPARED, NOT ACTIVATED.
//
// Phase 3A performs no live Technocore read or write, so nothing in the product calls this with
// a real export. It exists so that when a sanitized Phase 3B transcript eventually arrives, the
// shape it must arrive in is already fixed, already tested, and already fail-closed — rather
// than being improvised against a live artifact under pressure.
//
// The load-bearing epistemics:
//
//   OBSERVED != COMPLETE
//
// A room export is a *window a reader happened to see*. It is not proof that the window is the
// whole room. This adapter therefore refuses to emit the word "complete" about any input, and
// refuses to hand lines to the deterministic replay unless the caller explicitly activates it.
//
// What is preserved, verbatim and separately from any interpretation of it:
//
//   room        the room name the reader observed the record in
//   generation  the venue's room generation if the export carried one, else null + known:false
//   seq         OBSERVATION METADATA ONLY — never protocol ordering truth
//   text        the exact frame line, byte for byte, plus its hash
//   verified    the exporter's CLAIM, never mistaken for local verification
//
// Signatures are not verified here. `verification.locallyVerified` is `false` for every record
// this adapter produces, because a reader's assertion is not evidence.

import { createHash } from 'node:crypto';

import { UNSAFE_FIELD_PATTERN } from './importer.mjs';

const MAX = 1024 * 1024;
const LIVE_SCHEMA = 'tclk-live-transcript/v1';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

/** Every claim this adapter is structurally unable to make. */
export const COMPLETENESS_LIMITATIONS = Object.freeze([
  'OBSERVED != COMPLETE: this is the window a reader observed, not proof of the whole room.',
  'seq is observation metadata from the venue read, not protocol ordering truth.',
  'A gap in seq proves records were missed; no gap does NOT prove none were.',
  'verification.reported is the exporter\'s claim. Nothing here verified a signature.',
  'This adapter is prepared, not activated: no live Technocore read produced this input.',
]);

const fail = message => {
  throw new Error(`blackbox: ${message}`);
};

/**
 * Parse a sanitized live room export.
 *
 * Fail-closed on every ambiguity: an export we cannot read exactly is worth less than no export,
 * because a misread export still looks like evidence.
 */
export function importLiveTranscript(text, { activated = false } = {}) {
  if (typeof text !== 'string' || text.length > MAX) fail('input exceeds 1 MiB');
  if (UNSAFE_FIELD_PATTERN.test(text)) fail('unsafe field detected');

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('invalid JSON');
  }

  if (!value || value.schema !== LIVE_SCHEMA) fail(`unsupported live transcript schema (expected ${LIVE_SCHEMA})`);
  if (!Array.isArray(value.records) || value.records.length === 0) fail('live transcript contains no records');
  if (typeof value.room !== 'string' || value.room.trim() === '') fail('live transcript must name the room observed');

  // A generation the export did not carry is `null` and flagged unknown. It is never inferred:
  // guessing a generation would fabricate exactly the binding a reader needs to check.
  const generationKnown = value.generation !== undefined && value.generation !== null;
  if (generationKnown && !Number.isInteger(value.generation)) fail('generation must be an integer when present');

  let previousSeq = null;
  let gapsObserved = false;

  const records = value.records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail(`record ${index} is not an object`);
    if (typeof record.text !== 'string' || record.text === '') fail(`record ${index} has no frame text`);
    if (!Number.isInteger(record.seq) || record.seq < 0) fail(`record ${index} has a non-integer seq`);

    // Records observed in a room other than the one declared are not silently absorbed: the
    // room binding is what ties a frame to a deal, so a mismatch is a read error, not a detail.
    const room = record.room === undefined ? value.room : record.room;
    if (room !== value.room) fail(`record ${index} names room ${room}, export declares ${value.room}`);

    if (record.verified !== undefined && typeof record.verified !== 'boolean') {
      fail(`record ${index} carries a non-boolean verified claim`);
    }

    // Out-of-order reads mean the export is not the sequence it presents itself as.
    if (previousSeq !== null) {
      if (record.seq <= previousSeq) fail(`record ${index} seq ${record.seq} does not advance past ${previousSeq}`);
      if (record.seq !== previousSeq + 1) gapsObserved = true;
    }
    previousSeq = record.seq;

    return Object.freeze({
      room: value.room,
      generation: generationKnown ? value.generation : null,
      generationKnown,
      observationSeq: record.seq,
      text: record.text,
      textHash: sha256(record.text),
      verification: Object.freeze({
        reported: record.verified ?? null,
        locallyVerified: false,
        note: 'exporter claim; this adapter verifies no signatures',
      }),
    });
  });

  return Object.freeze({
    schema: LIVE_SCHEMA,
    room: value.room,
    generation: generationKnown ? value.generation : null,
    generationKnown,
    recordCount: records.length,
    observedSeqRange: Object.freeze({ first: records[0].observationSeq, last: records.at(-1).observationSeq }),
    gapsObserved,
    // Deliberately not a boolean named `complete`. There is no input that could set it true.
    completeness: gapsObserved ? 'OBSERVED_WITH_GAPS' : 'OBSERVED_NO_GAPS_SEEN',
    completenessLimitations: COMPLETENESS_LIMITATIONS,
    activated: activated === true,
    records: Object.freeze(records),
  });
}

/**
 * The exact frame lines, in observed order, for the deterministic replay.
 *
 * Gated on explicit activation. Phase 3A never activates it; the gate is what makes "prepared,
 * not activated" a property of the code rather than a promise in a document.
 */
export function liveLinesForReplay(document) {
  if (!document || document.schema !== LIVE_SCHEMA) fail('not a live transcript document');
  if (document.activated !== true) {
    fail('live import is prepared but not activated — pass { activated: true } deliberately');
  }
  return document.records.map(record => record.text);
}

export { LIVE_SCHEMA, sha256 as liveTextHash };
