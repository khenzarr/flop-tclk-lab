// SPDX-License-Identifier: Apache-2.0
//
// SIGNATURE AIRLOCK — STAGE 1: FRAME PREPARED.
//
// The airlock is not a signer and holds no key. It exists so the exact bytes that cross a
// custody boundary are inspectable, approvable, fingerprinted and replayable BEFORE any
// trusted local signer is asked for a signature, and so nothing downstream can quietly
// substitute different bytes afterwards.
//
// Canonicalization is upstream's, never ours: `encodeFrame` produces the payload, and we
// re-decode and re-encode our own output rather than trusting it. If that round trip is not
// byte-identical the frame never reaches an operator.

import { createHash } from 'node:crypto';
import { tclk, baseline } from '../../lab/upstream.mjs';

export const AIRLOCK_REQUEST_SCHEMA = 'tclk-airlock-request/v1';
export const AIRLOCK_RESPONSE_SCHEMA = 'tclk-airlock-response/v1';

/** Technocore's `clean_text` categories, mirrored from the venue's own signer contract. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

export const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
export const canonicalJson = value => tclk.canonicalJson(value);
export const sweep = text => text.replace(INVISIBLE, ' ').trim();

/** Frame types that rest on the public board rather than in a derived deal room. */
const BOARD_TYPES = new Set(['offer', 'accept']);
const OPERATIONS = new Set(['post_frame']);

/**
 * Phase 3A.4 offline rehearsal rooms. A dedicated, deterministic, single-use lane that exists so
 * an offline rehearsal can be frozen and preflighted without ever naming the shared public board
 * or a real deal room. It is not a Technocore room this lab posts to — nothing is posted at all —
 * and by construction it can never collide with `tclk-offers` or a `dealRoom()` derivation.
 */
export const OFFLINE_REHEARSAL_ROOM = /^tclk-airlock-offline-[0-9a-f]{16}$/;

export const upstreamPin = () => ({
  repository: baseline.repository ?? 'https://github.com/flop-labs/tclk',
  sha: baseline.commit,
  package: '@flop-labs/tclk@0.1.0',
});


export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Stage 1. Everything an operator needs to decide, and nothing a signer needs to be trusted
 * with. The nonce is deliberately absent: the trusted local signer reserves it durably
 * inside custody, so it cannot be part of the bytes we freeze. See docs/SIGNATURE_AIRLOCK.md
 * "What BYTE FREEZE does not cover".
 */
export function prepareFrame(frame, { operation = 'post_frame', offlineRehearsalRoom = null } = {}) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('airlock: frame must be an object');
  }
  if (!OPERATIONS.has(operation)) throw new Error(`airlock: operation '${operation}' is not permitted`);
  if (offlineRehearsalRoom !== null && !OFFLINE_REHEARSAL_ROOM.test(offlineRehearsalRoom)) {
    throw new Error('airlock: an offline rehearsal room must match tclk-airlock-offline-<16 hex>');
  }

  const canonicalPayload = tclk.encodeFrame(frame);
  const decoded = tclk.decodeFrame(canonicalPayload);
  if (tclk.encodeFrame(decoded) !== canonicalPayload) {
    throw new Error('airlock: canonical encoding is not round-trip stable for this frame');
  }
  const contractId = typeof frame.contract === 'string' ? frame.contract
    : typeof frame.id === 'string' ? frame.id : null;
  if (contractId === null) throw new Error('airlock: frame names no contract or offer id');
  const signerDid = frame.from;
  if (typeof signerDid !== 'string' || signerDid.length === 0) {
    throw new Error('airlock: frame names no actor DID');
  }
  // A rehearsal room, when named, REPLACES the protocol destination. That is the point: an offline
  // rehearsal must never be addressed to the shared public board or to a real deal room, so the
  // frozen bytes and the signed preimage both carry the dedicated lane instead.
  const intendedRoom = offlineRehearsalRoom
    ?? (BOARD_TYPES.has(decoded.type) ? tclk.OFFER_ROOM : tclk.dealRoom(contractId));
  const protocolRoom = BOARD_TYPES.has(decoded.type) ? tclk.OFFER_ROOM : tclk.dealRoom(contractId);

  const swept = sweep(canonicalPayload);
  const sweepIsIdentity = swept === canonicalPayload;
  const warnings = [
    'PUBLIC POSTING DISABLED — Phase 3A produces eligibility only, never a room write.',
    'The exact canonical bytes, not the human interpretation, are what a signature covers.',
    'The room-message nonce is reserved inside the signer custody boundary and is therefore not part of the frozen payload; it is verified from the response.',
  ];
  if (!sweepIsIdentity) {
    warnings.push('The venue single-line sweep would alter these bytes — the signature would cover the swept form, not this payload.');
  }
  if (offlineRehearsalRoom !== null) {
    warnings.push(`OFFLINE REHEARSAL LANE — the destination is the dedicated rehearsal room, not this frame's protocol room (${protocolRoom}). It is single-use and must never be reused for a real deal.`);
  }
  return deepFreeze({
    stage: 'PREPARED',
    frameType: decoded.type,
    contractId,
    signerDid,
    intendedRoom,
    protocolRoom,
    offlineRehearsal: offlineRehearsalRoom !== null,

    intendedOperation: operation,
    canonicalPayload,
    canonicalHash: sha256(canonicalPayload),
    payloadBytes: Buffer.byteLength(canonicalPayload, 'utf8'),
    sweepIsIdentity,
    nonceOwner: 'TRUSTED_LOCAL_SIGNER',
    upstream: upstreamPin(),
    human: humanReading(decoded, intendedRoom),
    warnings,
  });
}

/**
 * Stage 3's left-hand column. Prose for a human, derived from the decoded frame and shown
 * beside the payload — never instead of it. A field this function cannot explain is still in
 * the bytes, which is exactly why both representations are displayed.
 */
export function humanReading(frame, room) {
  const lines = [
    ['Frame type', frame.type],
    ['Actor DID', frame.from],
    ['Contract', frame.contract ?? frame.id ?? 'unavailable'],
    ['Destination room', room],
  ];
  if (frame.amount !== undefined) lines.push(['Amount', `${frame.amount} ${frame.asset ?? ''}`.trim()]);
  if (frame.lock !== undefined) lines.push(['Lock kind', String(frame.lock)]);
  if (frame.rail !== undefined) lines.push(['Rail', String(frame.rail)]);
  if (frame.ref !== undefined) lines.push(['Rail reference', String(frame.ref)]);
  if (frame.statement !== undefined) lines.push(['Statement', String(frame.statement)]);
  const meaning = {
    offer: 'States terms publicly. Nothing is escrowed by this frame.',
    accept: 'Publishes a lock statement and fixes the contract id. No value moves.',
    lock: 'Asserts that a rail record exists. The counterparty is expected to check the rail itself.',
    reveal: 'Publishes the lock opener. Publishing it IS the claim.',
    refund: 'Claims the refund path after its deadline.',
    cancel: 'Ends the contract before it is locked.',
    receipt: 'Records an outcome already reached.',
  }[frame.type] ?? 'Unrecognised frame type — read the exact bytes.';
  return { meaning, fields: lines.map(([label, value]) => ({ label, value: String(value) })) };
}
