// SPDX-License-Identifier: Apache-2.0
//
// Provenance and backward compatibility.
//
// Two independent promises are under test here:
//
//   1. Evidence produced against an earlier pinned implementation still parses, still displays,
//      and is labelled HISTORICAL BASELINE rather than treated as broken or stale.
//   2. The migrated current fixture set obeys the deadline rule current upstream enforces, while
//      the legacy set is kept exactly as it was — including the timestamp that made it need
//      migrating in the first place.
//
// The frozen capsule in evidence/legacy-capsule-81a8346.json is a real artifact produced at the
// old pin. Under current upstream its lock frame would be rejected, so it cannot be regenerated;
// if these assertions ever fail, backward compatibility broke, not the fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { baseline } from '../../lab/upstream.mjs';
import { fixtureSets, REFUND_AFTER_MS, replayFixture } from '../fixtures/index.mjs';
import { capsuleView } from '../core/model.mjs';
import { render } from '../ui/render.mjs';
import {
  CURRENT_BASELINE,
  HISTORICAL_BASELINE,
  EVIDENCE_VALIDITY,
  classifyPin,
  provenanceOf,
} from '../core/provenance.mjs';

const LEGACY_PIN = '81a83464bd909fb5cd80de647da4e42fbae177dd';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const legacyCapsule = read('../../evidence/legacy-capsule-81a8346.json');
const migration = read('../../evidence/replay-baseline-migration.json');
const schema = read('../../schemas/blackbox-evidence-capsule.schema.json');

test('the pin in use classifies as current and any other pin as historical', () => {
  assert.equal(classifyPin(baseline.commit), CURRENT_BASELINE);
  assert.equal(classifyPin('0'.repeat(40)), HISTORICAL_BASELINE);
});

test('classification fails closed on anything that is not a full commit id', () => {
  for (const bad of [undefined, null, '', '81a8346', `${LEGACY_PIN}\n`, LEGACY_PIN.toUpperCase()]) {
    assert.throws(() => classifyPin(bad), /40 lowercase hex/);
  }
});

test('an earlier pin is never described as invalid evidence', () => {
  const p = provenanceOf(LEGACY_PIN);
  assert.equal(p.evidenceValidity, EVIDENCE_VALIDITY);
  assert.equal(p.known, true);
  assert.match(p.publishedIn, /Phase 2/);
  // The words a reader must never see attached to old evidence.
  assert.doesNotMatch(JSON.stringify(p), /stale|invalid|expired|obsolete/i);
});

test('the frozen old-pin capsule still satisfies the capsule schema', () => {
  assert.equal(legacyCapsule.upstreamSha, LEGACY_PIN);
  for (const key of schema.required ?? []) {
    assert.ok(Object.hasOwn(legacyCapsule, key), `frozen capsule lost required field ${key}`);
  }
});

test('the frozen old-pin capsule renders with its own provenance, unmodified', () => {
  const view = capsuleView(legacyCapsule);
  const expected = baseline.commit === LEGACY_PIN ? CURRENT_BASELINE : HISTORICAL_BASELINE;
  assert.equal(view.baselineClass, expected);
  assert.equal(view.upstreamSha, LEGACY_PIN);
  assert.equal(view.evidenceValidity, EVIDENCE_VALIDITY);
  assert.equal(view.pinLabel, 'PINNED TCLK 81a8346');
  assert.equal(view.replayFingerprint, legacyCapsule.replayFingerprint);
  assert.equal(view.terminalState, 'refunded');

  const html = render([
    {
      id: 'legacy-normal-refund',
      name: 'NORMAL REFUND (HISTORICAL)',
      description: 'Frozen Phase 2 capsule',
      invariant: legacyCapsule.invariantChecks ? 'rejections do not mutate state' : '',
      result: { steps: [], upstream: { sha: LEGACY_PIN } },
      events: [],
      models: [],
      capsule: legacyCapsule,
      capsuleView: view,
    },
  ]);
  assert.match(html, /HISTORICAL BASELINE|CURRENT BASELINE/);
});

test('lineage records each baseline without claiming the fingerprints are equivalent', () => {
  const published = migration.publishedBaseline;
  const comparison = migration.comparisonBaseline;
  assert.equal(published.upstreamSha, LEGACY_PIN);
  assert.notEqual(comparison.upstreamSha, published.upstreamSha);
  assert.equal(published.evidenceValidity, EVIDENCE_VALIDITY);

  // The comparison head is recorded as a comparison, not as an adopted baseline. If this ever
  // reads true, the lineage file is claiming a re-pin that the phase did not authorise.
  assert.equal(comparison.adopted, false);

  // The frozen capsule is the same replay the lineage record reports for that pin.
  assert.equal(published.replayFingerprints['normal-refund'], legacyCapsule.replayFingerprint);

  // Reauthored bytes must produce different fingerprints; a collision here would mean the
  // migration silently changed nothing, or that a hash was copied across baselines.
  const overlap = Object.keys(published.replayFingerprints).filter(
    id => published.replayFingerprints[id] === comparison.replayFingerprints[id],
  );
  assert.deepEqual(overlap, []);

  // The migrated set replayed under the pin actually in force is a third, separate record —
  // same commit as the published baseline, different fixture timing, so different fingerprints.
  const migrated = migration.migratedUnderPinInForce;
  assert.equal(migrated.upstreamSha, LEGACY_PIN);
  assert.equal(migrated.fixtureSetVersion, 'current-v2');
  assert.notEqual(
    migrated.replayFingerprints['normal-refund'],
    published.replayFingerprints['normal-refund'],
  );
});

test('every current-v2 fixture evaluates its lock strictly before the refund deadline', () => {
  for (const [id, make] of Object.entries(fixtureSets['current-v2'])) {
    const fixture = make();
    assert.equal(fixture.fixtureSetVersion, 'current-v2');
    const lockIndex = fixture.lines.findIndex(line => JSON.stringify(line).includes('"lock"'));
    if (lockIndex === -1) continue;
    const at = fixture.schedule?.[lockIndex] ?? fixture.nowMs;
    assert.ok(
      at < REFUND_AFTER_MS,
      `${id}: lock evaluated at ${at} is not strictly before refundAfterMs ${REFUND_AFTER_MS}`,
    );
  }
});

test('legacy-v1 is preserved intact, including the timestamp that required migration', () => {
  const legacy = fixtureSets['legacy-v1']['normal-refund']();
  assert.equal(legacy.fixtureSetVersion, 'legacy-v1');
  assert.equal(legacy.schedule, null); // no per-frame schedule: every frame at nowMs, as authored
  assert.equal(legacy.nowMs, REFUND_AFTER_MS); // nowMs >= refundAfterMs — the offending condition
});

test('the migrated scenario still reaches the outcome it was written to demonstrate', () => {
  const result = replayFixture(fixtureSets['current-v2']['normal-refund']());
  assert.equal(result.terminalState, 'refunded');
  assert.ok(result.steps.every(step => step.ok), 'the refund path must contain no rejected frames');
});
