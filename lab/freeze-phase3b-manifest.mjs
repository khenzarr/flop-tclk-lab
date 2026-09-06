// SPDX-License-Identifier: Apache-2.0
//
// Phase 3B.1-R2 — recompute the exact, fixture-only write manifest.
//
// This command is intentionally downstream of lab/upstream.mjs.  It cannot produce a manifest
// unless the fail-closed runtime loader has attested and imported the pinned implementation.
// It creates no signer, reserves no nonce, contacts no transport, and never writes a preimage to
// the manifest.  The values below are deterministic test-vector inputs, not execution credentials.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { runtimeAttestation, runtimeIdentity, tclk, baseline } from './upstream.mjs';

const ROOT = new URL('../', import.meta.url);
const PIN = 'd48e87343200e3115e243df39e8f295f5ce2e645';
const DID_A = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';
const DID_B = 'did:key:z6MkoetPhd5Aa1pKFCR2a8SinCWaL64U7ytcPP6zg5pnnDoW';
const NOW = 1800000000000;
const PREIMAGE = `0x${'ab'.repeat(32)}`;

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const frameHash = frame => sha256(tclk.encodeFrame(frame));
const clone = value => JSON.parse(JSON.stringify(value));

if (runtimeAttestation !== 'PASS' || runtimeIdentity.sourceCommit !== PIN) {
  throw new Error('phase3b manifest: runtime is not attested at the adopted pin; refusing to freeze');
}
if ((baseline.runtimeAttestation?.sourceCommit ?? null) !== PIN) {
  throw new Error('phase3b manifest: baseline runtime identity is not bound to the adopted pin');
}

const offer = tclk.makeOffer({
  from: DID_A, role: 'payer', amount: '100', asset: 'FLOP', lock: 'hash', rails: ['paper'],
  claimByMs: NOW + 600000, refundAfterMs: NOW + 3600000, expiresMs: NOW + 7200000,
  nonce: '0102030405060708',
});
const lock = tclk.hashLockFromPreimage(PREIMAGE);
const acceptCore = { from: DID_B, ref: offer.id, statement: lock.hash, nonce: '1112131415161718' };
const accept = tclk.makeAccept(offer, acceptCore);
const contract = accept.contract;
const lockFrame = { type: 'lock', from: DID_A, contract, rail: 'paper', ref: 'paper-ref-1' };
const revealFrame = { type: 'reveal', from: DID_B, contract, secret: PREIMAGE };

let state = tclk.openContract(offer);
const before = state.status;
const acceptResult = tclk.applyFrame(state, accept, NOW);
state = acceptResult.state ?? acceptResult;
const afterAccept = state.status;
const lockResult = tclk.applyFrame(state, lockFrame, NOW);
state = lockResult.state ?? lockResult;
const afterLock = state.status;
const revealResult = tclk.applyFrame(state, revealFrame, NOW);
state = revealResult.state ?? revealResult;

const frameSpecs = [
  { write: 1, frame: offer, type: 'offer', room: tclk.OFFER_ROOM, signerRole: 'party A / payer', stateBefore: null, stateAfter: 'proposed' },
  { write: 2, frame: accept, type: 'accept', room: tclk.OFFER_ROOM, signerRole: 'party B / payee', stateBefore: 'proposed', stateAfter: 'accepted' },
  { write: 3, frame: lockFrame, type: 'lock', room: tclk.dealRoom(contract), signerRole: 'party A / payer', stateBefore: 'accepted', stateAfter: 'locked' },
  { write: 4, frame: revealFrame, type: 'reveal', room: tclk.dealRoom(contract), signerRole: 'party B / payee', stateBefore: 'locked', stateAfter: 'claimed' },
];

const frames = frameSpecs.map(({ frame, ...spec }) => ({
  ...spec,
  canonicalFrame: spec.type === 'reveal' ? { ...clone(frame), secret: '<GENERATED_AT_EXECUTION>' } : clone(frame),
  canonicalFrameHash: frameHash(frame),
  payloadBytes: Buffer.byteLength(tclk.encodeFrame(frame), 'utf8'),
  public: true,
  valueMoved: false,
}));

const trajectory = [before, afterAccept, afterLock, state.status];
if (trajectory.join(' -> ') !== 'proposed -> accepted -> locked -> claimed') {
  throw new Error(`phase3b manifest: unexpected fixture trajectory ${trajectory.join(' -> ')}`);
}

const manifest = {
  schema: 'tclk-blackbox/phase3b-exact-manifest/v1',
  phase: '3B.1',
  kind: 'fixture-only-exact-write-manifest',
  generatedBy: 'flop-tclk-lab Phase 3B.1-R2 runtime-attested manifest freeze',
  frozen: true,
  signed: false,
  posted: false,
  provenance: {
    tclkPin: PIN,
    repository: baseline.repository,
    runtimeAttestation,
    runtimeAlgorithm: runtimeIdentity.algorithm,
    sourceSha: runtimeIdentity.sourceCommit,
    lockfileSha256: runtimeIdentity.lockfileSha256,
    distTreeSha256: runtimeIdentity.distTreeSha256,
    productionClosureSha256: runtimeIdentity.prodClosureSha256,
    runtimeEntrypoint: runtimeIdentity.entrypoint,
    signingCommit: '124d621dd8c68b04bed79744ab332e8305093d02',
    enrollmentCommit: '3675aeacdb73656285c4253b6d6d8d937afe25d6',
    technocoreEvidence: '82d942936050f1ab0fb9f34db17893b89f3e064b',
  },
  safety: {
    realCanonicalKeyAccessed: false,
    realSignaturePerformed: false,
    realNonceConsumed: false,
    transportObjects: 0,
    networkCalls: 0,
    submissionCalls: 0,
    technocoreReads: 0,
    technocoreWrites: 0,
    publicActions: 0,
    posted: false,
    valueMoved: false,
    secretsInArtifact: false,
  },
  partyModel: {
    didA: DID_A,
    didB: DID_B,
    didADerivation: 'verified public DID from phase 3B.C1a',
    didBDerivation: 'verified public DID from phase 3B.C1b',
    roleA: 'offer / payer / lock',
    roleB: 'accept / payee / reveal',
    distinctDids: true,
  },
  envelope: { version: 'tclk/1', wirePrefix: tclk.TCLK_PREFIX, signingDomain: tclk.TCLK_DOMAIN, maxFrameChars: tclk.MAX_FRAME_CHARS },
  execution: {
    executionId: 'NOT_CREATED — frozen manifest is not an execution authorization',
    oneShotPerWrite: true,
    signAndSubmitSeparate: true,
    automaticRetries: 0,
    noncePolicy: 'GENERATED_AND_RESERVED_INSIDE_TRUSTED_SIGNER_AT_EXECUTION; fixture nonces above are not reservations',
    revealSecretPolicy: 'GENERATED_AT_EXECUTION; omitted from this artifact',
  },
  frameSet: {
    sequence: ['offer', 'accept', 'lock', 'reveal'],
    signedRoomWrites: 4,
    totalPublicWrites: 4,
    terminalFrame: 'reveal',
    frames,
  },
  fixtureReplay: {
    fixtureOnly: true,
    trajectory,
    finalStatus: state.status,
    acceptOk: acceptResult.ok === true,
    lockOk: lockResult.ok === true,
    revealOk: revealResult.ok === true,
    contractId: contract,
    offerId: offer.id,
    dealRoom: tclk.dealRoom(contract),
    preimageStored: false,
  },
  manifestRoot: sha256(JSON.stringify({ provenance: { tclkPin: PIN, sourceSha: runtimeIdentity.sourceCommit, distTreeSha256: runtimeIdentity.distTreeSha256, productionClosureSha256: runtimeIdentity.prodClosureSha256 }, frames })),
  limitations: [
    'This freezes a future write plan; it does not authorize signing, nonce reservation, submission or observation.',
    'Both DIDs are controlled by one human operator and are not evidence of economic independence.',
    'PaperRail moves no value and proves no settlement.',
  ],
};

await writeFile(new URL('../evidence/phase3b-exact-manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(new URL('../docs/PHASE3B_EXACT_MANIFEST.md', import.meta.url), `# Phase 3B.1 — exact write manifest\n\n` +
  `**FROZEN** against the runtime-attested TCLK pin \`${PIN}\`. This is a fixture-only, unsigned, unposted plan.\n\n` +
  `- Manifest root: \`${manifest.manifestRoot}\`\n- Runtime attestation: \`${runtimeAttestation}\`\n- Source SHA: \`${runtimeIdentity.sourceCommit}\`\n- Dist tree SHA: \`${runtimeIdentity.distTreeSha256}\`\n- Production closure SHA: \`${runtimeIdentity.prodClosureSha256}\`\n- Fixture trajectory: \`${trajectory.join(' → ')}\`\n- Safety: no key access, signature, nonce reservation, transport, network, public action or value movement.\n\n` +
  `The reveal preimage and execution id are deliberately absent. This artifact is not an authorization to execute a public write.\n`);

console.log(JSON.stringify({
  status: 'FROZEN', schema: manifest.schema, manifestRoot: manifest.manifestRoot,
  runtimeAttestation, sourceSha: runtimeIdentity.sourceCommit,
  distTreeSha256: runtimeIdentity.distTreeSha256, productionClosureSha256: runtimeIdentity.prodClosureSha256,
  trajectory,
  signed: false, posted: false, publicActions: 0,
}, null, 2));