// SPDX-License-Identifier: Apache-2.0
//
// The Airlock surface is evidence too: it is the only place an operator sees the bytes they are
// approving. These tests hold it to the same rules as the envelopes — no secrets, no posting
// affordance, no silently-collapsed dual representation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll, footprintPreview } from '../airlock/dryrun.mjs';
import { renderAirlock } from '../airlock/render.mjs';

const scenarios = runAll();
const html = renderAirlock(scenarios);

test('surface renders one chamber per dry run and marks only the happy path eligible', () => {
  assert.equal(html.match(/class="chamber /g).length, scenarios.length);
  assert.equal(html.match(/POST_ELIGIBLE = YES/g).length, 1);
  assert.equal(html.match(/POST_ELIGIBLE = NO/g).length, scenarios.length - 1);
});

test('the five doors appear in order for every chamber', () => {
  const order = ['PREPARED', 'REVIEWED', 'SIGNED', 'LOCALLY VERIFIED', 'POST ELIGIBLE'];
  const seen = [...html.matchAll(/class="door-name">\d+\. ([A-Z ]+)</g)].map(m => m[1]);
  assert.equal(seen.length, scenarios.length * order.length);
  for (let i = 0; i < seen.length; i += order.length) {
    assert.deepEqual(seen.slice(i, i + order.length), order);
  }
});

test('a failed door is drawn shut, and every door behind it stays shut', () => {
  for (const scenario of scenarios) {
    const firstShut = scenario.doors.findIndex(door => !door.open);
    if (firstShut === -1) continue;
    for (const door of scenario.doors.slice(firstShut)) {
      assert.equal(door.open, false, `${scenario.id}: ${door.door} opened behind a shut door`);
    }
  }
});

test('dual representation is present and labels the bytes as authoritative', () => {
  assert.equal(html.match(/HUMAN INTERPRETATION/g).length, scenarios.length);
  assert.equal(html.match(/EXACT SIGNED BYTES/g).length, scenarios.length);
  assert.match(html, /advisory only/);
  assert.match(html, /signature covers the exact canonical bytes, not the human/);
});

test('every chamber shows the exact canonical payload and its hash', () => {
  for (const scenario of scenarios) {
    const escaped = scenario.request.canonicalPayload.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    assert.ok(html.includes(escaped), `${scenario.id}: canonical bytes missing from surface`);
    assert.ok(html.includes(scenario.request.canonicalHash), `${scenario.id}: hash missing`);
  }
});

test('PUBLIC POSTING DISABLED is visible and POST ELIGIBLE is distinguished from POSTED', () => {
  assert.match(html, /PUBLIC POSTING DISABLED/);
  assert.match(html, /POST ELIGIBLE is not POSTED/);
  assert.match(html, /Nothing has crossed the\s+network/);
});

test('the surface offers no way to post: no script, no network, no form', () => {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<form|<input|<button/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /\bon[a-z]+\s*=/i);
  assert.match(html, /default-src 'none'/);
});

// The prose names secret categories deliberately, in the negative ("never receives a seed, a
// passphrase, or a decrypted key"). The sentinel therefore scans the data-bearing regions — byte
// blocks, key/value rows, door details — which is where a real leak would surface.
const dataRegions = [
  ...[...html.matchAll(/<pre class="bytes"[^>]*>([\s\S]*?)<\/pre>/g)].map(m => m[1]),
  ...[...html.matchAll(/<div class="row">([\s\S]*?)<\/div>/g)].map(m => m[1]),
  ...[...html.matchAll(/<span class="door-detail">([\s\S]*?)<\/span>/g)].map(m => m[1]),
].join('\n');

test('secret sentinel: no key material reaches the data regions of the surface', () => {
  assert.ok(dataRegions.length > 1000, 'sentinel found no data regions to scan');
  const banned = /(private\s*key|privateKey|secretKey|signingKey|mnemonic|passphrase|seed|preimage|witness|BEGIN [A-Z ]*PRIVATE KEY)/i;
  assert.doesNotMatch(dataRegions, banned);
});

test('secret vocabulary appears only inside negative statements', () => {
  for (const sentence of html.matchAll(/[^.>]*\b(passphrase|mnemonic|decrypted key|a seed)\b[^.]*\./g)) {
    assert.match(sentence[0], /\b(never|no|not|without|holds no)\b/i,
      `unqualified secret mention: ${sentence[0].trim()}`);
  }
});

test('failed chambers explain themselves with at least one finding or blocker', () => {
  for (const scenario of scenarios.filter(s => !s.eligibility.postEligible)) {
    const reasons = scenario.verification.findings.length + scenario.eligibility.blockers.length;
    assert.ok(reasons > 0, `${scenario.id}: refused without a stated reason`);
  }
  assert.match(html, /class="findings"/);
});

test('rendering is deterministic', () => {
  assert.equal(renderAirlock(runAll()), html);
});

test('footprint preview lists proposed public actions and performs none', () => {
  const preview = footprintPreview();
  assert.equal(preview.signed, false);
  assert.equal(preview.posted, false);
  assert.equal(preview.phase, 'PHASE_3B_PROPOSAL');
  assert.ok(preview.steps.length > 0);
  for (const step of preview.steps) {
    assert.equal(step.public, true);
    assert.equal(step.posted, false);
    assert.equal(typeof step.canonicalHash, 'string');
    assert.doesNotMatch(JSON.stringify(step), /signature/i);
  }
  assert.deepEqual(preview.steps.map(s => s.step), preview.steps.map((_, i) => i + 1));
});

test('footprint preview carries no signature and no secret material', () => {
  const json = JSON.stringify(footprintPreview());
  assert.doesNotMatch(json, /"signature"|privateKey|mnemonic|passphrase/i);
  // The preimage is named as something that stays local; its value must not be here.
  assert.doesNotMatch(json, /0x(?:[0-9a-f]{2})*ababab/i);
});
