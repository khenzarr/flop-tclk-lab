// SPDX-License-Identifier: Apache-2.0
// Prepare the isolated, unsigned and unposted Phase 3B superseding lineage.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeAttestation, runtimeIdentity, tclk, baseline } from './upstream.mjs';

const PIN = 'd48e87343200e3115e243df39e8f295f5ce2e645';
const OLD_ROOT = 'd452f8fcc877f9bb5ba199c20a0d96d3b220075be48d3ffd8aa625bb10ece694';
const OLD_ROOM = 'mb-p-tclk-62b08bcfe4331e3a';
const DID_A = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';
const DID_B = 'did:key:z6MkoetPhd5Aa1pKFCR2a8SinCWaL64U7ytcPP6zg5pnnDoW';
const LINEAGE = 'phase3b-s2';
const NOW = 1800000000000;
const SECRET_PATH = fileURLToPath(new URL('../blackbox/state/phase3b-s2/deal-secret.json', import.meta.url));
const MANIFEST_URL = new URL('../evidence/phase3b-s2-exact-manifest.json', import.meta.url);
const PREVIEW_URL = new URL('../evidence/phase3b-s2-execution-preview.json', import.meta.url);
const SUPERSESSION_URL = new URL('../evidence/phase3b-supersession.json', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const frameHash = frame => sha256(tclk.encodeFrame(frame));
const clone = value => JSON.parse(JSON.stringify(value));
const derivedNonce = (secret, label) => sha256(Buffer.concat([Buffer.from(label), Buffer.from(secret.slice(2), 'hex')])).slice(0, 16);
async function writeFrozen(url, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try { await writeFile(url, text, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || await readFile(url, 'utf8') !== text) throw new Error(`S2_FROZEN_ARTIFACT_CONFLICT:${fileURLToPath(url)}`);
  }
}

async function secret() {
  await mkdir(dirname(SECRET_PATH), { recursive: true });
  try {
    const existing = JSON.parse(await readFile(SECRET_PATH, 'utf8'));
    if (!/^0x[0-9a-f]{64}$/.test(existing.secret)) throw new Error('S2_SECRET_STATE_CONFLICT');
    return existing.secret;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = `0x${randomBytes(32).toString('hex')}`;
    const fd = await open(SECRET_PATH, 'wx', 0o600);
    try { await fd.writeFile(`${JSON.stringify({ schema: 'tclk/phase3b-s2-secret/v1', secret: value })}\n`); await fd.sync(); }
    finally { await fd.close(); }
    try { await chmod(SECRET_PATH, 0o600); } catch {}
    return value;
  }
}

if (runtimeAttestation !== 'PASS' || runtimeIdentity.sourceCommit !== PIN || baseline.runtimeAttestation?.sourceCommit !== PIN) {
  throw new Error('S2_RUNTIME_ATTESTATION_REFUSED');
}

const preimage = await secret();
const offer = tclk.makeOffer({ from: DID_A, role: 'payer', amount: '100', asset: 'FLOP', lock: 'hash', rails: ['paper'],
  claimByMs: NOW + 600000, refundAfterMs: NOW + 3600000, expiresMs: NOW + 7200000,
  nonce: derivedNonce(preimage, 'phase3b-s2-offer') });
const lock = tclk.hashLockFromPreimage(preimage);
const accept = tclk.makeAccept(offer, { from: DID_B, ref: offer.id, statement: lock.hash,
  nonce: derivedNonce(preimage, 'phase3b-s2-accept') });
const contract = accept.contract;
const room = tclk.dealRoom(contract);
if (room === OLD_ROOM) throw new Error('S2_ROOM_REUSE_REFUSED');
const lockFrame = { type: 'lock', from: DID_A, contract, rail: 'paper', ref: 'paper-ref-1' };
const revealFrame = { type: 'reveal', from: DID_B, contract, secret: preimage };

let state = tclk.openContract(offer); const trajectory = [state.status];
for (const frame of [accept, lockFrame, revealFrame]) { const applied = tclk.applyFrame(state, frame, NOW); state = applied.state ?? applied; trajectory.push(state.status); }
if (trajectory.join('|') !== 'proposed|accepted|locked|claimed') throw new Error('S2_TRAJECTORY_REFUSED');

const notes = new tclk.MemoryNoteStore(); const rail = new tclk.PaperRail(notes, () => NOW);
const terms = { contract, lock: 'hash', statement: lock.hash, amount: offer.amount, asset: offer.asset,
  payer: DID_A, payee: DID_B, claimByMs: offer.claimByMs, refundAfterMs: offer.refundAfterMs };
const paperRef = await rail.lock(terms); const lockNote = tclk.paperNote(paperRef);
if (lockNote.ns === 'tclk-paper-62' && lockNote.key === 'b08bcfe4331e3a') throw new Error('S2_PAPERRAIL_KEY_REUSE_REFUSED');
const lockCommitment = sha256(tclk.canonicalJson(await notes.get(lockNote.ns, lockNote.key)));
await rail.claim(paperRef, preimage); const claimNote = tclk.paperNote(paperRef);
const claimCommitment = sha256(tclk.canonicalJson(await notes.get(claimNote.ns, claimNote.key)));
if (JSON.stringify(lockNote) !== JSON.stringify(claimNote) || lockCommitment === claimCommitment) throw new Error('S2_PAPERRAIL_COMMITMENT_REFUSED');

const specs = [
  { write: 1, type: 'offer', frame: offer, room: tclk.OFFER_ROOM, signerRole: 'party A / payer', stateBefore: null, stateAfter: 'proposed' },
  { write: 2, type: 'accept', frame: accept, room: tclk.OFFER_ROOM, signerRole: 'party B / payee', stateBefore: 'proposed', stateAfter: 'accepted' },
  { write: 3, type: 'lock', frame: lockFrame, room, signerRole: 'party A / payer', stateBefore: 'accepted', stateAfter: 'locked' },
  { write: 4, type: 'reveal', frame: revealFrame, room, signerRole: 'party B / payee', stateBefore: 'locked', stateAfter: 'claimed' },
];
const frames = specs.map(({ frame, ...item }) => ({ operationId: `${LINEAGE}-write-${item.write}`, ordinal: item.write === 4 ? 5 : item.write,
  ...item, canonicalFrame: item.type === 'reveal' ? { ...clone(frame), secret: '<LOCAL_SECRET_AT_EXECUTION>' } : clone(frame),
  canonicalFrameHash: frameHash(frame), payloadBytes: Buffer.byteLength(tclk.encodeFrame(frame)), public: true, valueMoved: false }));
const paperRailWrites = [
  { write: 5, operationId: `${LINEAGE}-write-5`, ordinal: 4, operation: 'lock', note: lockNote, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false, valueCommitment: lockCommitment },
  { write: 6, operationId: `${LINEAGE}-write-6`, ordinal: 6, operation: 'claim', note: claimNote, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false, valueCommitment: claimCommitment },
];
const order = [1, 2, 3, 5, 4, 6].map(n => `${LINEAGE}-write-${n}`);
const manifest = {
  schema: 'tclk-blackbox/phase3b-exact-manifest/v1', phase: '3B', lineageId: LINEAGE,
  kind: 'superseding-authoritative-execution-manifest', supersedesManifestRoot: OLD_ROOT,
  supersessionReason: 'WRITE3_PRODUCTION_REJECTION_ROOT_CAUSE_UNAVAILABLE', generatedBy: 'flop-tclk-lab Phase 3B s2 offline preparation',
  frozen: true, signed: false, posted: false,
  provenance: { tclkPin: PIN, repository: baseline.repository, runtimeAttestation, runtimeAlgorithm: runtimeIdentity.algorithm,
    sourceSha: runtimeIdentity.sourceCommit, lockfileSha256: runtimeIdentity.lockfileSha256, distTreeSha256: runtimeIdentity.distTreeSha256,
    productionClosureSha256: runtimeIdentity.prodClosureSha256, runtimeEntrypoint: runtimeIdentity.entrypoint,
    signingCommit: 'e0005e5d6aa3df309743c5469012afa1d0f726f9', enrollmentCommit: '3675aeacdb73656285c4253b6d6d8d937afe25d6', technocoreEvidence: '82d942936050f1ab0fb9f34db17893b89f3e064b' },
  safety: { realCanonicalKeyAccessed: false, realSignaturePerformed: false, realNonceConsumed: false, transportObjects: 0,
    networkCalls: 0, submissionCalls: 0, technocoreReads: 0, technocoreWrites: 0, paperRailWrites: 0, publicActions: 0, posted: false, valueMoved: false, secretsInArtifact: false },
  partyModel: { didA: DID_A, didB: DID_B, roleA: 'offer / payer / lock', roleB: 'accept / payee / reveal', distinctDids: true,
    sameHumanOperator: true, independentHumanCounterparty: false, disclosure: 'ONE HUMAN OPERATOR / TWO DISTINCT CRYPTOGRAPHIC DIDS' },
  envelope: { version: 'tclk/1', wirePrefix: tclk.TCLK_PREFIX, signingDomain: tclk.TCLK_DOMAIN, maxFrameChars: tclk.MAX_FRAME_CHARS },
  execution: { executionId: 'NOT_CREATED', oneShotPerWrite: true, signAndSubmitSeparate: true, automaticRetries: 0,
    noncePolicy: 'GENERATED_AND_RESERVED_INSIDE_TRUSTED_SIGNER_AT_EXECUTION; no nonce allocated during preparation',
    revealSecretPolicy: 'LOCAL_CSPRNG_32_BYTE_HEX_PREIMAGE; COMMITMENT_ONLY_IN_MANIFEST', secretStatePath: 'blackbox/state/phase3b-s2/deal-secret.json',
    pendingSignedRoot: 'blackbox/state/phase3b-s2/pending-signed', submitStateRoot: 'blackbox/state/phase3b-s2/submit',
    paperRailStateRoot: 'blackbox/state/phase3b-s2/paper-rail', attemptBudgetRoot: 'blackbox/state/phase3b-s2/attempt-budget',
    secretCommitmentAlgorithm: 'SHA-256(raw 32-byte preimage)', secretCommitment: lock.hash },
  publicOrder: order, frameSet: { sequence: ['offer', 'accept', 'lock', 'paper-lock', 'reveal', 'paper-claim'], signedRoomWrites: 4, unsignedPaperRailNoteWrites: 2, totalPublicWrites: 6, frames, paperRailWrites },
  fixtureReplay: { fixtureOnly: true, trajectory, finalStatus: state.status, contractId: contract, offerId: offer.id, dealRoom: room, preimageStored: false },
  manifestRoot: '', limitations: ['Preparation only; no signing, nonce allocation, submission, observation or PaperRail write was performed.',
    'Both DIDs are controlled by one human operator and do not prove economic independence.', 'PaperRail moves no value and proves no settlement.'],
};
manifest.manifestRoot = sha256(JSON.stringify({ ...manifest, manifestRoot: undefined }));
if (manifest.manifestRoot === OLD_ROOT) throw new Error('S2_MANIFEST_ROOT_REUSE_REFUSED');

const preview = { schema: 'tclk-blackbox/phase3b-s2-execution-preview/v1', lineageId: LINEAGE, manifestRoot: manifest.manifestRoot,
  runtime: { attestation: runtimeAttestation, sourceSha: runtimeIdentity.sourceCommit, signingCommit: manifest.provenance.signingCommit }, signed: false, posted: false };
const supersession = { schema: 'tclk-blackbox/execution-supersession/v1', classification: 'SUPERSEDED_EXECUTION_LINEAGE',
  reason: 'WRITE3_PRODUCTION_REJECTION_ROOT_CAUSE_UNAVAILABLE', historicalManifestRoot: OLD_ROOT, successorLineage: LINEAGE,
  historicalOutcome: 'NOT_SUCCESSFUL', preservedEvidence: {
    write1: 'blackbox/state/phase3b-submit/phase3b-write-1.json', write2: 'blackbox/state/phase3b-submit/phase3b-write-2-observation.json',
    write3Attempt1: { budgetId: 'ed114cc92c3b23d9ba8e25bf89a3492f4fd67134f265756dff838664794c2003', reconciliation: 'blackbox/state/phase3b-submit/phase3b-write-3-reconciliation.json', classification: 'REJECTED_HTTP403_WRONG_ROOM_SPENT' },
    write3Attempt2: { budgetId: '856f37dd9f1ed54104206a4a714fa1984611d1ade7c64a28e95d0a6cdf7641f9', result: 'blackbox/state/phase3b-submit/phase3b-write-3-submit-attempt-2.json', classification: 'REJECTED_HTTP400_CORRECT_ROOM_SPENT' },
    paperRailWrite5: { reconciliation: 'blackbox/state/phase3b-paper-rail/phase3b-write-5-reconciliation.json', classification: 'FALSE_POSITIVE_OBSERVER_HISTORICAL' } } };
await writeFrozen(MANIFEST_URL, manifest);
await writeFrozen(PREVIEW_URL, preview);
await writeFrozen(SUPERSESSION_URL, supersession);
console.log(JSON.stringify({ status: 'PREPARED', lineageId: LINEAGE, manifestRoot: manifest.manifestRoot, contractId: contract, dealRoom: room,
  dealCommitment: lock.hash, paperRailLockCommitment: lockCommitment, paperRailClaimCommitment: claimCommitment,
  realSignatures: 0, realNoncesAllocated: 0, livePosts: 0, livePaperRailWrites: 0 }));
