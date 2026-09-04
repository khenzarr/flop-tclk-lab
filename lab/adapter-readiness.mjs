// SPDX-License-Identifier: Apache-2.0
//
// PHASE 3B ADAPTER READINESS — can every planned public action be produced through
// Airlock → adapter → local verification, without TCLK ever holding a key?
//
// This reads evidence/phase3b-public-footprint-preview.json as a manifest. It does NOT execute
// it, does not post anything, and does not touch the real canonical signer: every courier run
// below uses the published MOCK test-vector signer. A frame is only READY if a full local run
// reached POST_ELIGIBLE with the byte freeze intact; anything else is reported as it happened.

import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tclk, baseline } from './upstream.mjs';
import { prepareFrame, sha256, upstreamPin } from '../blackbox/airlock/prepare.mjs';
import { buildRequest, approveRequest, AirlockLedger } from '../blackbox/airlock/envelope.mjs';
import { TestVectorSigner } from '../blackbox/airlock/signer.mjs';
import {
  signFrozenAirlockRequest, MockSignerTransport, MODES, ADOPTED_UPSTREAM_PIN,
  CANONICAL_SIGNER_PUBLIC_INTERFACE,
} from '../blackbox/airlock/adapter.mjs';

const NOW = 1800000000000;
const CREATED_AT = new Date(NOW).toISOString();
const SIGNED_AT = new Date(NOW + 42000).toISOString();
const CLOCK = NOW + 60000;
const PREIMAGE = `0x${'ab'.repeat(32)}`;

const previewUrl = new URL('../evidence/phase3b-public-footprint-preview.json', import.meta.url);
const preview = JSON.parse(readFileSync(previewUrl, 'utf8'));

// Two local identities, both published test vectors. Neither is a custody key.
const A = new TestVectorSigner('FLOPLAB::airlock::test-vector::v1');
const B = new TestVectorSigner('FLOPLAB::airlock::readiness::b::v1');

const offer = tclk.makeOffer({
  from: A.did, role: 'payer', amount: '100', asset: 'FLOP', lock: 'hash', rails: ['paper'],
  claimByMs: NOW + 600000, refundAfterMs: NOW + 3600000, expiresMs: NOW + 7200000, nonce: '0102030405060708',
});
const lock = tclk.hashLockFromPreimage(PREIMAGE);
const accept = tclk.makeAccept(offer, { from: B.did, statement: lock.hash, nonce: '1112131415161718' });
const contract = accept.contract;

/**
 * One planned public frame, couriered end to end. Every failure mode — an unknown frame type, a
 * refused handoff, a refused response — is caught and classified rather than thrown, because the
 * point of this run is to produce the classification.
 */
function courier(frame, signer) {
  const prepared = prepareFrame(frame);
  const request = buildRequest(prepared, { createdAt: CREATED_AT });
  const approval = approveRequest(request, { approvedAt: CREATED_AT });
  const ledger = new AirlockLedger().open(request);
  const result = signFrozenAirlockRequest({ request, approval }, {
    mode: MODES.MOCK,
    transport: new MockSignerTransport(signer),
    ledger,
    nowMs: CLOCK,
    signedAt: SIGNED_AT,
  });
  return { prepared, request, result };
}

function classify(step) {
  const record = {
    step: step.step,
    frameType: step.frameType,
    planLabel: step.planLabel,
    room: null,
    operation: 'post_frame',
    signer: step.signerLabel,
    readiness: 'UNKNOWN',
    reason: null,
    canonicalHash: null,
    payloadBytes: null,
    custodySeal: null,
    postEligible: false,
    posted: false,
    signerContacted: false,
    realCanonicalSignerAccessed: false,
    keyCustodyHeldByTclk: false,
    notes: step.notes ?? [],
  };

  let run;
  try {
    run = courier(step.frame, step.signer);
  } catch (error) {
    record.readiness = 'BLOCKED';
    record.reason = `AIRLOCK_REFUSED: ${error.message}`;
    return record;
  }

  const { prepared, result } = run;
  record.room = prepared.intendedRoom;
  record.operation = prepared.intendedOperation;
  record.canonicalHash = prepared.canonicalHash;
  record.payloadBytes = prepared.payloadBytes;
  record.postEligible = result.postEligible === true;
  record.posted = result.posted === true;
  record.signerContacted = result.signerContacted === true;
  record.realCanonicalSignerAccessed = result.realCanonicalSignerAccessed === true;
  record.custodySeal = result.custodySeal?.display ?? null;

  const frozen = result.verification?.byteFreezeIntact === true;
  if (result.postEligible === true && frozen) {
    record.readiness = 'READY';
    record.reason = 'couriered to POST_ELIGIBLE with the byte freeze intact; nothing posted';
  } else if (result.findings?.length) {
    record.readiness = 'BLOCKED';
    record.reason = `ADAPTER_REFUSED: ${result.findings.join(', ')}`;
  } else {
    record.readiness = 'UNKNOWN';
    record.reason = `stage ${result.stage} without a stated finding`;
  }
  return record;
}

// The six public frames docs/PHASE3B_ONE_DEAL_PLAN.md plans, expressed in the vocabulary the
// adopted pin actually validates. The plan's frame 2 is kept under its planned label so the
// mismatch is recorded rather than silently corrected.
const planned = [
  {
    step: 1, planLabel: 'offer', frameType: 'offer', signer: A, signerLabel: 'A',
    frame: offer,
    notes: ['one offer only; tclk-offers is a shared venue'],
  },
  {
    step: 2, planLabel: 'claim', frameType: 'claim', signer: B, signerLabel: 'B',
    frame: { type: 'claim', from: B.did, contract, nonce: '2122232425262728' },
    notes: ['the plan names a claim frame; the adopted pin has no such frame type'],
  },
  {
    step: 3, planLabel: 'accept', frameType: 'accept', signer: B, signerLabel: 'B',
    frame: accept,
    notes: ['upstream accept is made by the offer counterparty, so it carries the plan\'s claim step too'],
  },
  {
    step: 4, planLabel: 'lock', frameType: 'lock', signer: A, signerLabel: 'A',
    frame: { type: 'lock', from: A.did, contract, rail: 'paper', ref: 'paper-ref-1' },
    notes: ['must be posted while the refund window is still closed (nowMs < refundAfterMs)'],
  },
  {
    step: 5, planLabel: 'reveal', frameType: 'reveal', signer: B, signerLabel: 'B',
    frame: { type: 'reveal', from: B.did, contract, secret: PREIMAGE },
    notes: ['the reveal publishes the hash-lock preimage by design; it is not custody material'],
  },
  {
    step: 6, planLabel: 'receipt', frameType: 'receipt', signer: A, signerLabel: 'A',
    frame: { type: 'receipt', from: A.did, contract, outcome: 'claimed', rail: 'paper', ref: 'paper-ref-1' },
    notes: ['outcome is restricted to claimed|refunded|cancelled and must match the contract\'s terminal state'],
  },
];

const frames = planned.map(classify);
const count = readiness => frames.filter(frame => frame.readiness === readiness).length;

// The committed preview is a manifest, not a script. Confirm each previewed step corresponds to a
// frame this run actually couriered, and that the preview still claims nothing was signed or posted.
const previewCheck = {
  file: 'evidence/phase3b-public-footprint-preview.json',
  executed: false,
  readAsManifest: true,
  schema: preview.schema,
  declaresSigned: preview.signed === true,
  declaresPosted: preview.posted === true,
  pinMatchesAdopted: preview.upstream?.sha === ADOPTED_UPSTREAM_PIN,
  steps: preview.steps.map(step => ({
    step: step.step,
    frameType: step.frameType,
    coveredByThisRun: frames.some(frame => frame.frameType === step.frameType && frame.readiness === 'READY'),
  })),
};

const artifact = {
  schema: 'tclk-phase3b-adapter-readiness/v1',
  phase: 'PHASE_3A3',
  generatedAt: CREATED_AT,
  upstream: upstreamPin(),
  adoptedPin: ADOPTED_UPSTREAM_PIN,
  pinIsAdopted: (baseline.commit ?? baseline.sha) === ADOPTED_UPSTREAM_PIN,
  canonicalSignerPublicInterface: CANONICAL_SIGNER_PUBLIC_INTERFACE,
  adapterMode: MODES.MOCK,
  realCanonicalSignerAccessed: false,
  realSignaturePerformed: false,
  liveTechnocoreReads: 'NONE',
  liveTechnocoreWrites: 'NONE',
  valueMoved: 'NONE',
  walletConnected: 'NO',
  tclkHoldsKeyCustody: false,
  statement: 'Every frame below was produced locally through the Airlock and the adapter against the MOCK test-vector signer. READY means a local courier run reached POST_ELIGIBLE with the byte freeze intact. It does not mean posted, approved for posting, or economically meaningful.',
  summary: {
    total: frames.length,
    ready: count('READY'),
    blocked: count('BLOCKED'),
    unknown: count('UNKNOWN'),
  },
  frames,
  preview: previewCheck,
  bindingHashOfRun: sha256(frames.map(frame => `${frame.frameType}:${frame.canonicalHash ?? 'none'}:${frame.readiness}`).join('|')),
};

await writeFile(new URL('../evidence/phase3b-adapter-readiness.json', import.meta.url), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ summary: artifact.summary, frames: frames.map(f => `${f.step} ${f.frameType} ${f.readiness}`), binding: artifact.bindingHashOfRun }, null, 2));
for (const frame of frames) if (frame.readiness !== 'READY') console.log(`  ${frame.frameType}: ${frame.reason}`);
