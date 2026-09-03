// SPDX-License-Identifier: Apache-2.0
//
// Which pinned implementation a piece of evidence was produced against.
//
// Classification is deliberately a READ-TIME function of the capsule's recorded `upstreamSha`,
// not a label stored inside the capsule. A capsule written in Phase 2 could not know that a
// later commit would become the current pin, and a stored label would silently become a lie the
// moment the lab re-pins. So the capsule states the fact (which commit it replayed against) and
// the reader states the relationship (is that commit the current pin, or an earlier one).
//
// Consequence, and the point of the whole exercise: capsules produced before this module
// existed classify correctly without being touched.

import { baseline } from '../../lab/upstream.mjs';

export const CURRENT_BASELINE = 'CURRENT BASELINE';
export const HISTORICAL_BASELINE = 'HISTORICAL BASELINE';

/**
 * Evidence against an earlier pin is not stale, wrong, or expired. It is a verified replay of a
 * transcript against a named implementation, and it stays exactly that forever.
 */
export const EVIDENCE_VALIDITY = 'VALID AGAINST ITS PINNED IMPLEMENTATION';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Commits this lab has recorded evidence against, newest last. Append-only by rule.
 *
 * `adoptedAsPin` is the distinction that matters: a commit can appear here because the lab
 * replayed against it for comparison without that commit ever having been the pin. Recording a
 * comparison run is not the same claim as adopting a baseline, and conflating the two is how a
 * pin silently moves.
 */
export const KNOWN_PINS = Object.freeze({
  '81a83464bd909fb5cd80de647da4e42fbae177dd': Object.freeze({
    fixtureSetVersion: 'legacy-v1',
    adoptedAsPin: true,
    publishedIn: 'Phase 2 replay evidence, Phase 2.1 visual artifacts, Phase 3 evidence chain',
  }),
  '103a1b960c117c82473ee058b7dca1769e167125': Object.freeze({
    fixtureSetVersion: 'current-v2',
    adoptedAsPin: false,
    publishedIn: 'Phase 3A.1 cross-pin comparison run (comparison head, never adopted as the pin)',
  }),
});

export const currentPin = () => baseline.commit;

/** Fail closed on anything that is not a full commit id: a short or absent sha cannot be classified. */
export function classifyPin(upstreamSha) {
  if (typeof upstreamSha !== 'string' || !SHA.test(upstreamSha)) {
    throw new Error('blackbox: upstream sha must be 40 lowercase hex characters');
  }
  return upstreamSha === baseline.commit ? CURRENT_BASELINE : HISTORICAL_BASELINE;
}

/**
 * The full provenance statement for one recorded sha. `known` distinguishes "an earlier pin of
 * this lab" from "a commit this lab has no record of publishing against" without calling either
 * of them invalid.
 */
export function provenanceOf(upstreamSha) {
  const baselineClass = classifyPin(upstreamSha);
  const known = Object.hasOwn(KNOWN_PINS, upstreamSha);
  return Object.freeze({
    upstreamSha,
    baselineClass,
    isCurrentPin: baselineClass === CURRENT_BASELINE,
    evidenceValidity: EVIDENCE_VALIDITY,
    known,
    everAdoptedAsPin: known ? KNOWN_PINS[upstreamSha].adoptedAsPin : null,
    publishedIn: known ? KNOWN_PINS[upstreamSha].publishedIn : null,
  });
}
