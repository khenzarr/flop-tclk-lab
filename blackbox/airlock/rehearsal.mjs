// SPDX-License-Identifier: Apache-2.0
//
// PHASE 3A.4 — THE OFFLINE REHEARSAL FRAME.
//
// One dedicated synthetic `accept`, built by upstream's own constructors at the adopted pin, for
// the single purpose of rehearsing the custody crossing. It is deliberately unrelated to the
// Phase 3B deal: different actors, different terms, a contract id upstream derives from those
// terms, and a destination room that exists in no protocol derivation at all.
//
// The invariant this module enforces is the one that makes an offline rehearsal safe to sign at
// all: OFFLINE_REHEARSAL_ARTIFACT != PHASE3B_ARTIFACT. It is checked against the recorded Phase 3B
// footprint preview rather than against hand-copied constants, so adding a step to that preview
// automatically widens the collision check instead of silently escaping it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tclk } from '../../lab/upstream.mjs';
import { sha256, OFFLINE_REHEARSAL_ROOM } from './prepare.mjs';


export const REHEARSAL_PURPOSE = 'PHASE3A4_OFFLINE_SIGNATURE_PROOF';

/** Domain separation, so a rehearsal room can never be confused with a protocol derivation. */
const ROOM_DOMAIN = 'FLOPLAB::phase3a4::offline-rehearsal-room::v1';
const PREIMAGE_DOMAIN = 'FLOPLAB::phase3a4::offline-rehearsal-preimage::v1';

const PHASE3B_PREVIEW = new URL('../../evidence/phase3b-public-footprint-preview.json', import.meta.url);

/**
 * Synthetic actors. Structurally valid did:key values that no custody boundary in this lab holds a
 * key for — they name the rehearsal's counterparties in the frame body only. The signer DID that
 * actually matters is the one the canonical signer derives for itself; it is never guessed here.
 */
const REHEARSAL_PAYER = 'did:key:z6Mk' + '3'.repeat(44);
const REHEARSAL_PAYEE = 'did:key:z6Mk' + '4'.repeat(44);

/** A fixed rehearsal clock. Determinism is the point: the same frame every run, forever. */
export const REHEARSAL_NOW_MS = 1700000000000;

/**
 * The lock statement for the rehearsal.
 *
 * Derived from a domain-separated constant rather than from anything with value behind it. It opens
 * nothing real, and the opener is never written to an artifact — a rehearsal must not leave a
 * claimable preimage lying in evidence/.
 */
function rehearsalLock() {
  const preimage = `0x${sha256(PREIMAGE_DOMAIN)}`;
  return tclk.hashLockFromPreimage(preimage);
}

/** `tclk-airlock-offline-<16 hex>`, deterministic in the contract id, single-use by policy. */
export function rehearsalRoom(contractId) {
  const room = `tclk-airlock-offline-${sha256(`${ROOM_DOMAIN}|${contractId}`).slice(0, 16)}`;
  if (!OFFLINE_REHEARSAL_ROOM.test(room)) throw new Error('rehearsal: derived room does not match the offline lane');
  return room;
}

/**
 * Build the rehearsal `accept` with upstream's own constructors — never by hand. `makeAccept`
 * derives the contract id from the offer, so the id is upstream's opinion about these terms and
 * cannot accidentally be a Phase 3B id.
 */
export function buildRehearsalAccept() {
  const lock = rehearsalLock();
  const offer = tclk.makeOffer({
    from: REHEARSAL_PAYER,
    role: 'payer',
    amount: '1',
    asset: 'FLOP',
    lock: 'hash',
    rails: ['paper'],
    claimByMs: REHEARSAL_NOW_MS + 3600000,
    refundAfterMs: REHEARSAL_NOW_MS + 7200000,
    expiresMs: REHEARSAL_NOW_MS + 10800000,
    nonce: 'a4a4a4a4a4a4a4a4',
  });
  const accept = tclk.makeAccept(offer, {
    from: REHEARSAL_PAYEE,
    statement: lock.hash,
    nonce: 'b4b4b4b4b4b4b4b4',
  });
  return Object.freeze({
    purpose: REHEARSAL_PURPOSE,
    frame: accept,
    frameType: 'accept',
    contractId: accept.contract,
    room: rehearsalRoom(accept.contract),
    protocolRoom: tclk.OFFER_ROOM,
    nowMs: REHEARSAL_NOW_MS,
  });
}

/**
 * Every string the recorded Phase 3B footprint preview commits to — rooms, contract ids, canonical
 * hashes, fingerprints — collected by walking the document rather than by naming fields, so a new
 * preview field cannot slip past the collision check.
 */
export function phase3bFootprint({ path = fileURLToPath(PHASE3B_PREVIEW) } = {}) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const values = new Set();
  const walk = node => {
    if (typeof node === 'string') { if (node.length >= 8) values.add(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(document);
  if (typeof document.contractId === 'string') {
    // The preview records step rooms, but derive the deal room too: a future step could add one.
    try { values.add(tclk.dealRoom(document.contractId)); } catch { /* not a derivable id */ }
  }
  values.add(tclk.OFFER_ROOM);
  return Object.freeze({ path, values, contractId: document.contractId ?? null });
}

/**
 * OFFLINE_REHEARSAL_ARTIFACT != PHASE3B_ARTIFACT.
 *
 * Returns findings rather than throwing so a caller can report the whole collision set at once;
 * every caller in this phase treats a non-empty result as a hard stop.
 */
export function assertNonReuse({ room, contractId, canonicalHash, requestId = null, requestFingerprint = null }, footprint = phase3bFootprint()) {
  const findings = [];
  const collides = (label, value) => {
    if (typeof value === 'string' && value.length > 0 && footprint.values.has(value)) findings.push(label);
  };
  collides('REHEARSAL_ROOM_COLLIDES_WITH_PHASE3B', room);
  collides('REHEARSAL_CONTRACT_ID_COLLIDES_WITH_PHASE3B', contractId);
  collides('REHEARSAL_CANONICAL_HASH_COLLIDES_WITH_PHASE3B', canonicalHash);
  collides('REHEARSAL_REQUEST_ID_COLLIDES_WITH_PHASE3B', requestId);
  collides('REHEARSAL_REQUEST_FINGERPRINT_COLLIDES_WITH_PHASE3B', requestFingerprint);
  if (room === tclk.OFFER_ROOM) findings.push('REHEARSAL_ROOM_IS_THE_PUBLIC_BOARD');
  if (typeof room === 'string' && !OFFLINE_REHEARSAL_ROOM.test(room)) findings.push('REHEARSAL_ROOM_NOT_IN_OFFLINE_LANE');
  if (footprint.contractId !== null && contractId === footprint.contractId) {
    findings.push('REHEARSAL_CONTRACT_ID_IS_THE_PHASE3B_CONTRACT');
  }
  return Object.freeze({ ok: findings.length === 0, findings: Object.freeze(findings) });
}
