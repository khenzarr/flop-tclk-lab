// SPDX-License-Identifier: Apache-2.0
//
// Freeze one genuine old-pin evidence capsule as a permanent compatibility input.
//
// This must be run while the lab is still pinned to 81a8346 — after the repin it cannot be
// reproduced, and that is exactly the point. The capsule it writes is a real Phase 2-era
// artifact: the legacy-v1 `normal-refund` transcript, whose lock sits at the refund boundary
// and is therefore lawful only under the old pin. Current upstream would reject that lock, so
// no future run can regenerate this file. It is checked in and never rewritten.
//
// Its job afterwards is to prove one thing on every test run: a capsule from an earlier pinned
// implementation still parses, still displays, and is still identified as HISTORICAL BASELINE
// rather than being treated as broken.
//
//   node lab/freeze-legacy-capsule.mjs
//
// Writes evidence/legacy-capsule-81a8346.json. Refuses to run at any other pin, and refuses
// to overwrite an existing file.

import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { baseline } from './upstream.mjs';
import { legacyFixtures, replayFixture } from '../blackbox/fixtures/index.mjs';
import { makeCapsule } from '../blackbox/core/capsule.mjs';

const LEGACY_PIN = '81a83464bd909fb5cd80de647da4e42fbae177dd';
const OUT = new URL('../evidence/legacy-capsule-81a8346.json', import.meta.url);

if (baseline.commit !== LEGACY_PIN) {
  console.error(`freeze-legacy-capsule: refusing to run at pin ${baseline.commit}`);
  console.error(`  this artifact is only authentic when produced at ${LEGACY_PIN}`);
  process.exit(1);
}
if (existsSync(fileURLToPath(OUT))) {
  console.error('freeze-legacy-capsule: the frozen capsule already exists and is immutable');
  process.exit(1);
}

const fixture = legacyFixtures['normal-refund']();
const result = replayFixture(fixture);
const capsule = makeCapsule(result, {
  generatedAt: '1970-01-01T00:00:00.000Z',
  completeness: 'TRANSCRIPT COMPLETE FOR PROVIDED INPUT',
});

writeFileSync(fileURLToPath(OUT), `${JSON.stringify(capsule, null, 2)}\n`);
console.log(`frozen ${capsule.upstreamSha} · ${capsule.terminalState} · ${capsule.replayFingerprint}`);
