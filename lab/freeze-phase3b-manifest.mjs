// SPDX-License-Identifier: Apache-2.0
//
// Phase 3B.1-R2 — recompute the exact, fixture-only write manifest.
//
// This command is intentionally downstream of lab/upstream.mjs.  It cannot produce a manifest
// unless the fail-closed runtime loader has attested and imported the pinned implementation.
// It creates no signer, reserves no nonce, contacts no transport, and never writes a preimage to
// the manifest.  The values below are deterministic test-vector inputs, not execution credentials.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runtimeAttestation, runtimeIdentity, tclk, baseline } from './upstream.mjs';

const ROOT = new URL('../', import.meta.url);
const PIN = 'd48e87343200e3115e243df39e8f295f5ce2e645';
const EXPECTED_PAPER_LOCK_VALUE_COMMITMENT = '93412def8f8fe56258d90e77c40805c416a0fde434637f9366079dd230ce6c9e';
const EXPECTED_PAPER_CLAIM_VALUE_COMMITMENT = 'ee22cd643ecf35841960c77eb747b4cb9c591f80415d848e350a32a16c36479e';
const DID_A = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';
const DID_B = 'did:key:z6MkoetPhd5Aa1pKFCR2a8SinCWaL64U7ytcPP6zg5pnnDoW';
const NOW = 1800000000000;
const SECRET_PATH = fileURLToPath(new URL('../blackbox/state/phase3b-deal-secret/phase3b-deal.json', import.meta.url));

async function createDealSecret() {
  await mkdir(dirname(SECRET_PATH), { recursive: true });
  let secret;
  try {
    const existing = JSON.parse(await readFile(SECRET_PATH, 'utf8'));
    if (!/^0x[0-9a-f]{64}$/.test(existing.secret)) throw new Error('SECRET_STATE_CONFLICT');
    secret = existing.secret;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = `0x${randomBytes(32).toString('hex')}`;
    const fd = await open(SECRET_PATH, 'wx', 0o600);
    try { await fd.writeFile(`${JSON.stringify({ schema: 'tclk/phase3b-deal-secret/v1', contract: 'derived-after-accept', secret })}\n`); await fd.sync(); }
    finally { await fd.close(); }
    try { await chmod(SECRET_PATH, 0o600); } catch {}
  }
  return secret;
}

const PREIMAGE = await createDealSecret();

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

// The four frames are signed room writes.  The pinned PaperRail also performs two
// unsigned KV mutations during the lock/reveal lifecycle.  Exercise that rail with
// the same fixture terms so the frozen public footprint records both mutations rather
// than silently counting only the room frames.
const paperNotes = new tclk.MemoryNoteStore();
const paperRail = new tclk.PaperRail(paperNotes, () => NOW);
const paperTerms = {
  contract,
  lock: 'hash',
  statement: lock.hash,
  amount: offer.amount,
  asset: offer.asset,
  payer: DID_A,
  payee: DID_B,
  claimByMs: offer.claimByMs,
  refundAfterMs: offer.refundAfterMs,
};
const paperRef = await paperRail.lock(paperTerms);
const paperLockNote = tclk.paperNote(paperRef);
const paperLockValueCommitment = sha256(tclk.canonicalJson(await paperNotes.get(paperLockNote.ns, paperLockNote.key)));
await paperRail.claim(paperRef, PREIMAGE);
const paperClaimNote = tclk.paperNote(paperRef);
const paperClaimValueCommitment = sha256(tclk.canonicalJson(await paperNotes.get(paperClaimNote.ns, paperClaimNote.key)));
if (JSON.stringify(paperLockNote) !== JSON.stringify(paperClaimNote)) {
  throw new Error('phase3b manifest: PaperRail lock and claim did not target one note');
}
if (paperLockValueCommitment !== EXPECTED_PAPER_LOCK_VALUE_COMMITMENT
  || paperClaimValueCommitment !== EXPECTED_PAPER_CLAIM_VALUE_COMMITMENT
  || paperLockValueCommitment === paperClaimValueCommitment) {
  throw new Error('phase3b manifest: PaperRail lock/claim commitments are not distinct frozen values');
}

const frameSpecs = [
  { write: 1, frame: offer, type: 'offer', room: tclk.OFFER_ROOM, signerRole: 'party A / payer', stateBefore: null, stateAfter: 'proposed' },
  { write: 2, frame: accept, type: 'accept', room: tclk.OFFER_ROOM, signerRole: 'party B / payee', stateBefore: 'proposed', stateAfter: 'accepted' },
  { write: 3, frame: lockFrame, type: 'lock', room: tclk.dealRoom(contract), signerRole: 'party A / payer', stateBefore: 'accepted', stateAfter: 'locked' },
  { write: 4, frame: revealFrame, type: 'reveal', room: tclk.dealRoom(contract), signerRole: 'party B / payee', stateBefore: 'locked', stateAfter: 'claimed' },
];

const frames = frameSpecs.map(({ frame, ...spec }) => ({
  operationId: `phase3b-write-${spec.write}`,
  ordinal: spec.write === 5 ? 4 : spec.write === 4 ? 5 : spec.write,
  ...spec,
  canonicalFrame: spec.type === 'reveal' ? { ...clone(frame), secret: '<LOCAL_SECRET_AT_EXECUTION>' } : clone(frame),
  canonicalFrameHash: frameHash(frame),
  payloadBytes: Buffer.byteLength(tclk.encodeFrame(frame), 'utf8'),
  public: true,
  valueMoved: false,
}));

const trajectory = [before, afterAccept, afterLock, state.status];
if (trajectory.join(' -> ') !== 'proposed -> accepted -> locked -> claimed') {
  throw new Error(`phase3b manifest: unexpected fixture trajectory ${trajectory.join(' -> ')}`);
}

const paperRailWrites = [
  { write: 5, operationId: 'phase3b-write-5', ordinal: 4, operation: 'lock', note: paperLockNote, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false, valueCommitment: paperLockValueCommitment },
  { write: 6, operationId: 'phase3b-write-6', ordinal: 6, operation: 'claim', note: paperClaimNote, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false, valueCommitment: paperClaimValueCommitment },
];

const manifest = {
  schema: 'tclk-blackbox/phase3b-exact-manifest/v1',
  phase: '3B',
  kind: 'superseding-authoritative-execution-manifest',
  supersedesManifestRoot: '9887263d84fb29a6fd99de286793a5e31ad84c6cd3c354ea62cd6582829632e7',
  manifestTransitionReason: 'EXECUTION_BINDING_CORRECTION_BEFORE_REMAINING_ACTIONS',
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
    signingCommit: 'e0005e5d6aa3df309743c5469012afa1d0f726f9',
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
    revealSecretPolicy: 'LOCAL_CSPRNG_32_BYTE_HEX_PREIMAGE; COMMITMENT_ONLY_IN_MANIFEST',
    secretStatePath: 'blackbox/state/phase3b-deal-secret/phase3b-deal.json',
    secretCommitmentAlgorithm: 'SHA-256(raw 32-byte preimage)',
    secretCommitment: lock.hash,
  },
  frameSet: {
    sequence: ['offer', 'accept', 'lock', 'paper-lock', 'reveal', 'paper-claim'],
    signedRoomWrites: 4,
    unsignedPaperRailNoteWrites: 2,
    totalPublicWrites: 6,
    terminalFrame: 'reveal',
    frames,
    paperRailWrites,
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
  manifestRoot: '',
  limitations: [
    'This freezes a future write plan; it does not authorize signing, nonce reservation, submission or observation.',
    'Both DIDs are controlled by one human operator and are not evidence of economic independence.',
    'PaperRail moves no value and proves no settlement.',
  ],
};

manifest.manifestRoot = sha256(JSON.stringify({ ...manifest, manifestRoot: undefined }));

await writeFile(new URL('../evidence/phase3b-exact-manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(new URL('../docs/PHASE3B_EXACT_MANIFEST.md', import.meta.url), `# Phase 3B.1 — exact write manifest\n\n` +
  `**FROZEN** against the runtime-attested TCLK pin \`${PIN}\`. This is a fixture-only, unsigned, unposted plan.\n\n` +
  `- Manifest root: \`${manifest.manifestRoot}\`\n- Runtime attestation: \`${runtimeAttestation}\`\n- Source SHA: \`${runtimeIdentity.sourceCommit}\`\n- Lockfile SHA: \`${runtimeIdentity.lockfileSha256}\`\n- Dist tree SHA: \`${runtimeIdentity.distTreeSha256}\`\n- Production closure SHA: \`${runtimeIdentity.productionClosureSha256}\`\n- Canonical signing commit: \`e0005e5d6aa3df309743c5469012afa1d0f726f9\`\n- Canonical enrollment commit: \`3675aeacdb73656285c4253b6d6d8d937afe25d6\`\n- Technocore evidence: \`82d942936050f1ab0fb9f34db17893b89f3e064b\`\n- Public footprint: 4 signed TCLK room writes + 2 unsigned PaperRail KV note writes = 6\n- PaperRail trust: every note mutation is SIGNED=false, WORLD_WRITABLE=true, AUTHORSHIP_PROOF=NONE, EVIDENCE_CLASS=UNSIGNED_RAIL_OBSERVATION\n- Fixture trajectory: \`${trajectory.join(' → ')}\`\n- Safety: no key access, signature, nonce reservation, transport, network, public action or value movement.\n\n` +
  `The reveal preimage and execution id are deliberately absent. This artifact is not an authorization to execute a public write.\n`);

console.log(JSON.stringify({
  status: 'FROZEN', schema: manifest.schema, manifestRoot: manifest.manifestRoot,
  runtimeAttestation, sourceSha: runtimeIdentity.sourceCommit,
  distTreeSha256: runtimeIdentity.distTreeSha256, productionClosureSha256: runtimeIdentity.prodClosureSha256,
  trajectory,
  signed: false, posted: false, publicActions: 0,
}, null, 2));
