// SPDX-License-Identifier: Apache-2.0
//
// SIGNATURE AIRLOCK — deterministic dry runs.
//
// One happy handoff and four refusals, all offline, all reproducible, none of them touching a
// real key or a real room. This module is the single source used by the demo, the committed
// evidence artifacts and the tests, so a claim shown in the UI is the same claim a test asserts.
//
// The frame chosen for the happy run is an ACCEPT: it is a public board post whose canonical
// bytes contain a hash-lock statement and no opener. A REVEAL frame would carry the preimage,
// and while TCLK intends that to become public at claim time, it has no business sitting in a
// committed dry-run artifact.

import { tclk } from '../../lab/upstream.mjs';
import { prepareFrame, sha256, upstreamPin } from './prepare.mjs';
import { buildRequest, approveRequest, AirlockLedger, fingerprintRequest } from './envelope.mjs';
import { TestVectorSigner } from './signer.mjs';
import { buildResponse, verifyResponse, postEligibility } from './verify.mjs';
import {
  signFrozenAirlockRequest, MockSignerTransport, MODES, CANONICAL_SIGNER_PUBLIC_INTERFACE,
} from './adapter.mjs';

const NOW = 1800000000000;

export const CREATED_AT = new Date(NOW).toISOString();
export const SIGNED_AT = new Date(NOW + 42000).toISOString();
const PAYER = `did:key:z6Mk${'f'.repeat(44)}`;
const PREIMAGE = `0x${'ab'.repeat(32)}`;

/** The frame a payee would post next: accept the offer, publishing the lock statement. */
export function outgoingAcceptFrame(signerDid) {
  const offer = tclk.makeOffer({
    from: PAYER, role: 'payer', amount: '100', asset: 'FLOP', lock: 'hash', rails: ['paper'],
    claimByMs: NOW + 1000, refundAfterMs: NOW + 2000, expiresMs: NOW + 5000, nonce: '0102030405060708',
  });
  return tclk.makeAccept(offer, {
    from: signerDid,
    statement: tclk.hashLockFromPreimage(PREIMAGE).hash,
    nonce: '1112131415161718',
  });
}

/** Stages 1–3: identical opening for every scenario, so divergence is always the scenario's. */
function openAirlock() {
  const signer = new TestVectorSigner();
  const prepared = prepareFrame(outgoingAcceptFrame(signer.did));
  const request = buildRequest(prepared, { createdAt: CREATED_AT });
  const approval = approveRequest(request, { approvedAt: CREATED_AT });
  const ledger = new AirlockLedger().open(request);
  return { signer, prepared, request, approval, ledger };
}

const sign = (signer, request) => signer.signApprovedChallenge({
  requestId: request.requestId,
  canonicalPayload: request.canonicalPayload,
  canonicalHash: request.canonicalHash,
  signerDid: request.signerDid,
  room: request.intendedRoom,
});

/** Close a scenario: verify, gate, and record the five doors for the UI. */
function close(id, name, expectation, parts, options = {}) {
  const { request, approval, response, ledger, prepared } = parts;
  const verification = verifyResponse(request, approval, response, { ledger, nowMs: options.nowMs ?? null });
  const eligibility = postEligibility(request, approval, response, verification, { publicPostingEnabled: false });
  if (verification.verified) ledger.complete(request.requestId, response.responseFingerprint);
  return Object.freeze({
    id,
    name,
    expectation,
    doors: Object.freeze([
      { door: 'PREPARED', open: prepared.stage === 'PREPARED', detail: `${prepared.frameType} · ${prepared.payloadBytes} bytes` },
      { door: 'REVIEWED', open: approval.acknowledgement === 'I APPROVE THESE EXACT CANONICAL BYTES', detail: `BYTE FREEZE ${verification.byteFreezeIntact ? 'INTACT' : 'BROKEN'}` },
      { door: 'SIGNED', open: typeof response?.signature === 'string', detail: `${response?.signerKind ?? 'NONE'} · nonce ${response?.nonce ?? '—'}` },
      { door: 'LOCALLY VERIFIED', open: verification.verified, detail: verification.verified ? 'signature covers the approved bytes' : verification.findings[0] },
      { door: 'POST ELIGIBLE', open: eligibility.postEligible, detail: eligibility.postEligible ? 'POST_ELIGIBLE=YES · nothing posted' : 'POST_ELIGIBLE=NO' },
    ]),
    request,
    approval,
    response,
    verification,
    eligibility,
  });
}

export const scenarios = {
  /** The one path that ends POST_ELIGIBLE=YES — and still posts nothing. */
  'happy-handoff': () => {
    const parts = openAirlock();
    const response = buildResponse(sign(parts.signer, parts.request), { signedAt: SIGNED_AT });
    return close('happy-handoff', 'Happy Handoff', 'YES', { ...parts, response }, { nowMs: NOW + 60000 });
  },

  /**
   * BYTE FREEZE: one hex digit of the published lock statement changes after approval — the
   * quietest possible edit, and one that would substitute a different lock. The approval does
   * not follow the request; it keeps its own copy of the bytes.
   */
  'mutated-payload': () => {
    const parts = openAirlock();
    const response = buildResponse(sign(parts.signer, parts.request), { signedAt: SIGNED_AT });
    const mutatedPayload = parts.request.canonicalPayload.replace(
      /("statement":"0x[0-9a-f]{63})([0-9a-f])"/,
      (_, head, last) => `${head}${last === '0' ? '1' : '0'}"`,
    );
    if (mutatedPayload === parts.request.canonicalPayload) throw new Error('dryrun: mutation did not apply');

    const mutated = { ...parts.request, canonicalPayload: mutatedPayload, canonicalHash: sha256(mutatedPayload) };
    return close('mutated-payload', 'Mutated Payload', 'NO', { ...parts, request: mutated, response }, { nowMs: NOW + 60000 });
  },

  /** A structurally perfect signature from a DID the operator never approved. */
  'wrong-signer': () => {
    const parts = openAirlock();
    const impostor = new TestVectorSigner('FLOPLAB::airlock::impostor::v1');
    const response = buildResponse(impostor.signApprovedChallenge({
      requestId: parts.request.requestId,
      canonicalPayload: parts.request.canonicalPayload,
      canonicalHash: parts.request.canonicalHash,
      signerDid: impostor.did,
      room: parts.request.intendedRoom,
    }), { signedAt: SIGNED_AT });
    return close('wrong-signer', 'Wrong Signer', 'NO', { ...parts, response }, { nowMs: NOW + 60000 });
  },

  /** A valid envelope presented after its review window closed. */
  'stale-request': () => {
    const parts = openAirlock();
    const response = buildResponse(sign(parts.signer, parts.request), { signedAt: SIGNED_AT });
    return close('stale-request', 'Stale Request', 'NO', { ...parts, response }, { nowMs: Date.parse(parts.request.expiresAt) + 1 });
  },

  /** The same signed envelope offered twice. The second time is a new action, not a retry. */
  'replayed-response': () => {
    const parts = openAirlock();
    const response = buildResponse(sign(parts.signer, parts.request), { signedAt: SIGNED_AT });
    const first = verifyResponse(parts.request, parts.approval, response, { ledger: parts.ledger, nowMs: NOW + 60000 });
    if (!first.verified) throw new Error('dryrun: the first presentation should verify');
    parts.ledger.complete(parts.request.requestId, response.responseFingerprint);
    return close('replayed-response', 'Replayed Response', 'NO', { ...parts, response }, { nowMs: NOW + 60000 });
  },
};

export const scenarioList = Object.keys(scenarios);
export const runScenario = id => scenarios[id]();
export const runAll = () => scenarioList.map(runScenario);

// ── Canonical signer adapter (Phase 3A.3) ────────────────────────────────────────────────────
//
// The same opening as every scenario above, couriered through the adapter instead of handed to
// the signer directly. MOCK carries the published test-vector signer; REAL_INTERFACE_DRY_RUN asks
// the transport for a non-signing probe and reports NOT_SUPPORTED rather than inventing one.

const ADAPTER_CLOCK = NOW + 60000;

/** MOCK courier run: the one adapter path that reaches POST_ELIGIBLE, and still posts nothing. */
export function adapterCourierRun() {
  const { signer, request, approval, ledger } = openAirlock();
  return signFrozenAirlockRequest({ request, approval }, {
    mode: MODES.MOCK,
    transport: new MockSignerTransport(signer),
    ledger,
    nowMs: ADAPTER_CLOCK,
    signedAt: SIGNED_AT,
  });
}

/** Compatibility probe against the real public interface. Requests no signature. */
export function adapterDryRunProbe() {
  const { signer, request, approval, ledger } = openAirlock();
  return signFrozenAirlockRequest({ request, approval }, {
    mode: MODES.REAL_INTERFACE_DRY_RUN,
    transport: new MockSignerTransport(signer),
    ledger,
    nowMs: ADAPTER_CLOCK,
  });
}

/** TOCTOU: the payload moves after approval. The adapter must refuse before the boundary. */
export function adapterToctouRun() {
  const { signer, request, approval, ledger } = openAirlock();
  const mutatedPayload = request.canonicalPayload.replace(
    /("statement":"0x[0-9a-f]{63})([0-9a-f])"/,
    (_, head, last) => `${head}${last === '0' ? '1' : '0'}"`,
  );
  if (mutatedPayload === request.canonicalPayload) throw new Error('dryrun: TOCTOU mutation did not apply');
  const mutated = { ...request, canonicalPayload: mutatedPayload, canonicalHash: sha256(mutatedPayload) };
  return signFrozenAirlockRequest({ request: mutated, approval }, {
    mode: MODES.MOCK,
    transport: new MockSignerTransport(signer),
    ledger,
    nowMs: ADAPTER_CLOCK,
    signedAt: SIGNED_AT,
  });
}

/**
 * The three bands the UI draws. Derived entirely from adapter output, so a lamp on the surface
 * cannot claim more than the adapter actually returned.
 */
export function adapterBands(result) {
  const seen = code => result.events.some(event => event.code === code);

  const verified = result.verification?.verified === true;
  return Object.freeze([
    Object.freeze({
      band: 'AIRLOCK',
      side: 'LOCAL',
      lamps: Object.freeze([
        { lamp: 'PREPARED', lit: seen('PREPARED'), detail: `${result.response?.room ?? 'tclk-offers'} · post_frame` },
        { lamp: 'REVIEWED', lit: seen('REVIEWED'), detail: 'operator approved the exact bytes' },
        { lamp: 'BYTE FROZEN', lit: verified && result.verification.byteFreezeIntact, detail: verified ? 'freeze intact through handoff' : 'freeze not carried across the boundary' },
      ]),
    }),
    Object.freeze({
      band: 'CUSTODY BOUNDARY',
      side: 'BOUNDARY',
      lamps: Object.freeze([
        { lamp: 'HANDOFF READY', lit: seen('HANDOFF_ALLOWED'), detail: `signer input ${String(result.binding?.signerInputHash ?? '').slice(0, 12) || 'not built'}` },
        { lamp: 'SIGNER RESPONSE', lit: seen('SIGNER_RESPONSE_RECEIVED'), detail: result.response ? `${result.response.signerKind} · signature only` : 'no response accepted' },
        { lamp: 'LOCAL VERIFY', lit: seen('LOCALLY_VERIFIED'), detail: verified ? 'signature covers the frozen bytes' : 'not verified locally' },
      ]),
    }),
    Object.freeze({
      band: 'PUBLIC BOUNDARY',
      side: 'PUBLIC',
      lamps: Object.freeze([
        { lamp: 'POST ELIGIBLE', lit: result.postEligible === true, detail: result.postEligible ? 'POST_ELIGIBLE=YES · nothing posted' : 'POST_ELIGIBLE=NO' },
        { lamp: 'PUBLIC POSTING DISABLED', lit: false, detail: 'held shut for the whole of Phase 3A', held: true },
      ]),
    }),
  ]);
}

/** Everything the adapter surface needs, in one deterministic bundle. */
export function adapterSurface() {
  const result = adapterCourierRun();
  const probe = adapterDryRunProbe();
  const toctou = adapterToctouRun();
  return Object.freeze({
    signerInterface: CANONICAL_SIGNER_PUBLIC_INTERFACE,
    result,
    probe,
    toctou,
    bands: adapterBands(result),
  });
}

/** The committed footprint preview: what WOULD go public, listed without signing anything. */

export function footprintPreview() {
  const signer = new TestVectorSigner();
  const accept = outgoingAcceptFrame(signer.did);
  const prepared = prepareFrame(accept);
  const lock = prepareFrame({ type: 'lock', from: signer.did, contract: accept.contract, rail: 'paper', ref: 'paper-ref' });
  const steps = [prepared, lock].map((step, index) => ({
    step: index + 1,
    operation: step.intendedOperation,
    room: step.intendedRoom,
    frameType: step.frameType,
    canonicalHash: step.canonicalHash,
    payloadBytes: step.payloadBytes,
    public: true,
    posted: false,
  }));
  return {
    schema: 'tclk-public-footprint-preview/v1',
    phase: 'PHASE_3B_PROPOSAL',
    generatedAt: CREATED_AT,
    upstream: upstreamPin(),
    signed: false,
    posted: false,
    statement: 'Proposed public actions for one future rehearsal. Nothing here is signed, nothing has been posted, and the preview alone does not authorise Phase 3B.',
    contractId: prepared.contractId,
    requestFingerprintOfStepOne: fingerprintRequest(buildRequest(prepared, { createdAt: CREATED_AT })),
    steps,
    remainsLocal: [
      'the hash-lock preimage until a reveal is deliberately approved',
      'operator approval records and airlock fingerprints',
      'every private key, which never leaves the trusted local signer',
    ],
  };
}
