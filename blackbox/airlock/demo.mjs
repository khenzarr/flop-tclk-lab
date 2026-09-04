// SPDX-License-Identifier: Apache-2.0
//
// Builds the SIGNATURE AIRLOCK surface and the Phase 3B public-footprint preview.
//
// Everything here is offline and deterministic: fixed clock, published test-vector signer, no
// network, no posting. Run with `pnpm airlock`.

import { mkdir, writeFile } from 'node:fs/promises';
import { runAll, footprintPreview, adapterSurface } from './dryrun.mjs';
import { renderAirlock } from './render.mjs';

const scenarios = runAll();
const adapter = adapterSurface();

const out = new URL('../out/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL('signature-airlock.html', out), renderAirlock(scenarios, { adapter }));

const evidence = new URL('../../evidence/', import.meta.url);

await mkdir(evidence, { recursive: true });
const preview = footprintPreview();
await writeFile(
  new URL('phase3b-public-footprint-preview.json', evidence),
  `${JSON.stringify(preview, null, 2)}\n`,
);

console.log(`Airlock surface: ${new URL('signature-airlock.html', out).pathname}`);
for (const scenario of scenarios) {
  const shut = scenario.doors.filter(door => !door.open).map(door => door.door);
  console.log(
    `${scenario.id}: POST_ELIGIBLE=${scenario.eligibility.postEligible ? 'YES' : 'NO'}` +
    ` (expected ${scenario.expectation})${shut.length ? ` · doors held shut: ${shut.join(', ')}` : ''}`,
  );
}
console.log(`Footprint preview: ${preview.steps.length} proposed public actions, 0 performed.`);

console.log(
  `Adapter (${adapter.result.mode}): ${adapter.result.stage} · custody seal ` +
  `${adapter.result.custodySeal.display} · POST_ELIGIBLE=${adapter.result.postEligible ? 'YES' : 'NO'} · POSTED=NO`,
);
console.log(
  `Adapter (REAL_INTERFACE_DRY_RUN): ${adapter.probe.stage} · real signer contacted: ` +
  `${adapter.probe.signerContacted ? 'YES' : 'NO'}`,
);
console.log(`Adapter (TOCTOU probe): ${adapter.toctou.stage} · ${adapter.toctou.findings.join(', ')}`);


