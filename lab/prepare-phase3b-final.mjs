// SPDX-License-Identifier: Apache-2.0
// Offline-only final Phase 3B manifest preparation for the Railway venue.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import s2 from '../evidence/phase3b-s2-exact-manifest.json' with { type: 'json' };
import { runtimeAttestation, runtimeIdentity, tclk, baseline } from './upstream.mjs';

const LINEAGE = 'phase3b-final';
const VENUE = 'https://technocore-chat-production.up.railway.app';
const PIN = 'd48e87343200e3115e243df39e8f295f5ce2e645';
const DID_A = 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi';
const DID_B = 'did:key:z6MkoetPhd5Aa1pKFCR2a8SinCWaL64U7ytcPP6zg5pnnDoW';
const NOW = 1800000000000;
const SECRET_PATH = fileURLToPath(new URL('../blackbox/state/phase3b-final/deal-secret.json', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const frameHash = frame => sha256(tclk.encodeFrame(frame));
const derivedNonce = (secret, label) => sha256(Buffer.concat([Buffer.from(label), Buffer.from(secret.slice(2), 'hex')])).slice(0, 16);
async function writeFrozen(url, value) { const text = `${JSON.stringify(value, null, 2)}\n`;
  try { await writeFile(url, text, { flag: 'wx' }); } catch (error) {
    if (error.code !== 'EEXIST' || await readFile(url, 'utf8') !== text) throw new Error(`FINAL_FROZEN_ARTIFACT_CONFLICT:${fileURLToPath(url)}`);
  } }
async function secret() { await mkdir(dirname(SECRET_PATH), { recursive: true });
  try { const value = JSON.parse(await readFile(SECRET_PATH, 'utf8')); if (!/^0x[0-9a-f]{64}$/.test(value.secret)) throw new Error('FINAL_SECRET_STATE_CONFLICT'); return value.secret; }
  catch (error) { if (error.code !== 'ENOENT') throw error; const value = `0x${randomBytes(32).toString('hex')}`; const fd = await open(SECRET_PATH, 'wx', 0o600);
    try { await fd.writeFile(`${JSON.stringify({ schema: 'tclk/phase3b-final-secret/v1', secret: value })}\n`); await fd.sync(); } finally { await fd.close(); }
    try { await chmod(SECRET_PATH, 0o600); } catch {} return value; } }

if (runtimeAttestation !== 'PASS' || runtimeIdentity.sourceCommit !== PIN || baseline.runtimeAttestation?.sourceCommit !== PIN) throw new Error('FINAL_RUNTIME_ATTESTATION_REFUSED');
const preimage = await secret();
const offer = tclk.makeOffer({ from: DID_A, role: 'payer', amount: '100', asset: 'FLOP', lock: 'hash', rails: ['paper'], claimByMs: NOW + 600000,
  refundAfterMs: NOW + 3600000, expiresMs: NOW + 7200000, nonce: derivedNonce(preimage, 'phase3b-final-offer') });
const lock = tclk.hashLockFromPreimage(preimage);
const accept = tclk.makeAccept(offer, { from: DID_B, ref: offer.id, statement: lock.hash, nonce: derivedNonce(preimage, 'phase3b-final-accept') });
const contract = accept.contract; const room = tclk.dealRoom(contract);
if (room === s2.fixtureReplay.dealRoom) throw new Error('FINAL_ROOM_REUSE_REFUSED');
const lockFrame = { type: 'lock', from: DID_A, contract, rail: 'paper', ref: 'paper-ref-1' };
const revealFrame = { type: 'reveal', from: DID_B, contract, secret: preimage };
let state = tclk.openContract(offer); const trajectory = [state.status];
for (const frame of [accept, lockFrame, revealFrame]) { const applied = tclk.applyFrame(state, frame, NOW); state = applied.state ?? applied; trajectory.push(state.status); }
if (trajectory.join('|') !== 'proposed|accepted|locked|claimed') throw new Error('FINAL_TRAJECTORY_REFUSED');
const notes = new tclk.MemoryNoteStore(); const rail = new tclk.PaperRail(notes, () => NOW);
const paperRef = await rail.lock({ contract, lock: 'hash', statement: lock.hash, amount: offer.amount, asset: offer.asset, payer: DID_A, payee: DID_B,
  claimByMs: offer.claimByMs, refundAfterMs: offer.refundAfterMs });
const lockNote = tclk.paperNote(paperRef); const lockCommitment = sha256(tclk.canonicalJson(await notes.get(lockNote.ns, lockNote.key)));
await rail.claim(paperRef, preimage); const claimNote = tclk.paperNote(paperRef); const claimCommitment = sha256(tclk.canonicalJson(await notes.get(claimNote.ns, claimNote.key)));
if (JSON.stringify(lockNote) !== JSON.stringify(claimNote) || lockCommitment === claimCommitment || JSON.stringify(lockNote) === JSON.stringify(s2.frameSet.paperRailWrites[0].note)) throw new Error('FINAL_PAPERRAIL_BINDING_REFUSED');
const specs = [
  { write: 1, type: 'offer', frame: offer, room: tclk.OFFER_ROOM, signerRole: 'party A / payer', stateBefore: null, stateAfter: 'proposed' },
  { write: 2, type: 'accept', frame: accept, room: tclk.OFFER_ROOM, signerRole: 'party B / payee', stateBefore: 'proposed', stateAfter: 'accepted' },
  { write: 3, type: 'lock', frame: lockFrame, room, signerRole: 'party A / payer', stateBefore: 'accepted', stateAfter: 'locked' },
  { write: 4, type: 'reveal', frame: revealFrame, room, signerRole: 'party B / payee', stateBefore: 'locked', stateAfter: 'claimed' },
];
const frames = specs.map(({ frame, ...item }) => ({ operationId: `${LINEAGE}-write-${item.write}`, ordinal: item.write === 4 ? 5 : item.write, ...item,
  canonicalFrame: item.type === 'reveal' ? { ...JSON.parse(JSON.stringify(frame)), secret: '<LOCAL_SECRET_AT_EXECUTION>' } : JSON.parse(JSON.stringify(frame)),
  canonicalFrameHash: frameHash(frame), payloadBytes: Buffer.byteLength(tclk.encodeFrame(frame)), public: true, valueMoved: false }));
const paperRailWrites = [
  { write: 5, operationId: `${LINEAGE}-write-5`, ordinal: 4, operation: 'lock', note: lockNote, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false, valueCommitment: lockCommitment },
  { write: 6, operationId: `${LINEAGE}-write-6`, ordinal: 6, operation: 'claim', note: claimNote, signed: false, worldWritable: true, authorshipProof: 'NONE', evidenceClass: 'UNSIGNED_RAIL_OBSERVATION', valueMoved: false, valueCommitment: claimCommitment },
];
const order = [1, 2, 3, 5, 4, 6].map(value => `${LINEAGE}-write-${value}`);
const manifest = { schema: 'tclk-blackbox/phase3b-exact-manifest/v1', phase: '3B', lineageId: LINEAGE, kind: 'final-authoritative-execution-manifest',
  venueOrigin: VENUE, supersedesManifestRoot: s2.manifestRoot, supersessionReason: 'OFFICIAL_VENUE_NEW_ROOM_CAPACITY_EXHAUSTED',
  historicalLineages: [{ lineageId: 'phase3b', manifestRoot: s2.supersedesManifestRoot }, { lineageId: 'phase3b-s2', manifestRoot: s2.manifestRoot }],
  generatedBy: 'flop-tclk-lab Phase 3B final offline preparation', frozen: true, signed: false, posted: false,
  provenance: { tclkPin: PIN, repository: baseline.repository, runtimeAttestation, runtimeAlgorithm: runtimeIdentity.algorithm, sourceSha: runtimeIdentity.sourceCommit,
    lockfileSha256: runtimeIdentity.lockfileSha256, distTreeSha256: runtimeIdentity.distTreeSha256, productionClosureSha256: runtimeIdentity.prodClosureSha256,
    runtimeEntrypoint: runtimeIdentity.entrypoint, signingCommit: s2.provenance.signingCommit, enrollmentCommit: s2.provenance.enrollmentCommit, technocoreEvidence: s2.provenance.technocoreEvidence },
  safety: { realCanonicalKeyAccessed: false, realSignaturePerformed: false, realNonceConsumed: false, transportObjects: 0, networkCalls: 0, submissionCalls: 0,
    technocoreReads: 0, technocoreWrites: 0, paperRailWrites: 0, publicActions: 0, posted: false, valueMoved: false, secretsInArtifact: false },
  partyModel: { didA: DID_A, didB: DID_B, roleA: 'offer / payer / lock', roleB: 'accept / payee / reveal', distinctDids: true, sameHumanOperator: true,
    independentHumanCounterparty: false, disclosure: 'ONE HUMAN OPERATOR / TWO DISTINCT CRYPTOGRAPHIC DIDS' },
  envelope: s2.envelope, execution: { executionId: 'NOT_CREATED', oneShotPerWrite: true, signAndSubmitSeparate: true, automaticRetries: 0,
    noncePolicy: 'GENERATED_AND_RESERVED_INSIDE_TRUSTED_SIGNER_AT_EXECUTION; no nonce allocated during preparation', revealSecretPolicy: 'LOCAL_CSPRNG_32_BYTE_HEX_PREIMAGE; COMMITMENT_ONLY_IN_MANIFEST',
    secretStatePath: 'blackbox/state/phase3b-final/deal-secret.json', pendingSignedRoot: 'blackbox/state/phase3b-final/pending-signed', submitStateRoot: 'blackbox/state/phase3b-final/submit',
    paperRailStateRoot: 'blackbox/state/phase3b-final/paper-rail', attemptBudgetRoot: 'blackbox/state/phase3b-final/attempt-budget', secretCommitmentAlgorithm: 'SHA-256(raw 32-byte preimage)', secretCommitment: lock.hash },
  publicOrder: order, frameSet: { sequence: ['offer', 'accept', 'lock', 'paper-lock', 'reveal', 'paper-claim'], signedRoomWrites: 4, unsignedPaperRailNoteWrites: 2, totalPublicWrites: 6, frames, paperRailWrites },
  fixtureReplay: { fixtureOnly: true, trajectory, finalStatus: state.status, contractId: contract, offerId: offer.id, dealRoom: room, preimageStored: false }, manifestRoot: '',
  limitations: ['Preparation only; no signing, nonce allocation, submission, observation or PaperRail write was performed.', 'Both DIDs are controlled by one human operator and do not prove economic independence.', 'PaperRail moves no value and proves no settlement.'] };
manifest.manifestRoot = sha256(JSON.stringify({ ...manifest, manifestRoot: undefined }));
if (manifest.manifestRoot === s2.manifestRoot) throw new Error('FINAL_MANIFEST_ROOT_REUSE_REFUSED');
await writeFrozen(new URL('../evidence/phase3b-final-exact-manifest.json', import.meta.url), manifest);
await writeFrozen(new URL('../evidence/phase3b-final-execution-preview.json', import.meta.url), { schema: 'tclk-blackbox/phase3b-final-execution-preview/v1', lineageId: LINEAGE,
  venueOrigin: VENUE, manifestRoot: manifest.manifestRoot, runtime: { attestation: runtimeAttestation, sourceSha: runtimeIdentity.sourceCommit, signingCommit: manifest.provenance.signingCommit }, signed: false, posted: false });
console.log(JSON.stringify({ status: 'PREPARED', lineageId: LINEAGE, manifestRoot: manifest.manifestRoot, contractId: contract, dealRoom: room,
  dealCommitment: lock.hash, paperRailNamespace: lockNote.ns, paperRailKey: lockNote.key, lockCommitment, claimCommitment, realSignatures: 0, realNonces: 0, livePosts: 0, livePaperRailWrites: 0 }));
